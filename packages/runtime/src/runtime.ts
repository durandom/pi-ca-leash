import { EventEmitter, on } from "node:events";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  appendEvent,
  defaultStorageDir,
  ensureSessionLayout,
  listStates,
  readEvents,
  readState,
  readTranscript,
  tailTranscript,
  writeState,
} from "./persistence.js";
import { ClaudeSdkDriver, parseClaudeSdkMessage } from "./drivers/claude-sdk.js";
import { ClaudeCliDriver } from "./drivers/claude-cli.js";
import { CodexCliDriver } from "./drivers/codex-cli.js";
import { loadPiCaLeashConfigSync } from "./config.js";
import type { NormalizedDriverMessageBlock } from "./drivers/messages.js";
import type {
  DriverEventEnvelope,
  ErrorEvent,
  InterruptResult,
  MessageEvent,
  ResultEvent,
  RuntimeDriver,
  RuntimeDriverName,
  RuntimeDriverResolver,
  RuntimeEvent,
  RuntimeMessageBlock,
  RuntimeOptions,
  RuntimeSessionId,
  RuntimeStatus,
  SendMessageInput,
  SessionCreatedEvent,
  SessionIdleEvent,
  SessionStoppedEvent,
  SessionUpdatedEvent,
  StartSessionInput,
  ToolEvent,
  TranscriptChunk,
} from "./types.js";

interface ActiveRun {
  runId: string;
  handle: ReturnType<RuntimeDriver["run"]>;
  requestedModel?: string;
}

export class ClaudeCodeRuntime {
  private readonly storageDir: string;
  private readonly drivers = new Map<RuntimeDriverName, RuntimeDriver>();
  private readonly defaultDriverName: RuntimeDriverName;
  private readonly resolveDriverByName: RuntimeDriverResolver;
  private readonly emitter = new EventEmitter();
  private readonly activeRuns = new Map<RuntimeSessionId, ActiveRun>();
  private readonly sequences = new Map<RuntimeSessionId, number>();

  constructor(options: RuntimeOptions = {}) {
    this.storageDir = resolve(options.storageDir ?? defaultStorageDir());

    const config = options.config ?? loadPiCaLeashConfigSync().config;
    const defaultClaudeDriver = new ClaudeSdkDriver();
    const defaultClaudeCliDriver = new ClaudeCliDriver({
      executable: config.drivers?.["claude-cli"]?.executable,
      defaultPermissionMode: config.drivers?.["claude-cli"]?.permissionMode,
    });
    const defaultCodexDriver = new CodexCliDriver({
      executable: config.drivers?.["codex-cli"]?.executable,
    });
    this.drivers.set(defaultClaudeDriver.name, defaultClaudeDriver);
    this.drivers.set(defaultClaudeCliDriver.name, defaultClaudeCliDriver);
    this.drivers.set(defaultCodexDriver.name, defaultCodexDriver);
    if (options.drivers) {
      for (const driver of Object.values(options.drivers)) {
        if (driver) {
          this.drivers.set(driver.name, driver);
        }
      }
    }
    if (options.driver) {
      this.drivers.set(options.driver.name, options.driver);
    }

    this.defaultDriverName = options.defaultDriver ?? options.driver?.name ?? config.defaultDriver ?? "claude-sdk";
    this.resolveDriverByName = options.resolveDriver ?? ((name) => {
      const driver = this.drivers.get(name);
      if (!driver) {
        throw new Error(`No runtime driver registered for ${name}`);
      }
      return driver;
    });
  }

  async start(input: StartSessionInput): Promise<RuntimeStatus> {
    const sessionId = randomUUID();
    const driverName = input.driver ?? this.defaultDriverName;
    const driver = this.resolveDriver(driverName);
    const cwd = resolve(input.cwd ?? process.cwd());
    const now = new Date().toISOString();
    const status: RuntimeStatus = {
      sessionId,
      driver: driver.name,
      driverSessionId: sessionId,
      state: "starting",
      cwd,
      model: input.model,
      name: input.name,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      raw: {},
    };

    await ensureSessionLayout(this.storageDir, sessionId);
    await writeState(this.storageDir, status);
    await this.emitEvent({ type: "session.created", sessionId, state: "starting" }, status);
    await this.runSession(status, {
      prompt: input.prompt,
      appendSystemPrompt: input.appendSystemPrompt,
      model: input.model,
      name: input.name,
      permissionMode: input.permissionMode,
      tools: input.tools,
      additionalDirectories: input.additionalDirectories,
      env: input.env,
    });
    return (await this.status(sessionId))!;
  }

  async send(input: SendMessageInput): Promise<RuntimeStatus> {
    const status = await this.requireSession(input.sessionId);
    if (status.state === "stopped") {
      throw new Error(`Session ${input.sessionId} stopped`);
    }
    if (this.activeRuns.has(input.sessionId)) {
      throw new Error(`Session ${input.sessionId} already active`);
    }

    await this.runSession(status, {
      prompt: input.message,
      appendSystemPrompt: input.appendSystemPrompt,
      model: input.model ?? status.model,
      name: status.name,
      env: input.env,
      resumeSessionId: status.driverSessionId,
    });
    return (await this.status(input.sessionId))!;
  }

  async status(sessionId: RuntimeSessionId): Promise<RuntimeStatus | undefined> {
    return readState(this.storageDir, sessionId);
  }

  async list(): Promise<RuntimeStatus[]> {
    const states = await listStates(this.storageDir);
    return states.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async interrupt(sessionId: RuntimeSessionId): Promise<InterruptResult> {
    const status = await this.requireSession(sessionId);
    if (status.state === "stopped") {
      return { sessionId, interrupted: false, reason: "already-stopped" };
    }

    const active = this.activeRuns.get(sessionId);
    if (!active) {
      return { sessionId, interrupted: false, reason: "no-active-run" };
    }

    active.handle.kill("SIGINT");
    const next = await this.patchStatus(sessionId, {
      state: "interrupted",
      interruptedAt: new Date().toISOString(),
    });
    await this.emitEvent({ type: "session.updated", sessionId, state: next.state, patch: { interrupted: true } }, next);
    return { sessionId, interrupted: true, signal: "SIGINT", reason: "signalled" };
  }

  async stop(sessionId: RuntimeSessionId): Promise<RuntimeStatus> {
    await this.requireSession(sessionId);
    const active = this.activeRuns.get(sessionId);
    if (active) {
      active.handle.kill("SIGINT");
    }
    const next = await this.patchStatus(sessionId, {
      state: "stopped",
      stopRequested: true,
      stoppedAt: new Date().toISOString(),
      activeRunId: undefined,
    });
    await this.emitEvent({ type: "session.stopped", sessionId, state: "stopped" }, next);
    return next;
  }

  async tail(sessionId: RuntimeSessionId, limit = 20): Promise<RuntimeEvent[]> {
    return tailTranscript(this.storageDir, sessionId, limit);
  }

  async readTranscript(sessionId: RuntimeSessionId, cursor = 0): Promise<TranscriptChunk> {
    return readTranscript(this.storageDir, sessionId, cursor);
  }

  async events(sessionId: RuntimeSessionId, cursor = 0): Promise<TranscriptChunk> {
    return readEvents(this.storageDir, sessionId, cursor);
  }

  subscribe(listener: (event: RuntimeEvent) => void, sessionId?: RuntimeSessionId): () => void {
    const wrapped = (event: RuntimeEvent) => {
      if (!sessionId || event.sessionId === sessionId) {
        listener(event);
      }
    };
    this.emitter.on("event", wrapped);
    return () => this.emitter.off("event", wrapped);
  }

  async *stream(sessionId?: RuntimeSessionId): AsyncIterable<RuntimeEvent> {
    for await (const [event] of on(this.emitter, "event") as AsyncIterable<[RuntimeEvent]>) {
      if (!sessionId || event.sessionId === sessionId) {
        yield event;
      }
    }
  }

  private async runSession(
    status: RuntimeStatus,
    input: {
      prompt: string;
      appendSystemPrompt?: string;
      model?: string;
      name?: string;
      permissionMode?: StartSessionInput["permissionMode"];
      tools?: string[];
      additionalDirectories?: string[];
      env?: Record<string, string>;
      resumeSessionId?: string;
    },
  ): Promise<void> {
    const runId = randomUUID();
    const next = await this.patchStatus(status.sessionId, {
      state: input.resumeSessionId ? "running" : "starting",
      activeRunId: runId,
      stopRequested: false,
      model: input.model ?? status.model,
      name: input.name ?? status.name,
    });
    await this.emitEvent(
      { type: "session.updated", sessionId: status.sessionId, state: next.state, patch: { activeRunId: runId } },
      next,
    );

    const driver = this.resolveDriver(status.driver);
    const handle = driver.run(
      {
        sessionId: status.sessionId,
        prompt: input.prompt,
        cwd: next.cwd,
        model: input.model,
        name: input.name,
        appendSystemPrompt: input.appendSystemPrompt,
        permissionMode: input.permissionMode,
        tools: input.tools,
        additionalDirectories: input.additionalDirectories,
        env: input.env,
        resumeSessionId: input.resumeSessionId,
      },
      async (event) => {
        await this.handleDriverEvent(status.sessionId, event);
      },
    );

    this.activeRuns.set(status.sessionId, { runId, handle, requestedModel: input.model });
    void this.waitForRunCompletion(status.sessionId, runId, handle);
  }

  private async waitForRunCompletion(
    sessionId: RuntimeSessionId,
    runId: string,
    handle: ReturnType<RuntimeDriver["run"]>,
  ): Promise<void> {
    const { code, signal } = await handle.done;
    const current = await this.requireSession(sessionId);
    const stillActive = current.activeRunId === runId;
    if (stillActive) {
      this.activeRuns.delete(sessionId);
    }

    if (!stillActive) {
      return;
    }

    if (current.stopRequested || current.state === "stopped") {
      const stopped = await this.patchStatus(sessionId, {
        state: "stopped",
        stoppedAt: current.stoppedAt ?? new Date().toISOString(),
        activeRunId: undefined,
      });
      await this.emitEvent({ type: "session.stopped", sessionId, state: "stopped" }, stopped);
      return;
    }

    if (signal === "SIGINT" || current.state === "interrupted") {
      const interrupted = await this.patchStatus(sessionId, {
        state: "interrupted",
        interruptedAt: current.interruptedAt ?? new Date().toISOString(),
        activeRunId: undefined,
      });
      await this.emitEvent({ type: "session.idle", sessionId, state: "interrupted" }, interrupted);
      return;
    }

    if (code && code !== 0) {
      const failed = await this.patchStatus(sessionId, {
        state: "failed",
        activeRunId: undefined,
        lastError: current.lastError ?? { message: `Driver exited with code ${code}` },
      });
      await this.emitEvent({ type: "session.stopped", sessionId, state: "failed" }, failed);
      return;
    }

    const idle = await this.patchStatus(sessionId, {
      state: "idle",
      completedAt: new Date().toISOString(),
      activeRunId: undefined,
    });
    await this.emitEvent({ type: "session.idle", sessionId, state: "idle" }, idle);
  }

  private async handleDriverEvent(sessionId: RuntimeSessionId, envelope: DriverEventEnvelope): Promise<void> {
    if (envelope.type === "raw") {
      for (const message of parseClaudeSdkMessage(envelope.payload)) {
        await this.handleDriverEvent(sessionId, { type: "message", payload: message });
      }
      return;
    }

    if (envelope.type === "error") {
      await this.emitError(sessionId, envelope.payload.message, envelope.payload.code, envelope.payload.raw ?? envelope.payload);
      return;
    }

    const current = await this.requireSession(sessionId);
    const message = envelope.payload;

    switch (message.type) {
      case "system": {
        if (message.subtype !== "init") {
          return;
        }
        const active = this.activeRuns.get(sessionId);
        const updated = await this.patchStatus(sessionId, {
          driverSessionId: message.sessionId ?? current.driverSessionId,
          model: active?.requestedModel ?? message.model ?? current.model,
          raw: {
            ...(current.raw ?? {}),
            init: message.raw ?? message,
          },
        });
        await this.emitEvent(
          {
            type: "session.updated",
            sessionId,
            state: updated.state,
            patch: {
              driverSessionId: updated.driverSessionId,
              model: updated.model,
            },
            raw: message.raw ?? message,
          },
          updated,
        );
        return;
      }

      case "assistant": {
        const updated = await this.patchStatus(sessionId, {});
        await this.emitEvent(
          {
            type: "message",
            sessionId,
            role: "assistant",
            message: { role: "assistant", blocks: toRuntimeBlocks(message.blocks), raw: message.raw ?? message },
          },
          updated,
        );
        return;
      }

      case "tool_use": {
        const updated = await this.patchStatus(sessionId, {});
        await this.emitEvent(
          {
            type: "tool",
            sessionId,
            phase: "requested",
            toolName: message.toolName,
            toolUseId: message.toolUseId,
            input: message.input,
            raw: message.raw ?? message,
          },
          updated,
        );
        return;
      }

      case "tool_result": {
        const updated = await this.patchStatus(sessionId, {});
        if (message.blocks?.length) {
          const role = message.role ?? "user";
          await this.emitEvent(
            {
              type: "message",
              sessionId,
              role,
              message: { role, blocks: toRuntimeBlocks(message.blocks), raw: message.raw ?? message },
            },
            updated,
          );
        }
        await this.emitEvent(
          {
            type: "tool",
            sessionId,
            phase: "completed",
            toolName: message.toolName,
            toolUseId: message.toolUseId,
            output: message.output,
            isError: message.isError,
            raw: message.raw ?? message,
          },
          updated,
        );
        return;
      }

      case "result": {
        const updated = await this.patchStatus(sessionId, {});
        await this.emitEvent(
          {
            type: "result",
            sessionId,
            ok: message.ok,
            summary: message.summary,
            stopReason: message.stopReason,
            usage: message.usage,
            raw: message.raw ?? message,
          },
          updated,
        );
        return;
      }

      case "error": {
        await this.emitError(sessionId, message.message, message.code, message.raw ?? message);
        return;
      }

      case "stream_event":
        return;

      default:
        return;
    }
  }

  private async emitError(sessionId: RuntimeSessionId, message: string | undefined, code?: string, raw?: unknown): Promise<void> {
    const current = await this.patchStatus(sessionId, {
      lastError: {
        message: message ?? "Unknown driver error",
        code,
      },
    });
    await this.emitEvent(
      {
        type: "error",
        sessionId,
        message: message ?? "Unknown driver error",
        code,
        raw,
      },
      current,
    );
  }

  private resolveDriver(name: RuntimeDriverName): RuntimeDriver {
    return this.resolveDriverByName(name);
  }

  private async patchStatus(
    sessionId: RuntimeSessionId,
    patch: Partial<RuntimeStatus>,
  ): Promise<RuntimeStatus> {
    const current = await this.requireSession(sessionId);
    const next: RuntimeStatus = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    await writeState(this.storageDir, next);
    return next;
  }

  private async requireSession(sessionId: RuntimeSessionId): Promise<RuntimeStatus> {
    const status = await readState(this.storageDir, sessionId);
    if (!status) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return status;
  }

  private async emitEvent(
    partial:
      | Omit<SessionCreatedEvent, "id" | "sequence" | "timestamp">
      | Omit<SessionUpdatedEvent, "id" | "sequence" | "timestamp">
      | Omit<SessionIdleEvent, "id" | "sequence" | "timestamp">
      | Omit<SessionStoppedEvent, "id" | "sequence" | "timestamp">
      | Omit<MessageEvent, "id" | "sequence" | "timestamp">
      | Omit<ToolEvent, "id" | "sequence" | "timestamp">
      | Omit<ResultEvent, "id" | "sequence" | "timestamp">
      | Omit<ErrorEvent, "id" | "sequence" | "timestamp">,
    status: RuntimeStatus,
  ): Promise<RuntimeEvent> {
    const sequence = (await this.nextSequence(status.sessionId)) + 1;
    this.sequences.set(status.sessionId, sequence);
    const event: RuntimeEvent = {
      id: randomUUID(),
      sequence,
      timestamp: new Date().toISOString(),
      ...partial,
    } as RuntimeEvent;
    await appendEvent(this.storageDir, event);
    this.emitter.emit("event", event);
    return event;
  }

  private async nextSequence(sessionId: RuntimeSessionId): Promise<number> {
    const cached = this.sequences.get(sessionId);
    if (typeof cached === "number") {
      return cached;
    }
    const existing = await readEvents(this.storageDir, sessionId, 0);
    const max = existing.items.at(-1)?.sequence ?? 0;
    this.sequences.set(sessionId, max);
    return max;
  }
}

function toRuntimeBlocks(blocks: NormalizedDriverMessageBlock[]): RuntimeMessageBlock[] {
  return blocks.map((block) => ({
    type: block.type,
    text: block.text,
    name: block.name,
    id: block.id,
    input: block.input,
    content: block.content,
    isError: block.isError,
    raw: block.raw,
  }));
}
