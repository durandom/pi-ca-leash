import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { DriverEventEnvelope, RuntimeDriver, RuntimeDriverRunHandle, RuntimeDriverRunInput, StartSessionInput } from "../types.js";
import { parseClaudeSdkMessage } from "./claude-sdk.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Fixed namespace for deterministic UUIDv5 derivation of session ids handed to
// the claude CLI. Changing this value invalidates all warm-resume caches.
const CLAUDE_CLI_SESSION_NAMESPACE = "6f2e8d1c-5b3a-4e7f-9c8d-1a2b3c4d5e6f";

export function coerceClaudeCliSessionId(rawId: string): string {
  if (UUID_RE.test(rawId)) return rawId;
  return uuidV5(CLAUDE_CLI_SESSION_NAMESPACE, rawId);
}

function uuidV5(namespace: string, name: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(nsBytes).update(name, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

type SpawnFn = typeof nodeSpawn;

export interface ClaudeCliDriverOptions {
  spawn?: SpawnFn;
  executable?: string;
  defaultPermissionMode?: StartSessionInput["permissionMode"];
}

export function buildClaudeCliCommand(input: {
  sessionId: string;
  prompt: string;
  cwd: string;
  model?: string;
  name?: string;
  appendSystemPrompt?: string;
  permissionMode?: StartSessionInput["permissionMode"];
  tools?: string[];
  additionalDirectories?: string[];
  resumeSessionId?: string;
}): string[] {
  const args = ["-p", "--output-format", "stream-json"];

  if (input.resumeSessionId) {
    args.push("--resume", coerceClaudeCliSessionId(input.resumeSessionId));
  } else {
    args.push("--session-id", coerceClaudeCliSessionId(input.sessionId));
    if (input.name) {
      args.push("--name", input.name);
    }
  }
  if (input.permissionMode) {
    args.push("--permission-mode", input.permissionMode);
  }
  if (input.model) {
    args.push("--model", input.model);
  }
  if (input.appendSystemPrompt) {
    args.push("--append-system-prompt", input.appendSystemPrompt);
  }
  if (input.tools?.length) {
    args.push("--allowedTools", ...input.tools);
  }
  if (input.additionalDirectories?.length) {
    args.push("--add-dir", ...input.additionalDirectories);
  }

  args.push(input.prompt);
  return args;
}

const RING_BUFFER_MAX = 50;
const STDERR_MAX_BYTES = 8 * 1024;

export class ClaudeCliDriver implements RuntimeDriver {
  readonly name = "claude-cli" as const;

  private readonly spawnFn: SpawnFn;
  private readonly executable: string;
  private readonly defaultPermissionMode?: StartSessionInput["permissionMode"];

  constructor(options: ClaudeCliDriverOptions = {}) {
    this.spawnFn = options.spawn ?? nodeSpawn;
    this.executable = options.executable ?? process.env.CLAUDE_CLI_EXECUTABLE ?? "claude";
    this.defaultPermissionMode = options.defaultPermissionMode;
  }

  run(input: RuntimeDriverRunInput, onEvent: (event: DriverEventEnvelope) => Promise<void> | void): RuntimeDriverRunHandle {
    const args = buildClaudeCliCommand({
      sessionId: input.sessionId,
      prompt: input.prompt,
      cwd: input.cwd,
      model: input.model,
      name: input.name,
      appendSystemPrompt: input.appendSystemPrompt,
      permissionMode: input.permissionMode ?? this.defaultPermissionMode,
      tools: input.tools,
      additionalDirectories: input.additionalDirectories,
      resumeSessionId: input.resumeSessionId,
    });

    const env: NodeJS.ProcessEnv = { ...process.env, ...(input.env ?? {}) };
    let aborted = false;
    const child: ChildProcess = this.spawnFn(this.executable, args, {
      cwd: input.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const ringBuffer: string[] = [];
    let stderrTail = "";
    let stdoutBuffer = "";
    let structuredErrorEmitted = false;
    let messageEmitted = false;
    let spawnError: Error | undefined;
    let deliveryChain: Promise<void> = Promise.resolve();

    function deliver(envelope: DriverEventEnvelope): void {
      deliveryChain = deliveryChain.then(async () => {
        try {
          await onEvent(envelope);
        } catch {
          // Keep driver delivery alive even if a subscriber throws.
        }
      });
    }

    function processLine(line: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        if (ringBuffer.length >= RING_BUFFER_MAX) ringBuffer.shift();
        ringBuffer.push(line);
        return;
      }

      for (const message of parseClaudeSdkMessage(parsed)) {
        if (message.type === "error") {
          structuredErrorEmitted = true;
        }
        messageEmitted = true;
        deliver({ type: "message", payload: message });
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

    child.on("error", (error) => {
      spawnError = error;
    });

    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("close", (code, signal) => {
        const remainder = stdoutBuffer.trim();
        if (remainder) processLine(remainder);

        if (spawnError) {
          deliver({
            type: "error",
            payload: { message: enrichClaudeCliSpawnErrorMessage(spawnError.message), code: "SPAWN_ERROR" },
          });
        } else if (!aborted && code !== 0 && !structuredErrorEmitted) {
          const base = stderrTail.trim() || `claude exited with code ${code}`;
          const ringCtx = ringBuffer.length > 0 ? ` | malformed stdout: ${ringBuffer.slice(-5).join(" | ")}` : "";
          deliver({ type: "error", payload: { message: base + ringCtx } });
        } else if (
          !aborted &&
          code === 0 &&
          !structuredErrorEmitted &&
          !messageEmitted &&
          ringBuffer.length === 0 &&
          stderrTail.trim().length > 0
        ) {
          deliver({
            type: "error",
            payload: {
              message: `claude-cli exited 0 with no JSON output. stderr: ${stderrTail.trim().slice(0, 500)}`,
              code: "CLAUDE_CLI_NO_OUTPUT",
            },
          });
        }

        void deliveryChain.then(() => {
          resolve({ code, signal: signal as NodeJS.Signals | null });
        });
      });
    });

    return {
      kill(signal: NodeJS.Signals = "SIGINT") {
        aborted = true;
        child.kill(signal);
      },
      done,
    };
  }
}

function enrichClaudeCliSpawnErrorMessage(message: string): string {
  const lower = message.toLowerCase();
  if (!lower.includes("enoent") && !lower.includes("not found")) {
    return message;
  }
  return `${message}\nHint: claude executable could not be spawned. Check PATH or set CLAUDE_CLI_EXECUTABLE, or configure drivers.claude-cli.executable in pi-ca-leash config.`;
}
