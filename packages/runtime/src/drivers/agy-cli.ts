import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  AssistantDriverMessage,
  NormalizedDriverMessage,
  ResultDriverMessage,
  SystemDriverMessage,
} from "./messages.js";
import type {
  DriverEventEnvelope,
  RuntimeDriver,
  RuntimeDriverRunHandle,
  RuntimeDriverRunInput,
} from "../types.js";
import { enrichInitWithCapabilities } from "./thinking.js";

type SpawnFn = typeof nodeSpawn;

export interface AgyCliDriverOptions {
  spawn?: SpawnFn;
  executable?: string;
}

export function buildAgyCliCommand(input: {
  prompt: string;
  cwd: string;
  model?: string;
  appendSystemPrompt?: string;
  resumeSessionId?: string;
  securityMode?: RuntimeDriverRunInput["securityMode"];
  logFile?: string;
  additionalDirectories?: string[];
}): string[] {
  const args: string[] = ["-p"];

  // securityMode mapping:
  //  - "safe" (default) → --sandbox: runs commands in a sandbox.
  //  - "yolo"           → --dangerously-skip-permissions: skips prompts.
  if (input.securityMode === "yolo") {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--sandbox");
  }

  if (input.logFile) {
    args.push("--log-file", input.logFile);
  }

  if (input.model) {
    args.push("--model", input.model);
  }

  if (input.resumeSessionId) {
    args.push("--conversation", input.resumeSessionId);
  }

  if (input.additionalDirectories?.length) {
    for (const dir of input.additionalDirectories) {
      args.push("--add-dir", dir);
    }
  }

  // The agy CLI reads the prompt from standard input when running in print mode.
  return args;
}

function extractConversationId(logPath: string): string | null {
  if (!logPath || !existsSync(logPath)) return null;
  try {
    const content = readFileSync(logPath, "utf8");
    const match = content.match(/conversation=([a-zA-Z0-9-]+)/i) || content.match(/Created conversation ([a-zA-Z0-9-]+)/i);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

const STDERR_MAX_BYTES = 8 * 1024;

export class AgyCliDriver implements RuntimeDriver {
  readonly name = "agy" as const;

  private readonly spawnFn: SpawnFn;
  private readonly executable: string;

  constructor(options: AgyCliDriverOptions = {}) {
    this.spawnFn = options.spawn ?? nodeSpawn;
    this.executable =
      options.executable ?? (process.env.AGY_CLI_EXECUTABLE ?? "agy");
  }

  run(
    input: RuntimeDriverRunInput,
    onEventRaw: (event: DriverEventEnvelope) => Promise<void> | void,
  ): RuntimeDriverRunHandle {
    // Echo capability support on init event.
    const onEvent = enrichInitWithCapabilities(onEventRaw, {
      thinkingLevelSupported: false,
    });

    const baseDir = input.sessionStorageDir ?? join(tmpdir(), "pi-ca-leash-driver-agy", input.sessionId);
    const logFile = join(baseDir, "agy-cli.log");

    const args = buildAgyCliCommand({
      prompt: input.prompt,
      cwd: input.cwd,
      model: input.model,
      appendSystemPrompt: input.appendSystemPrompt,
      resumeSessionId: input.resumeSessionId,
      securityMode: input.securityMode,
      logFile,
      additionalDirectories: input.additionalDirectories,
    });

    const env: NodeJS.ProcessEnv = { ...process.env, ...(input.env ?? {}) };
    let aborted = false;

    const child: ChildProcess = this.spawnFn(this.executable, args, {
      cwd: input.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderrTail = "";
    let stdoutAccumulated = "";
    let systemInitEmitted = false;
    let spawnError: Error | undefined;

    let deliveryChain: Promise<void> = Promise.resolve();

    function deliver(envelope: DriverEventEnvelope): void {
      deliveryChain = deliveryChain.then(async () => {
        try {
          await onEvent(envelope);
        } catch {
          // swallow handler errors
        }
      });
    }

    // Try to extract conversation ID and emit system init event
    const emitSystemInitIfNeeded = (final = false) => {
      if (systemInitEmitted) return;

      let resolvedSessionId = input.resumeSessionId;
      if (!resolvedSessionId) {
        resolvedSessionId = extractConversationId(logFile) ?? undefined;
      }

      if (resolvedSessionId || final) {
        systemInitEmitted = true;
        deliver({
          type: "message",
          payload: {
            type: "system",
            subtype: "init",
            sessionId: resolvedSessionId ?? input.sessionId,
            cwd: input.cwd,
            model: input.model,
            raw: {
              sessionId: resolvedSessionId,
              logFile,
            },
          } satisfies SystemDriverMessage,
        });
      }
    };

    // If it's a resume run, we can emit init immediately
    if (input.resumeSessionId) {
      emitSystemInitIfNeeded();
    }

    // Feed prompt to standard input of print mode
    const effectivePrompt = input.appendSystemPrompt
      ? `<system>\n${input.appendSystemPrompt}\n</system>\n\n${input.prompt}`
      : input.prompt;

    child.stdin?.write(effectivePrompt);
    child.stdin?.end();

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdoutAccumulated += text;

      // Try to discover the conversation ID from the log file
      emitSystemInitIfNeeded();

      deliver({
        type: "message",
        payload: {
          type: "assistant",
          blocks: [{ type: "text", text }],
        } satisfies AssistantDriverMessage,
      });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail += chunk.toString("utf8");
      if (stderrTail.length > STDERR_MAX_BYTES) {
        stderrTail = stderrTail.slice(-STDERR_MAX_BYTES);
      }
    });

    child.on("error", (err) => {
      spawnError = err;
    });

    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.on("close", (code, signal) => {
          // Ensure system init event is emitted even if we couldn't parse the session ID
          emitSystemInitIfNeeded(true);

          if (spawnError) {
            deliver({
              type: "error",
              payload: { message: enrichAgySpawnErrorMessage(spawnError.message), code: "SPAWN_ERROR" },
            });
          } else if (!aborted && code !== 0) {
            const base = stderrTail.trim() || `agy exited with code ${code}`;
            deliver({ type: "error", payload: { message: base } });
          } else {
            deliver({
              type: "message",
              payload: {
                type: "result",
                ok: true,
                summary: stdoutAccumulated.trim().slice(-100) || "Success",
              } satisfies ResultDriverMessage,
            });
          }

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

function enrichAgySpawnErrorMessage(message: string): string {
  const lower = message.toLowerCase();
  if (!lower.includes("enoent") && !lower.includes("not found")) {
    return message;
  }
  return `${message}\nHint: agy executable could not be spawned. Check PATH or set AGY_CLI_EXECUTABLE to the agy CLI binary.`;
}
