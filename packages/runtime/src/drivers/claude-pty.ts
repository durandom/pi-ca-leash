import { spawn as nodeSpawn } from "node:child_process";
import {
  mkdirSync,
  readSync,
  openSync,
  closeSync,
  fstatSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { coerceClaudeCliSessionId } from "./claude-cli.js";
import { enrichInitWithCapabilities, foldThinkingLevelForClaude } from "./thinking.js";
import type { NormalizedDriverMessage } from "./messages.js";
import type {
  DriverEventEnvelope,
  RuntimeDriver,
  RuntimeDriverRunHandle,
  RuntimeDriverRunInput,
} from "../types.js";

/**
 * `claude-pty` driver — drives the REAL Claude Code interactive TUI.
 *
 * Unlike `claude-cli` / `claude-sdk` (which spawn a fresh one-shot process per
 * turn and fake continuity via `--resume`), this driver keeps ONE long-lived
 * interactive `claude` process alive per session, inside a PTY, and types each
 * turn's prompt into it. Context stays hot in the live process — no per-turn
 * cold start, no transcript reload.
 *
 * The hard problems of driving a TUI (no structured stdout, fragile
 * turn-completion detection) are NOT solved by scraping the rendered screen.
 * They are also NOT solved by the session transcript JSONL: the interactive
 * TUI keeps its transcript in memory and never flushes the file the way the
 * headless `-p` path does (verified against claude 2.1.x — the path the Stop
 * hook reports never materialises, even after `/quit`).
 *
 * Instead we observe the session entirely through Claude Code HOOKS. We inject
 * a per-invocation `--settings` file (so the user's `~/.claude/settings.json`
 * and other running sessions are untouched) registering command hooks that
 * append their JSON payload — one line each — to a per-session `hooks.jsonl`:
 *
 *  - `PostToolUse` payloads carry `tool_name` / `tool_input` / `tool_response`
 *    → emitted as normalized tool_use + tool_result messages.
 *  - `Stop` payloads carry `last_assistant_message` AND mark the deterministic
 *    end of a turn → emitted as an assistant message, then the turn resolves.
 *
 * The PTY's only jobs: keep the TUI alive, type input (bracketed paste),
 * answer the first-run trust dialog, send ESC to cancel a turn, and send
 * `/quit` to tear the session down.
 */

// ── injectable PTY surface (node-pty-compatible shape; minimal for testing) ──

export interface PtyProcessLike {
  readonly pid: number;
  write(data: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  kill(signal?: string): void;
}

export type PtySpawnFn = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    cols: number;
    rows: number;
    name: string;
  },
) => PtyProcessLike;

export interface ClaudePtyDriverOptions {
  /** Inject a PTY spawner (tests). Defaults to the Python pty allocator. */
  ptySpawn?: PtySpawnFn;
  executable?: string;
  /** Python 3 interpreter used by the default PTY allocator. */
  pythonExecutable?: string;
  /** Override where Claude writes transcripts/config. Defaults to env / ~/.claude. */
  configDir?: string;
  /** Quiet window after spawn before the TUI is considered ready for input. */
  readyQuietMs?: number;
  /** Hard cap waiting for the TUI to settle after spawn. */
  readyTimeoutMs?: number;
  /**
   * Minimum time to keep watching for the first-run trust dialog before
   * concluding it won't appear (an early quiet gap during terminal setup can
   * precede the dialog by hundreds of ms — concluding "ready" then would type
   * the prompt into a not-yet-rendered TUI). Trusted dirs pay this once.
   */
  startupMinMs?: number;
  /** Delay between bracketed-paste of the prompt and the submitting Enter. */
  submitDelayMs?: number;
  /** Poll cadence for the hook-payload file. */
  pollIntervalMs?: number;
  /** Hard cap for a single turn before giving up. */
  turnTimeoutMs?: number;
  /** How long dispose() waits for `/quit` to close the TUI before TERM. */
  quitGraceMs?: number;
  /** How long dispose() waits after TERM before escalating to KILL. */
  killGraceMs?: number;
}

interface PtySession {
  proc: PtyProcessLike;
  claudeSessionId: string;
  configDir: string;
  /** Per-session file the hooks append their JSON payloads to (one line each). */
  hooksPath: string;
  hooksOffset: number;
  hooksRemainder: string;
  exited: boolean;
  exitCode: number | null;
  disposed: boolean;
  /** Recent raw PTY output (bounded) — used only to detect startup dialogs. */
  rawTail: string;
  /** Wall-clock of the last PTY data chunk; drives the quiet-settle detector. */
  lastDataAt: number;
  /** Whether the one-time startup dialog (folder trust) has been handled. */
  startupHandled: boolean;
}

const RAW_TAIL_MAX = 16 * 1024;
// The first-run interactive "Quick safety check: Is this a project you trust?"
// dialog. `--dangerously-skip-permissions` does NOT skip it (only `-p` does),
// so a PTY-driven session must answer it (Enter accepts the preselected "Yes,
// I trust this folder"). Matched against ANSI-stripped output — the TUI
// positions each word with cursor-move escapes, so the raw bytes interleave
// `\x1b[..G` between words and a phrase regex would never match the raw form.
const TRUST_DIALOG_RE = /trust this folder|is this a project you|safety check/i;

/**
 * Strip terminal escape/control sequences, turning each into a space so that
 * words the TUI separated with cursor-move escapes stay separated (the TUI
 * emits `Is\x1b[25Gthis` rather than `Is this`). Used only for dialog detection.
 */
function stripAnsi(s: string): string {
  return s
    // CSI / OSC / two-char ESC sequences → space
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, " ")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, " ")
    .replace(/\x1b[@-Z\\-_]/g, " ")
    // remaining control chars (incl. \r) → space
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ");
}

const DEFAULTS = {
  readyQuietMs: 600,
  readyTimeoutMs: 15_000,
  startupMinMs: 1_500,
  submitDelayMs: 40,
  pollIntervalMs: 120,
  turnTimeoutMs: 10 * 60_000,
  quitGraceMs: 3_000,
  killGraceMs: 750,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const nowMs = () => Date.now();
const dbg = (msg: string) => {
  if (process.env.CLAUDE_PTY_DEBUG) process.stderr.write(`[claude-pty] ${msg}\n`);
};
const dbgRaw = (data: string) => {
  if (!process.env.CLAUDE_PTY_DEBUG_RAW) return;
  const clean = stripAnsi(data).trim();
  if (clean) process.stderr.write(`[claude-pty-raw] ${clean.slice(-2000)}\n`);
};

/** POSIX single-quote a string for safe embedding in a shell command. */
function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildPtyArgs(input: {
  claudeSessionId: string;
  settingsPath: string;
  /**
   * When true, launch with `--resume <id>` instead of `--session-id <id>` so
   * the TUI reloads the existing transcript. Used only when respawning a
   * session whose persistent process died mid-conversation — a fresh
   * `--session-id` launch would otherwise start with no prior context.
   */
  resume?: boolean;
  model?: string;
  appendSystemPrompt?: string;
  additionalDirectories?: string[];
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}): string[] {
  // No `-p`: bare `claude` launches the interactive TUI. We pre-assign the
  // session id (also stamped on every hook payload) and inject a per-invocation
  // settings file carrying our observation hooks. `--resume <id>` and
  // `--session-id <id>` are mutually exclusive; both take the same coerced id.
  const args = input.resume
    ? ["--resume", input.claudeSessionId, "--settings", input.settingsPath]
    : ["--session-id", input.claudeSessionId, "--settings", input.settingsPath];
  // yolo-only: interactive permission prompts are not automated yet, so we
  // always launch without them. `run()` refuses securityMode "safe" before
  // ever reaching here, so this is never a silent sandbox downgrade.
  args.push("--dangerously-skip-permissions");
  if (input.model) args.push("--model", input.model);
  if (input.appendSystemPrompt) args.push("--append-system-prompt", input.appendSystemPrompt);
  if (input.additionalDirectories?.length) args.push("--add-dir", ...input.additionalDirectories);
  if (input.effort) args.push("--effort", input.effort);
  return args;
}

function hookSettings(hooksPath: string): string {
  // Each hook appends its stdin JSON payload as ONE line to hooksPath. Claude
  // emits the payload as single-line JSON, so `cat` + a trailing newline keeps
  // the file line-delimited. `printf` is dependency-free (no jq/node) and the
  // path is single-quoted so spaces in the storage dir are safe.
  const append = `cat >> ${shSingleQuote(hooksPath)}; printf '\\n' >> ${shSingleQuote(hooksPath)}`;
  const entry = { hooks: [{ type: "command", command: append }] };
  return JSON.stringify(
    { hooks: { PostToolUse: [entry], Stop: [entry] } },
    null,
    2,
  );
}

/**
 * Convert a Claude Code hook payload into normalized driver messages.
 * `PostToolUse` → tool_use + tool_result; `Stop` → the turn's assistant
 * message (from `last_assistant_message`). Returns `turnEnded` so the run
 * loop knows when to resolve.
 */
function parseHookEvent(payload: unknown): { messages: NormalizedDriverMessage[]; turnEnded: boolean } {
  if (!payload || typeof payload !== "object") return { messages: [], turnEnded: false };
  const e = payload as Record<string, unknown>;
  const event = String(e.hook_event_name ?? "");

  if (event === "PostToolUse") {
    const toolName = typeof e.tool_name === "string" ? e.tool_name : "unknown";
    const toolUseId = typeof e.tool_use_id === "string" ? e.tool_use_id : undefined;
    const isError =
      e.tool_response && typeof e.tool_response === "object"
        ? Boolean((e.tool_response as Record<string, unknown>).is_error)
        : undefined;
    return {
      messages: [
        { type: "tool_use", toolName, toolUseId, input: e.tool_input, raw: payload },
        { type: "tool_result", toolName, toolUseId, output: e.tool_response, isError, raw: payload },
      ],
      turnEnded: false,
    };
  }

  if (event === "Stop") {
    const text = typeof e.last_assistant_message === "string" ? e.last_assistant_message : "";
    const messages: NormalizedDriverMessage[] = text
      ? [{ type: "assistant", blocks: [{ type: "text", text, raw: payload }], raw: payload }]
      : [];
    return { messages, turnEnded: true };
  }

  return { messages: [], turnEnded: false };
}

/** Read bytes appended to `path` since `offset`. Returns text + new offset. */
function readAppended(path: string, offset: number): { text: string; offset: number } {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size <= offset) return { text: "", offset };
    const length = size - offset;
    const buf = Buffer.allocUnsafe(length);
    const read = readSync(fd, buf, 0, length, offset);
    return { text: buf.subarray(0, read).toString("utf8"), offset: offset + read };
  } catch {
    return { text: "", offset };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export class ClaudePtyDriver implements RuntimeDriver {
  readonly name = "claude-pty" as const;

  private readonly executable: string;
  private readonly pythonExecutable: string;
  private readonly injectedPtySpawn?: PtySpawnFn;
  private readonly configDirOverride?: string;
  private readonly opts: typeof DEFAULTS;
  private readonly sessions = new Map<string, PtySession>();

  constructor(options: ClaudePtyDriverOptions = {}) {
    this.injectedPtySpawn = options.ptySpawn;
    this.executable = options.executable ?? process.env.CLAUDE_CLI_EXECUTABLE ?? "claude";
    this.pythonExecutable = options.pythonExecutable ?? process.env.PI_PTY_PYTHON ?? "python3";
    this.configDirOverride = options.configDir;
    this.opts = {
      readyQuietMs: options.readyQuietMs ?? DEFAULTS.readyQuietMs,
      readyTimeoutMs: options.readyTimeoutMs ?? DEFAULTS.readyTimeoutMs,
      startupMinMs: options.startupMinMs ?? DEFAULTS.startupMinMs,
      submitDelayMs: options.submitDelayMs ?? DEFAULTS.submitDelayMs,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULTS.pollIntervalMs,
      turnTimeoutMs: options.turnTimeoutMs ?? DEFAULTS.turnTimeoutMs,
      quitGraceMs: options.quitGraceMs ?? DEFAULTS.quitGraceMs,
      killGraceMs: options.killGraceMs ?? DEFAULTS.killGraceMs,
    };
  }

  run(
    input: RuntimeDriverRunInput,
    onEventRaw: (event: DriverEventEnvelope) => Promise<void> | void,
  ): RuntimeDriverRunHandle {
    const effort = input.thinkingLevel ? foldThinkingLevelForClaude(input.thinkingLevel) : undefined;
    const onEvent = enrichInitWithCapabilities(onEventRaw, {
      thinkingLevelSupported: true,
      requestedThinkingLevel: input.thinkingLevel,
      effectiveThinkingLevel: effort,
    });

    let turnAborted = false;

    const done = (async (): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
      // Refuse safe mode loudly rather than silently dropping the sandbox.
      if (input.securityMode === "safe") {
        await onEvent({
          type: "error",
          payload: {
            message:
              "claude-pty supports only securityMode 'yolo' for now " +
              "(interactive permission prompts are not yet automated). " +
              "Pass securityMode: 'yolo' to use this driver.",
            code: "CLAUDE_PTY_SAFE_UNSUPPORTED",
          },
        });
        return { code: 1, signal: null };
      }

      let session: PtySession;
      try {
        session = await this.ensureSession(input, effort);
      } catch (error) {
        await onEvent({
          type: "error",
          payload: {
            message: enrichSpawnError(error instanceof Error ? error.message : String(error)),
            code: "CLAUDE_PTY_SPAWN_ERROR",
          },
        });
        return { code: 1, signal: null };
      }

      // Once per process: wait for the TUI to be ready, answering the
      // first-run folder-trust dialog if it appears (else our typed prompt is
      // swallowed dismissing it and never sent). Reused live sessions skip this.
      if (!session.startupHandled) {
        await this.awaitStartup(session);
        session.startupHandled = true;
      }
      if (session.exited) {
        await onEvent({
          type: "error",
          payload: {
            message: `claude interactive process exited before the turn (code=${session.exitCode ?? "null"})`,
            code: "CLAUDE_PTY_EXITED",
          },
        });
        return { code: session.exitCode ?? 1, signal: null };
      }

      // Drain hook lines from any prior turns so this turn only emits its own
      // messages (advance the offset without re-emitting history).
      this.drainHooks(session);

      // Type the prompt via bracketed paste so embedded newlines in a
      // multi-line prompt don't submit early; Enter submits the whole thing.
      dbg(`submitting prompt (${input.prompt.length} chars)`);
      session.proc.write(`\x1b[200~${input.prompt}\x1b[201~`);
      await sleep(this.opts.submitDelayMs);
      session.proc.write("\r");

      // Wait for the turn to end: a Stop hook line. PostToolUse lines stream
      // tool_use/tool_result messages in the meantime.
      const deadline = Date.now() + this.opts.turnTimeoutMs;
      while (true) {
        if (turnAborted) {
          await this.pumpHooks(session, onEvent);
          return { code: 130, signal: "SIGINT" };
        }
        if (session.exited) {
          await this.pumpHooks(session, onEvent);
          // /quit (graceful dispose) exits 0; any other exit mid-turn is an error.
          if (session.disposed) return { code: session.exitCode ?? 0, signal: null };
          await onEvent({
            type: "error",
            payload: {
              message: `claude interactive process exited mid-turn (code=${session.exitCode ?? "null"})`,
              code: "CLAUDE_PTY_EXITED",
            },
          });
          return { code: session.exitCode ?? 1, signal: null };
        }
        const { turnEnded } = await this.pumpHooks(session, onEvent);
        if (turnEnded) {
          return { code: 0, signal: null };
        }
        if (Date.now() > deadline) {
          await onEvent({
            type: "error",
            payload: {
              message: `claude-pty turn timed out after ${this.opts.turnTimeoutMs}ms with no Stop hook`,
              code: "CLAUDE_PTY_TURN_TIMEOUT",
            },
          });
          return { code: 1, signal: null };
        }
        await sleep(this.opts.pollIntervalMs);
      }
    })();

    return {
      kill: (_signal: NodeJS.Signals = "SIGINT") => {
        // Interrupt = cancel the CURRENT turn, keep the session hot. ESC tells
        // the TUI to abort the in-flight response. The process is NOT killed
        // here — teardown happens via dispose() (`/quit`). The pump loop sees
        // `turnAborted` and resolves the active turn.
        turnAborted = true;
        const session = this.sessions.get(input.sessionId);
        session?.proc.write("\x1b");
      },
      done,
    };
  }

  /**
   * Graceful teardown of a session's interactive process. The runtime's
   * `stop()` calls this. We type `/quit` (a real interactive command) so the
   * TUI shuts down cleanly, flushing its transcript, then drop the session.
   */
  async dispose(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.disposed = true;
    if (session.exited) return;
    try {
      session.proc.write("/quit\r");
    } catch {
      // fall through to force-kill
    }
    if (await this.awaitExit(session, this.opts.quitGraceMs)) return;

    try {
      session.proc.kill("SIGTERM");
    } catch {
      // fall through to SIGKILL
    }
    if (await this.awaitExit(session, this.opts.killGraceMs)) return;

    try {
      session.proc.kill("SIGKILL");
    } catch {
      // already gone
    }
    await this.awaitExit(session, this.opts.killGraceMs);
  }

  private async awaitExit(session: PtySession, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!session.exited && Date.now() < deadline) {
      await sleep(50);
    }
    return session.exited;
  }

  private async ensureSession(
    input: RuntimeDriverRunInput,
    effort: "low" | "medium" | "high" | "xhigh" | "max" | undefined,
  ): Promise<PtySession> {
    const existing = this.sessions.get(input.sessionId);
    if (existing && !existing.exited && !existing.disposed) return existing;

    const claudeSessionId = coerceClaudeCliSessionId(input.sessionId);
    const configDir =
      this.configDirOverride ??
      input.env?.CLAUDE_CONFIG_DIR ??
      process.env.CLAUDE_CONFIG_DIR ??
      join(homedir(), ".claude");

    const workDir =
      input.sessionStorageDir ?? join(tmpdir(), "pi-ca-leash-interactive", input.sessionId);
    mkdirSync(workDir, { recursive: true });
    const hooksPath = join(workDir, "interactive-hooks.jsonl");
    // Truncate on every (re)spawn: prior turns' hook lines were already
    // consumed, so offset tracking restarts cleanly at 0.
    writeFileSync(hooksPath, "");
    const settingsPath = join(workDir, "interactive-settings.json");
    writeFileSync(settingsPath, hookSettings(hooksPath));

    // Resume mode: the runtime sets resumeSessionId on every send(). We only
    // ever reach a spawn here on send() when the prior persistent process is
    // gone (otherwise we returned the live `existing` session above), so a
    // resumeSessionId means "respawn and reload context" → `--resume`.
    const resume = Boolean(input.resumeSessionId);

    const args = buildPtyArgs({
      claudeSessionId,
      settingsPath,
      resume,
      model: input.model,
      appendSystemPrompt: input.appendSystemPrompt,
      additionalDirectories: input.additionalDirectories,
      effort,
    });

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    for (const [k, v] of Object.entries(input.env ?? {})) env[k] = v;
    if (!env.TERM) env.TERM = "xterm-256color";

    const spawnPty = this.injectedPtySpawn ?? this.pythonPtySpawn;
    const proc = spawnPty(this.executable, args, {
      cwd: input.cwd,
      env,
      cols: 120,
      rows: 40,
      name: env.TERM,
    });

    const session: PtySession = {
      proc,
      claudeSessionId,
      configDir,
      hooksPath,
      hooksOffset: 0,
      hooksRemainder: "",
      exited: false,
      exitCode: null,
      disposed: false,
      rawTail: "",
      lastDataAt: 0,
      startupHandled: false,
    };

    proc.onData((data: string) => {
      session.lastDataAt = nowMs();
      session.rawTail = (session.rawTail + data).slice(-RAW_TAIL_MAX);
      dbgRaw(data);
    });
    proc.onExit(({ exitCode }) => {
      session.exited = true;
      session.exitCode = exitCode;
    });

    session.lastDataAt = nowMs();
    this.sessions.set(input.sessionId, session);
    return session;
  }

  /**
   * Drive the one-time startup to a ready-for-input state.
   *
   * The naive "first quiet window = ready" heuristic is wrong: terminal-setup
   * escapes are emitted, then there's a lull of a few hundred ms BEFORE the
   * first-run trust dialog renders. Concluding "ready" in that lull types the
   * prompt into a not-yet-rendered TUI and the dialog later swallows it.
   *
   * So we keep watching: if the trust dialog appears (it isn't suppressed by
   * `--dangerously-skip-permissions` in interactive mode), accept it with Enter
   * (preselected "Yes, I trust this folder"); otherwise only conclude "no
   * dialog, ready" once output is quiet AND we've watched at least
   * `startupMinMs` (so an early lull can't short-circuit). Either way we then
   * wait for the post-dialog render to settle before returning.
   */
  private async awaitStartup(session: PtySession): Promise<void> {
    const start = nowMs();
    const deadline = start + this.opts.readyTimeoutMs;
    let trustAnswered = false;
    while (!session.exited && nowMs() < deadline) {
      if (!trustAnswered && TRUST_DIALOG_RE.test(stripAnsi(session.rawTail))) {
        dbg("trust dialog detected → Enter");
        session.proc.write("\r");
        trustAnswered = true;
        session.lastDataAt = nowMs();
      }
      const quiet = nowMs() - session.lastDataAt >= this.opts.readyQuietMs;
      const watchedMin = nowMs() - start >= this.opts.startupMinMs;
      if (quiet && (trustAnswered || watchedMin)) {
        dbg(`startup ready (trustAnswered=${trustAnswered}, waited=${nowMs() - start}ms)`);
        return;
      }
      await sleep(50);
    }
    dbg(`startup deadline/exit (exited=${session.exited})`);
  }

  /**
   * Read newly appended hook payload lines, emit their normalized messages,
   * and report whether a Stop hook (turn end) was among them.
   */
  private async pumpHooks(
    session: PtySession,
    onEvent: (event: DriverEventEnvelope) => Promise<void> | void,
  ): Promise<{ turnEnded: boolean }> {
    const lines = this.readHookLines(session);
    let turnEnded = false;
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // tolerate a partial/garbled line
      }
      const { messages, turnEnded: ended } = parseHookEvent(parsed);
      for (const message of messages) {
        await onEvent({ type: "message", payload: message });
      }
      if (ended) turnEnded = true;
    }
    return { turnEnded };
  }

  /** Advance past hook lines already written (without emitting them). */
  private drainHooks(session: PtySession): void {
    this.readHookLines(session);
  }

  /** Pull complete newly-appended lines from the hooks file, advancing offset. */
  private readHookLines(session: PtySession): string[] {
    const { text, offset } = readAppended(session.hooksPath, session.hooksOffset);
    session.hooksOffset = offset;
    if (!text) return [];
    const buffer = session.hooksRemainder + text;
    const parts = buffer.split("\n");
    session.hooksRemainder = parts.pop() ?? "";
    return parts.map((l) => l.trim()).filter(Boolean);
  }

  /**
   * Default PTY allocator — spawns Python 3 running {@link PTY_ALLOCATOR},
   * which `pty.fork()`s a real pseudo-terminal, sets its window size, execs the
   * target, and relays bytes between our stdio pipes and the pty master.
   *
   * Why Python instead of a native pty addon (node-pty): a real pty needs
   * `openpty`/`forkpty` syscalls, so every JS pty library is either a native
   * addon (needs a matching prebuild or a from-source compile — brittle on new
   * Node ABIs) or a wrapper around a system binary. `python3` is present by
   * default on macOS and most Linux, needs no compile step, and works headless
   * (unlike the `script` binary, which requires its own controlling terminal).
   * Tests inject their own `ptySpawn`, so this is only the production default.
   */
  private readonly pythonPtySpawn: PtySpawnFn = (file, args, options) => {
    const child = nodeSpawn(
      this.pythonExecutable,
      ["-c", PTY_ALLOCATOR, file, ...args],
      {
        cwd: options.cwd,
        env: { ...options.env, PI_PTY_COLS: String(options.cols), PI_PTY_ROWS: String(options.rows) },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      },
    );
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString("utf8")).slice(-4096);
    });
    return {
      pid: child.pid ?? -1,
      write: (data: string) => {
        child.stdin?.write(data);
      },
      onData: (listener) => {
        child.stdout?.on("data", (d: Buffer) => listener(d.toString("utf8")));
      },
      onExit: (listener) => {
        child.on("error", (err) => {
          dbg(`python pty spawn error: ${err.message}${stderr ? ` | ${stderr}` : ""}`);
          listener({ exitCode: 1 });
        });
        child.on("exit", (code, signal) =>
          listener({ exitCode: code ?? 0, signal: signal ? 1 : undefined }),
        );
      },
      kill: (signal?: string) => {
        const sig = (signal as NodeJS.Signals) ?? "SIGTERM";
        if (child.pid) {
          try {
            process.kill(-child.pid, sig);
            return;
          } catch (err) {
            dbg(`python pty process-group kill failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        child.kill(sig);
      },
    };
  };
}

// Inline Python pty allocator. Reads window size from PI_PTY_COLS/PI_PTY_ROWS,
// forks a pty, execs argv[1:], and relays stdin<->master<->stdout until the
// child exits, propagating its exit code. Kept dependency-free (stdlib only).
const PTY_ALLOCATOR = [
  "import os,pty,sys,fcntl,termios,struct,select,signal",
  'cols=int(os.environ.get("PI_PTY_COLS","120"));rows=int(os.environ.get("PI_PTY_ROWS","40"))',
  "argv=sys.argv[1:]",
  "pid,fd=pty.fork()",
  "if pid==0:",
  "    os.execvp(argv[0],argv);os._exit(127)",
  "def forward(sig,frame):",
  "    try:",
  "        os.kill(pid,sig)",
  "    except ProcessLookupError:",
  "        pass",
  "for sig in (signal.SIGTERM,signal.SIGINT,signal.SIGHUP):",
  "    try:",
  "        signal.signal(sig,forward)",
  "    except Exception:",
  "        pass",
  "try:",
  '    fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack("HHHH",rows,cols,0,0))',
  "except Exception:",
  "    pass",
  "so=True",
  "while True:",
  "    fds=[fd]+([0] if so else [])",
  "    try:",
  "        r,_,_=select.select(fds,[],[])",
  "    except (OSError,ValueError):",
  "        break",
  "    if fd in r:",
  "        try:",
  "            data=os.read(fd,65536)",
  "        except OSError:",
  "            data=b''",
  "        if not data: break",
  "        try:",
  "            os.write(1,data)",
  "        except OSError:",
  "            break",
  "    if so and 0 in r:",
  "        try:",
  "            data=os.read(0,65536)",
  "        except OSError:",
  "            data=b''",
  "        if not data: so=False",
  "        else:",
  "            try:",
  "                os.write(fd,data)",
  "            except OSError:",
  "                pass",
  "try:",
  "    _,status=os.waitpid(pid,0)",
  "except OSError:",
  "    status=0",
  "sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else (128+os.WTERMSIG(status) if os.WIFSIGNALED(status) else 0))",
].join("\n");

function enrichSpawnError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("enoent") || lower.includes("not found")) {
    return `${message}\nHint: could not spawn the PTY allocator or claude. Ensure python3 is on PATH (or set PI_PTY_PYTHON) and claude is on PATH (or set CLAUDE_CLI_EXECUTABLE).`;
  }
  return message;
}
