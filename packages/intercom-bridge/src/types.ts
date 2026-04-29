import type {
  ClaudeCodeRuntime,
  RuntimeEvent,
  RuntimeSessionId,
  RuntimeStatus,
  StartSessionInput,
} from "@pi-claude-code-agent/runtime";

export type BridgeState =
  | "starting"
  | "connected"
  | "idle"
  | "busy"
  | "interrupted"
  | "stopped"
  | "errored"
  | "disconnected";

export type IntercomMessageKind = "send" | "ask" | "reply";

export interface BridgePeer {
  name: string;
  sessionId: RuntimeSessionId;
  cwd: string;
  model?: string;
  state: BridgeState;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
}

export interface LaunchPeerInput {
  name: string;
  prompt: string;
  cwd?: string;
  model?: string;
  appendSystemPrompt?: string;
  permissionMode?: StartSessionInput["permissionMode"];
  tools?: string[];
  additionalDirectories?: string[];
  env?: Record<string, string>;
}

export interface AttachPeerInput {
  name: string;
  sessionId: RuntimeSessionId;
}

export interface IntercomInboundMessage {
  kind: IntercomMessageKind;
  from: string;
  text: string;
  replyTo?: string;
  timeoutMs?: number;
}

export interface AskResult {
  peer: BridgePeer;
  reply: string;
  runState: RuntimeStatus["state"];
  events: RuntimeEvent[];
}

export interface BridgeOptions {
  runtime?: ClaudeCodeRuntime;
  pollIntervalMs?: number;
  askTimeoutMs?: number;
}
