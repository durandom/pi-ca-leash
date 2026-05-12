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
  raw?: Record<string, unknown>;
}

export interface StartSessionInput {
  prompt: string;
  driver?: RuntimeDriverName;
  cwd?: string;
  model?: string;
  name?: string;
  appendSystemPrompt?: string;
  permissionMode?:
    | "acceptEdits"
    | "auto"
    | "bypassPermissions"
    | "default"
    | "dontAsk"
    | "plan";
  tools?: string[];
  additionalDirectories?: string[];
  env?: Record<string, string>;
}

export interface SendMessageInput {
  sessionId: RuntimeSessionId;
  message: string;
  appendSystemPrompt?: string;
  model?: string;
  env?: Record<string, string>;
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
  prompt: string;
  cwd: string;
  model?: string;
  name?: string;
  appendSystemPrompt?: string;
  permissionMode?: StartSessionInput["permissionMode"];
  tools?: string[];
  additionalDirectories?: string[];
  env?: Record<string, string>;
  resumeSessionId?: string;
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
