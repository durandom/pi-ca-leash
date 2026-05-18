import type { NormalizedDriverMessage } from "./drivers/messages.js";

export type RuntimeSessionId = string;
export type RuntimeDriverName = "claude-sdk" | "claude-cli" | "codex-cli" | "pi-coding-agent";

export type RuntimeSessionState =
  | "starting"
  | "running"
  | "idle"
  | "interrupted"
  | "stopped"
  | "failed";

export interface RuntimeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
  totalCostUsd?: number;
  contextTokens?: number;
  contextWindow?: number;
  contextPercentage?: number;
  maxOutputTokens?: number;
  raw?: unknown;
}

export interface RuntimeMessageBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  content?: unknown;
  isError?: boolean;
  raw?: unknown;
}

export interface RuntimeMessage {
  role: "user" | "assistant" | "system" | "tool";
  blocks: RuntimeMessageBlock[];
  raw?: unknown;
}

export interface RuntimeStatus {
  sessionId: RuntimeSessionId;
  driver: RuntimeDriverName;
  driverSessionId: string;
  state: RuntimeSessionState;
  cwd: string;
  model?: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  activeRunId?: string;
  stopRequested?: boolean;
  interruptedAt?: string;
  stoppedAt?: string;
  completedAt?: string;
  lastError?: {
    message: string;
    code?: string;
  };
  /**
   * Resolved coarse security posture captured at `start()` and re-applied to
   * every subsequent `send()` on the same session unless the caller passes an
   * explicit override. Persisted so resumes don't silently regress to `safe`.
   */
  securityMode?: RuntimeSecurityMode;
  raw?: Record<string, unknown>;
}

/**
 * Canonical cross-driver thinking budget vocabulary. Five values, taken
 * verbatim from Anthropic's `EffortLevel` (the most expressive surface of
 * the three driver families pi-ca-leash currently supports). Every driver
 * accepts the same values from the consumer; each driver folds them to its
 * own native vocabulary internally (see `drivers/thinking.ts`).
 *
 * Folds applied per driver:
 *   - `claude-sdk`, `claude-cli`: passthrough (native vocab).
 *   - `pi-coding-agent`: `xhigh → high`, `max → high` (SDK ladder tops at high).
 *   - `codex-cli` (OpenAI): `xhigh → high`, `max → high` (OpenAI tops at high).
 *
 * Omit the field entirely to use each driver's vendor default (no `"off"`
 * value — Claude / OpenAI / pi all default to a reasonable budget when the
 * flag is absent, and the explicit-off semantics differ enough that a
 * canonical mapping would be misleading).
 */
export type RuntimeThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Coarse security posture. Drivers map this to their native sandbox / approval
 * flag — pi-ca-leash does NOT enforce tool-level filtering on top.
 *
 * - `safe` (default): driver runs with its native sandbox + permission prompts
 *   (claude-sdk `permissionMode: "default"`, claude-cli `--permission-mode default`,
 *   codex-cli `--sandbox workspace-write` sandbox).
 * - `yolo`: driver runs without permission prompts and without sandbox where
 *   supported (claude-sdk `bypassPermissions`, claude-cli `--dangerously-skip-permissions`,
 *   codex-cli `--dangerously-bypass-approvals-and-sandbox`).
 *
 * `pi-coding-agent` has no native sandbox; the field is ignored and a warning
 * is echoed on the init system event.
 */
export type RuntimeSecurityMode = "safe" | "yolo";

/**
 * @deprecated Use {@link RuntimeSecurityMode} via `securityMode`.
 * Legacy values map: `bypassPermissions` → `yolo`; `default`/`acceptEdits`/`auto`
 * → `safe`. `plan` and `dontAsk` are rejected.
 */
export type LegacyPermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan";

export interface StartSessionInput {
  prompt: string;
  driver?: RuntimeDriverName;
  cwd?: string;
  model?: string;
  name?: string;
  appendSystemPrompt?: string;
  /** @deprecated Use `securityMode`. */
  permissionMode?: LegacyPermissionMode;
  securityMode?: RuntimeSecurityMode;
  tools?: string[];
  additionalDirectories?: string[];
  env?: Record<string, string>;
  /**
   * Per-call thinking budget for drivers that support it (currently the
   * `pi-coding-agent` driver). When omitted, the driver's configured
   * `defaultThinkingLevel` is used. Drivers that don't support per-call
   * thinking ignore this field.
   */
  thinkingLevel?: RuntimeThinkingLevel;
}

export interface SendMessageInput {
  sessionId: RuntimeSessionId;
  message: string;
  appendSystemPrompt?: string;
  model?: string;
  env?: Record<string, string>;
  /** See {@link StartSessionInput.thinkingLevel}. */
  thinkingLevel?: RuntimeThinkingLevel;
  /** See {@link StartSessionInput.securityMode}. */
  securityMode?: RuntimeSecurityMode;
}

export interface InterruptResult {
  sessionId: RuntimeSessionId;
  interrupted: boolean;
  signal?: NodeJS.Signals;
  reason: "no-active-run" | "signalled" | "already-stopped";
}

export interface TranscriptChunk {
  items: RuntimeEvent[];
  nextCursor: number;
}

export interface RuntimeEventBase {
  id: string;
  sessionId: RuntimeSessionId;
  sequence: number;
  timestamp: string;
  type:
    | "session.created"
    | "session.updated"
    | "session.idle"
    | "session.stopped"
    | "message"
    | "tool"
    | "result"
    | "error"
    | "attention";
  raw?: unknown;
}

export interface SessionCreatedEvent extends RuntimeEventBase {
  type: "session.created";
  state: RuntimeSessionState;
}

export interface SessionUpdatedEvent extends RuntimeEventBase {
  type: "session.updated";
  state: RuntimeSessionState;
  patch?: Record<string, unknown>;
}

export interface SessionIdleEvent extends RuntimeEventBase {
  type: "session.idle";
  state: "idle" | "interrupted";
}

export interface SessionStoppedEvent extends RuntimeEventBase {
  type: "session.stopped";
  state: "stopped" | "failed";
}

export interface MessageEvent extends RuntimeEventBase {
  type: "message";
  role: RuntimeMessage["role"];
  message: RuntimeMessage;
}

export interface ToolEvent extends RuntimeEventBase {
  type: "tool";
  phase: "requested" | "completed";
  toolName: string;
  toolUseId?: string;
  input?: unknown;
  output?: unknown;
  isError?: boolean;
}

export interface ResultEvent extends RuntimeEventBase {
  type: "result";
  ok: boolean;
  summary: string;
  stopReason?: string;
  usage?: RuntimeUsage;
}

export interface ErrorEvent extends RuntimeEventBase {
  type: "error";
  message: string;
  code?: string;
}

export interface AttentionEvent extends RuntimeEventBase {
  type: "attention";
  reason: string;
}

export type RuntimeEvent =
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | SessionIdleEvent
  | SessionStoppedEvent
  | MessageEvent
  | ToolEvent
  | ResultEvent
  | ErrorEvent
  | AttentionEvent;

export interface RuntimeDriverRunInput {
  sessionId: RuntimeSessionId;
  /**
   * Per-session storage directory owned by the runtime
   * (`<storageDir>/sessions/<sessionId>`). Drivers MAY place their own
   * persistent state under a subdirectory here (e.g. SDK session files) so
   * that resume state survives process restarts and is colocated with the
   * runtime's state.json / events.jsonl / transcript.jsonl. Optional only so
   * direct driver tests can omit it; the runtime always supplies it.
   */
  sessionStorageDir?: string;
  prompt: string;
  cwd: string;
  model?: string;
  name?: string;
  appendSystemPrompt?: string;
  /** @deprecated Use `securityMode`. Still honored as a fallback. */
  permissionMode?: LegacyPermissionMode;
  /**
   * Resolved coarse security posture. The runtime resolves the effective mode
   * from caller `securityMode` first, then legacy `permissionMode`, then `safe`.
   * Drivers should branch only on this field.
   */
  securityMode?: RuntimeSecurityMode;
  tools?: string[];
  additionalDirectories?: string[];
  env?: Record<string, string>;
  resumeSessionId?: string;
  /** See {@link StartSessionInput.thinkingLevel}. */
  thinkingLevel?: RuntimeThinkingLevel;
}

export type DriverEventEnvelope =
  | {
      type: "raw";
      payload: unknown;
    }
  | {
      type: "message";
      payload: NormalizedDriverMessage;
    }
  | {
      type: "error";
      payload: {
        message?: string;
        code?: string;
        raw?: unknown;
      };
    };

export interface RuntimeDriverRunHandle {
  kill(signal?: NodeJS.Signals): void;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

export interface RuntimeDriver {
  name: RuntimeDriverName;
  run(
    input: RuntimeDriverRunInput,
    onEvent: (event: DriverEventEnvelope) => Promise<void> | void,
  ): RuntimeDriverRunHandle;
}

export type RuntimeDriverResolver = (name: RuntimeDriverName) => RuntimeDriver;

export interface RuntimeOptions {
  storageDir?: string;
  driver?: RuntimeDriver;
  drivers?: Partial<Record<RuntimeDriverName, RuntimeDriver>>;
  defaultDriver?: RuntimeDriverName;
  resolveDriver?: RuntimeDriverResolver;
  config?: import("./config.js").PiCaLeashConfig;
}
