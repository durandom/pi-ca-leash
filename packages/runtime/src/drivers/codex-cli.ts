import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type {
  AssistantDriverMessage,
  NormalizedDriverMessage,
  NormalizedDriverUsage,
  ResultDriverMessage,
  SystemDriverMessage,
  ToolResultDriverMessage,
  ToolUseDriverMessage,
} from "./messages.js";
import type {
  DriverEventEnvelope,
  RuntimeDriver,
  RuntimeDriverRunHandle,
  RuntimeDriverRunInput,
} from "../types.js";

type SpawnFn = typeof nodeSpawn;

export interface CodexCliDriverOptions {
  spawn?: SpawnFn;
  executable?: string;
}

export function buildCodexCliCommand(input: {
  prompt: string;
  cwd: string;
  model?: string;
  appendSystemPrompt?: string;
  resumeSessionId?: string;
}): string[] {
  const effectivePrompt = input.appendSystemPrompt
    ? `<system>\n${input.appendSystemPrompt}\n</system>\n\n${input.prompt}`
    : input.prompt;

  const args: string[] = ["exec"];
  if (input.resumeSessionId) {
    args.push("resume", "--json", "--full-auto");
    if (input.model) {
      args.push("-m", input.model);
    }
    args.push(input.resumeSessionId, effectivePrompt);
    return args;
  }

  args.push("--json", "--full-auto", "-C", input.cwd);
  if (input.model) {
    args.push("-m", input.model);
  }
  args.push(effectivePrompt);
  return args;
}

function toUsage(usage: unknown): NormalizedDriverUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  return {
    inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : undefined,
    outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : undefined,
    cacheCreationInputTokens:
      typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : undefined,
    cacheReadInputTokens:
      typeof u.cache_read_input_tokens === "number"
        ? u.cache_read_input_tokens
        : typeof u.cached_input_tokens === "number"
          ? u.cached_input_tokens
          : undefined,
    reasoningOutputTokens:
      typeof u.reasoning_output_tokens === "number" ? u.reasoning_output_tokens : undefined,
    raw: usage,
  };
}

export function parseCodexCliEvent(event: unknown): NormalizedDriverMessage | null {
  if (!event || typeof event !== "object") return null;
  const e = event as Record<string, unknown>;
  const type = String(e.type ?? "");

  if (type === "thread.started") {
    const sessionId =
      typeof e.thread_id === "string"
        ? e.thread_id
        : typeof e.session_id === "string"
          ? e.session_id
          : undefined;
    return {
      type: "system",
      subtype: "init",
      sessionId,
      model: typeof e.model === "string" ? e.model : typeof e.model_id === "string" ? e.model_id : undefined,
      raw: event,
    } satisfies SystemDriverMessage;
  }

  if (type === "item.started") {
    const item = e.item as Record<string, unknown> | undefined;
    if (item?.type === "command_execution") {
      return {
        type: "tool_use",
        toolName: "command_execution",
        toolUseId: typeof item.id === "string" ? item.id : undefined,
        input: { command: item.command, cwd: item.cwd },
        raw: event,
      } satisfies ToolUseDriverMessage;
    }
    return null;
  }

  if (type === "item.completed") {
    const item = e.item as Record<string, unknown> | undefined;
    if (item?.type === "command_execution") {
      const exitCode = typeof item.exit_code === "number" ? item.exit_code : 0;
      return {
        type: "tool_result",
        toolName: "command_execution",
        toolUseId: typeof item.id === "string" ? item.id : undefined,
        output: { stdout: item.stdout, exit_code: exitCode },
        isError: exitCode !== 0,
        raw: event,
      } satisfies ToolResultDriverMessage;
    }
    if (item?.type === "agent_message" || item?.type === "assistant_message") {
      const text = typeof item.text === "string" ? item.text : "";
      return {
        type: "assistant",
        blocks: [{ type: "text", text, raw: item }],
        raw: event,
      } satisfies AssistantDriverMessage;
    }
    return null;
  }

  if (type === "turn.completed") {
    const summary = typeof e.summary === "string" ? e.summary : "";
    return {
      type: "result",
      ok: true,
      summary,
      usage: toUsage(e.usage),
      raw: event,
    } satisfies ResultDriverMessage;
  }

  // error and *.failed events are handled by the driver as error envelopes
  return null;
}

function isErrorEvent(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const type = String((event as Record<string, unknown>).type ?? "");
  return type === "error" || type.endsWith(".failed");
}

function extractError(event: unknown): { message: string; code?: string } {
  const e = event as Record<string, unknown>;
  return {
    message: typeof e.message === "string" ? e.message : JSON.stringify(event),
    code: typeof e.code === "string" ? e.code : undefined,
  };
}

const RING_BUFFER_MAX = 50;
const STDERR_MAX_BYTES = 8 * 1024;

export class CodexCliDriver implements RuntimeDriver {
  readonly name = "codex-cli" as const;

  private readonly spawnFn: SpawnFn;
  private readonly executable: string;

  constructor(options: CodexCliDriverOptions = {}) {
    this.spawnFn = options.spawn ?? nodeSpawn;
    this.executable =
      options.executable ?? (process.env.CODEX_CLI_EXECUTABLE ?? "codex");
  }

  run(
    input: RuntimeDriverRunInput,
    onEvent: (event: DriverEventEnvelope) => Promise<void> | void,
  ): RuntimeDriverRunHandle {
    // Hard-reject unsupported options before spawning
    if (input.tools && input.tools.length > 0) {
      throw new RangeError("codex-cli driver does not support allowedTools");
    }
    if (input.additionalDirectories && input.additionalDirectories.length > 0) {
      throw new RangeError("codex-cli driver does not support additionalDirectories");
    }
    if (input.permissionMode === "plan" || input.permissionMode === "dontAsk") {
      throw new RangeError(
        `codex-cli driver does not support permissionMode=${input.permissionMode}`,
      );
    }
    // permissionMode acceptEdits/auto/bypassPermissions/default are accepted but not
    // mapped to sandbox flags — --full-auto is always passed in this slice

    const args = buildCodexCliCommand({
      prompt: input.prompt,
      cwd: input.cwd,
      model: input.model,
      appendSystemPrompt: input.appendSystemPrompt,
      resumeSessionId: input.resumeSessionId,
    });

    const env: NodeJS.ProcessEnv = { ...process.env, ...(input.env ?? {}) };
    let aborted = false;

    const child: ChildProcess = this.spawnFn(this.executable, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const ringBuffer: string[] = [];
    let stderrTail = "";
    let structuredErrorEmitted = false;
    let stdoutBuffer = "";
    let spawnError: Error | undefined;

    // Serial delivery chain — events are fired immediately as lines arrive (live/
    // streaming) but each onEvent call waits for the previous one to complete so
    // ordering is guaranteed. The close handler extends this chain with any final
    // error envelope and then resolves done, ensuring done only settles after every
    // pending onEvent delivery has finished.
    let deliveryChain: Promise<void> = Promise.resolve();

    function deliver(envelope: DriverEventEnvelope): void {
      deliveryChain = deliveryChain.then(async () => {
        try {
          await onEvent(envelope);
        } catch {
          // swallow handler errors to keep the chain alive
        }
      });
    }

    function processLine(line: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Malformed line: keep in ring buffer for crash diagnostics
        if (ringBuffer.length >= RING_BUFFER_MAX) ringBuffer.shift();
        ringBuffer.push(line);
        return;
      }

      if (isErrorEvent(parsed)) {
        structuredErrorEmitted = true;
        const err = extractError(parsed);
        deliver({ type: "error", payload: { message: err.message, code: err.code, raw: parsed } });
        return;
      }

      const normalized = parseCodexCliEvent(parsed);
      if (normalized) {
        deliver({ type: "message", payload: normalized });
      }
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const raw of lines) {
        const trimmed = raw.trim();
        if (trimmed) processLine(trimmed);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail += chunk.toString("utf8");
      if (stderrTail.length > STDERR_MAX_BYTES) {
        stderrTail = stderrTail.slice(-STDERR_MAX_BYTES);
      }
    });

    // Capture spawn failures (e.g. ENOENT — executable not found).
    // The close event always follows, so resolution happens there.
    child.on("error", (err) => {
      spawnError = err;
    });

    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on("close", (code, signal) => {
          // Flush any partial JSONL line left in the buffer
          const remainder = stdoutBuffer.trim();
          if (remainder) processLine(remainder);

          if (spawnError) {
            // Spawn failure overrides all other error paths
            deliver({
              type: "error",
              payload: { message: spawnError.message, code: "SPAWN_ERROR" },
            });
          } else if (!aborted && code !== 0 && !structuredErrorEmitted) {
            // Surface stderr + any malformed stdout context from ring buffer
            const base = stderrTail.trim() || `codex exited with code ${code}`;
            const ringCtx =
              ringBuffer.length > 0
                ? ` | malformed stdout: ${ringBuffer.slice(-5).join(" | ")}`
                : "";
            deliver({ type: "error", payload: { message: base + ringCtx } });
          }

          // Extend the delivery chain with the resolve call so done only
          // settles after every pending onEvent delivery has completed.
          void deliveryChain.then(() => {
            resolve({ code, signal: signal as NodeJS.Signals | null });
          });
        });
      },
    );

    return {
      kill(sig: NodeJS.Signals = "SIGINT") {
        aborted = true;
        child.kill(sig);
      },
      done,
    };
  }
}
