import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  ClaudeCodeRuntime,
  type RuntimeEvent,
  type RuntimeSessionState,
  type RuntimeStatus,
} from "@pi-claude-code-agent/runtime";
import {
  appendRunEvent,
  defaultRunsDir,
  ensureRunLayout,
  listRunStates,
  readRunEvents,
  readRunResult,
  readRunState,
  writeRunResult,
  writeRunState,
} from "./persistence.js";
import type {
  RunResult,
  StartRunInput,
  SubagentBackend,
  SubagentRunRecord,
  RuntimeSubagentBackendOptions,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

export class ClaudeCodeSubagentBackend implements SubagentBackend {
  readonly runner = "claude-code-agent" as const;

  private readonly runtime: ClaudeCodeRuntime;
  private readonly storageDir: string;
  private readonly pollIntervalMs: number;
  private readonly completionTimeoutMs: number;
  private readonly sessionToRunId = new Map<string, string>();

  constructor(options: RuntimeSubagentBackendOptions = {}) {
    this.runtime = options.runtime ?? new ClaudeCodeRuntime();
    this.storageDir = resolve(options.storageDir ?? defaultRunsDir());
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.completionTimeoutMs = options.completionTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runtime.subscribe((event) => {
      const runId = this.sessionToRunId.get(event.sessionId);
      if (runId) {
        void appendRunEvent(this.storageDir, runId, event);
      }
    });
  }

  async startRun(input: StartRunInput): Promise<SubagentRunRecord> {
    if ((input.agent.runner ?? this.runner) !== this.runner) {
      throw new Error(`Unsupported runner ${input.agent.runner}`);
    }
    if (input.context === "fork") {
      throw new Error("runner=claude-code-agent does not support real fork; use fresh");
    }

    const runId = randomUUID();
    const cwd = resolve(input.cwd ?? input.agent.cwd ?? process.cwd());
    const now = new Date().toISOString();
    const queued: SubagentRunRecord = {
      runId,
      runner: this.runner,
      agentName: input.agent.name,
      cwd,
      model: input.model ?? input.agent.model,
      state: input.async ? "queued" : "starting",
      context: input.context ?? "fresh",
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      task: input.task,
    };

    await ensureRunLayout(this.storageDir, runId);
    await writeRunState(this.storageDir, queued);

    const session = await this.runtime.start({
      prompt: buildTaskPrompt(input.agent.prompt, input.task),
      cwd,
      model: input.model ?? input.agent.model,
      name: input.agent.name,
    });

    this.sessionToRunId.set(session.sessionId, runId);
    await writeRunState(this.storageDir, {
      ...queued,
      sessionId: session.sessionId,
      model: session.model ?? queued.model,
      state: mapRunState(session.state),
      updatedAt: new Date().toISOString(),
      lastActivityAt: session.lastActivityAt,
      raw: {
        runtimeState: session.state,
        driverSessionId: session.driverSessionId,
      },
    });

    const running = await this.syncRun(runId, session, input.async ? undefined : this.completionTimeoutMs);
    if (input.async) {
      void this.waitForCompletion(runId, session.sessionId);
    }
    return running;
  }

  async statusRun(runId: string): Promise<SubagentRunRecord | undefined> {
    const record = await readRunState(this.storageDir, runId);
    if (!record?.sessionId) {
      return record;
    }
    const status = await this.runtime.status(record.sessionId);
    return this.syncRun(runId, status ?? undefined);
  }

  async listRuns(): Promise<SubagentRunRecord[]> {
    const runs = await listRunStates(this.storageDir);
    return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async eventsRun(runId: string, cursor = 0) {
    return readRunEvents(this.storageDir, runId, cursor);
  }

  async interruptRun(runId: string): Promise<SubagentRunRecord> {
    const record = await this.requireRun(runId);
    if (!record.sessionId) {
      throw new Error(`Run ${runId} has no runtime session`);
    }
    await this.runtime.interrupt(record.sessionId);
    const status = await this.waitForTerminalState(record.sessionId, this.completionTimeoutMs);
    return this.syncRun(runId, status);
  }

  async stopRun(runId: string): Promise<SubagentRunRecord> {
    const record = await this.requireRun(runId);
    if (!record.sessionId) {
      throw new Error(`Run ${runId} has no runtime session`);
    }
    const status = await this.runtime.stop(record.sessionId);
    return this.syncRun(runId, status);
  }

  async collectResult(runId: string): Promise<RunResult | undefined> {
    const persisted = await readRunResult(this.storageDir, runId);
    if (persisted) {
      return persisted;
    }
    const record = await this.requireRun(runId);
    if (!record.sessionId) {
      return undefined;
    }
    return this.persistResult(runId, record.sessionId);
  }

  private async waitForCompletion(runId: string, sessionId: string): Promise<void> {
    const status = await this.waitForTerminalState(sessionId, this.completionTimeoutMs);
    await this.syncRun(runId, status);
  }

  private async waitForTerminalState(sessionId: string, timeoutMs: number): Promise<RuntimeStatus> {
    const started = Date.now();
    for (;;) {
      const status = await this.runtime.status(sessionId);
      if (!status) {
        throw new Error(`Unknown runtime session ${sessionId}`);
      }
      if (["idle", "interrupted", "failed", "stopped"].includes(status.state)) {
        return status;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for run ${sessionId}`);
      }
      await delay(this.pollIntervalMs);
    }
  }

  private async syncRun(runId: string, status?: RuntimeStatus, waitTimeoutMs?: number): Promise<SubagentRunRecord> {
    const current = await this.requireRun(runId);
    const effectiveStatus = status ?? (current.sessionId ? await this.runtime.status(current.sessionId) : undefined);
    let finalStatus = effectiveStatus;
    if (waitTimeoutMs && current.sessionId && effectiveStatus && ["starting", "running"].includes(effectiveStatus.state)) {
      finalStatus = await this.waitForTerminalState(current.sessionId, waitTimeoutMs);
    }

    const next: SubagentRunRecord = {
      ...current,
      sessionId: finalStatus?.sessionId ?? current.sessionId,
      model: finalStatus?.model ?? current.model,
      state: mapRunState(finalStatus?.state ?? current.state),
      updatedAt: new Date().toISOString(),
      lastActivityAt: finalStatus?.lastActivityAt ?? new Date().toISOString(),
      raw: {
        ...(current.raw ?? {}),
        runtimeState: finalStatus?.state,
        driverSessionId: finalStatus?.driverSessionId,
      },
    };

    if (finalStatus?.sessionId) {
      this.sessionToRunId.set(finalStatus.sessionId, runId);
    }

    if (finalStatus?.sessionId && isTerminal(finalStatus.state)) {
      next.result = await this.persistResult(runId, finalStatus.sessionId);
      if (finalStatus.state === "idle") {
        next.state = "completed";
      }
    }

    await writeRunState(this.storageDir, next);
    return next;
  }

  private async persistResult(runId: string, sessionId: string): Promise<RunResult> {
    const events = await this.runtime.events(sessionId);
    const runtimeStatus = await this.runtime.status(sessionId);
    const summary = extractSummary(events.items);
    const result: RunResult = {
      summary,
      events: events.items,
      runtimeState: runtimeStatus?.state ?? "failed",
    };
    await writeRunResult(this.storageDir, runId, result);
    return result;
  }

  private async requireRun(runId: string): Promise<SubagentRunRecord> {
    const record = await readRunState(this.storageDir, runId);
    if (!record) {
      throw new Error(`Unknown run ${runId}`);
    }
    return record;
  }
}

function buildTaskPrompt(agentPrompt: string | undefined, task: string): string {
  return agentPrompt ? `${agentPrompt}\n\nTask:\n${task}` : task;
}

function mapRunState(state: RuntimeSessionState | string): SubagentRunRecord["state"] {
  switch (state) {
    case "queued":
      return "queued";
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "idle":
      return "idle";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
    default:
      return "failed";
  }
}

function isTerminal(state: RuntimeSessionState): boolean {
  return ["idle", "interrupted", "failed", "stopped"].includes(state);
}

function extractSummary(events: RuntimeEvent[]): string {
  const lastAssistant = [...events]
    .reverse()
    .find((event): event is Extract<RuntimeEvent, { type: "message" }> => event.type === "message" && event.role === "assistant");
  const text = lastAssistant?.message.blocks
    .map((block) => block.text)
    .filter((value): value is string => Boolean(value && value.trim()))
    .join("\n\n");
  if (text && text.trim()) {
    return text.trim();
  }
  const result = [...events]
    .reverse()
    .find((event): event is Extract<RuntimeEvent, { type: "result" }> => event.type === "result");
  return result?.summary ?? "";
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export { buildTaskPrompt, extractSummary, mapRunState };
