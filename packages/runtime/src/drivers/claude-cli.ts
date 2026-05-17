import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { DriverEventEnvelope, RuntimeDriver, RuntimeDriverRunHandle, RuntimeDriverRunInput, StartSessionInput } from "../types.js";
import { parseClaudeSdkMessage } from "./claude-sdk.js";
import { enrichInitWithCapabilities, foldThinkingLevelForClaude } from "./thinking.js";

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
  // SHA-1 of any input is always 20 bytes, so the slice(0,16) above is always
  // 16 bytes — bytes[6] and bytes[8] are guaranteed present. The non-null
  // assertions silence noUncheckedIndexedAccess without introducing a runtime
  // check that could never fire.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

type SpawnFn = typeof nodeSpawn;

export interface ClaudeCliDriverOptions {
  spawn?: SpawnFn;
  executable?: string;
  /** @deprecated Use `defaultSecurityMode`. Legacy values still honored. */
  defaultPermissionMode?: StartSessionInput["permissionMode"];
  defaultSecurityMode?: StartSessionInput["securityMode"];
}

export function buildClaudeCliCommand(input: {
  sessionId: string;
  prompt: string;
  cwd: string;
  model?: string;
  name?: string;
  appendSystemPrompt?: string;
  /**
   * The literal `--permission-mode` value forwarded to the claude CLI. The
   * driver resolves this from {@link RuntimeDriverRunInput.securityMode}
   * (yolo → bypassPermissions, safe → default) before calling.
   */
  permissionMode?: StartSessionInput["permissionMode"];
  tools?: string[];
  additionalDirectories?: string[];
  resumeSessionId?: string;
  /** Native claude CLI vocabulary; runtime driver folds before calling. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}): string[] {
  // --verbose is REQUIRED by claude when combining --print with
  // --output-format=stream-json; without it the CLI exits 1 with
  //   "Error: When using --print, --output-format=stream-json requires --verbose"
  // and the driver never sees any stream-json events. This is the
  // claude-2.1.x contract; older builds didn't require it.
  const args = ["-p", "--verbose", "--output-format", "stream-json"];

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
  if (input.effort) {
    args.push("--effort", input.effort);
  }

  // Terminate variadic flags (--allowedTools, --add-dir) before the
  // positional prompt. Without `--`, claude consumes the prompt as another
  // tool or directory and exits with:
  //   "Error: Input must be provided either through stdin or as a prompt
  //    argument when using --print"
  // — even though the prompt was passed. The CLI surface uses Commander.js
  // variadic args (`<tools...>`, `<directories...>`); `--` is the POSIX
  // end-of-options marker and Commander honours it.
  args.push("--", input.prompt);
  return args;
}

const RING_BUFFER_MAX = 50;
const STDERR_MAX_BYTES = 8 * 1024;

export class ClaudeCliDriver implements RuntimeDriver {
  readonly name = "claude-cli" as const;

  private readonly spawnFn: SpawnFn;
  private readonly executable: string;
  private readonly defaultSecurityMode: NonNullable<StartSessionInput["securityMode"]>;

  constructor(options: ClaudeCliDriverOptions = {}) {
    this.spawnFn = options.spawn ?? nodeSpawn;
    this.executable = options.executable ?? process.env.CLAUDE_CLI_EXECUTABLE ?? "claude";
    // Resolve legacy defaultPermissionMode if no securityMode given.
    if (options.defaultSecurityMode) {
      this.defaultSecurityMode = options.defaultSecurityMode;
    } else if (options.defaultPermissionMode === "bypassPermissions") {
      this.defaultSecurityMode = "yolo";
    } else if (options.defaultPermissionMode) {
      this.defaultSecurityMode = "safe";
    } else {
      // Historical default: bypassPermissions (yolo). The non-interactive
      // stdin (`stdio: ["ignore", ...]`) cannot answer permission prompts,
      // so "safe" hangs on any tool that needs approval. Callers can opt
      // into the hang explicitly via securityMode: "safe".
      this.defaultSecurityMode = "yolo";
    }
  }

  run(input: RuntimeDriverRunInput, onEventRaw: (event: DriverEventEnvelope) => Promise<void> | void): RuntimeDriverRunHandle {
    // Echo effective thinking on the upstream init event so audit consumers
    // can detect silent drops/folds without a probe. claude CLI flag is
    // `--effort <level>` with native vocab matching the runtime vocabulary.
    const effort = input.thinkingLevel
      ? foldThinkingLevelForClaude(input.thinkingLevel)
      : undefined;
    const onEvent = enrichInitWithCapabilities(onEventRaw, {
      thinkingLevelSupported: true,
      requestedThinkingLevel: input.thinkingLevel,
      effectiveThinkingLevel: effort,
    });
    const securityMode = input.securityMode ?? this.defaultSecurityMode;
    const permissionMode = securityMode === "yolo" ? "bypassPermissions" : "default";
    const args = buildClaudeCliCommand({
      sessionId: input.sessionId,
      prompt: input.prompt,
      cwd: input.cwd,
      model: input.model,
      name: input.name,
      appendSystemPrompt: input.appendSystemPrompt,
      permissionMode,
      tools: input.tools,
      additionalDirectories: input.additionalDirectories,
      resumeSessionId: input.resumeSessionId,
      effort,
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
