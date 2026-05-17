import type {
  ClaudeCodeRuntime,
  InterruptResult,
  RuntimeDriverName,
  RuntimeEvent,
  RuntimeSessionId,
  RuntimeStatus,
  RuntimeSecurityMode,
  RuntimeThinkingLevel,
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

export type BridgePeerKind = "ad-hoc" | "managed";

export interface BridgePeer {
  name: string;
  sessionId: RuntimeSessionId;
  cwd: string;
  model?: string;
  driver?: RuntimeDriverName;
  state: BridgeState;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  kind?: BridgePeerKind;
  metadata?: Record<string, string>;
}

export interface InterruptPeerResult {
  peer: BridgePeer;
  interrupt: InterruptResult;
}

export interface LaunchPeerInput {
  name: string;
  prompt: string;
  driver?: RuntimeDriverName;
  cwd?: string;
  model?: string;
  appendSystemPrompt?: string;
  /** @deprecated Use `securityMode`. */
  permissionMode?: StartSessionInput["permissionMode"];
  /**
   * Coarse security posture. `safe` (default) keeps the driver's native
   * sandbox/permission prompts; `yolo` disables them where the driver
   * supports it. See runtime `RuntimeSecurityMode` for per-driver details.
   */
  securityMode?: RuntimeSecurityMode;
  tools?: string[];
  additionalDirectories?: string[];
  env?: Record<string, string>;
  waitForIdle?: boolean;
  kind?: BridgePeerKind;
  metadata?: Record<string, string>;
  /**
   * Per-call thinking budget for drivers that support it (currently
   * `pi-coding-agent`). When omitted, the driver's configured
   * `defaultThinkingLevel` is used. Drivers that don't support per-call
   * thinking ignore this field.
   */
  thinkingLevel?: RuntimeThinkingLevel;
}

export interface AttachPeerInput {
  name: string;
  sessionId: RuntimeSessionId;
  kind?: BridgePeerKind;
  metadata?: Record<string, string>;
}

export interface IntercomInboundMessage {
  kind: IntercomMessageKind;
  from: string;
  text: string;
  replyTo?: string;
  timeoutMs?: number;
  model?: string;
}

export type DeliveryState = "completed" | "delivered_and_running";

export interface AskResult {
  peer: BridgePeer;
  reply: string;
  runState: RuntimeStatus["state"];
  events: RuntimeEvent[];
  deliveryState: DeliveryState;
}

export interface BridgeTransportAttachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export interface BridgeTransportSessionInfo {
  id: string;
  name?: string;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
}

export interface BridgeTransportIncomingMessage {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  text: string;
  attachments?: BridgeTransportAttachment[];
  from: BridgeTransportSessionInfo;
}

export interface BridgeTransportOutgoingMessage {
  text: string;
  replyTo?: string;
  expectsReply?: boolean;
  attachments?: BridgeTransportAttachment[];
}

export interface BridgeTransportStatus {
  kind: string;
  boundPeers: number;
  connectedPeers: number;
}

export interface BridgeTransport {
  registerPeer(
    peer: BridgePeer,
    onMessage: (message: BridgeTransportIncomingMessage) => Promise<void> | void,
  ): Promise<void>;
  updatePeer(peer: BridgePeer): Promise<void>;
  unregisterPeer(name: string): Promise<void>;
  sendFromPeer(peerName: string, to: string, message: BridgeTransportOutgoingMessage): Promise<void>;
  listSessions?(): Promise<BridgeTransportSessionInfo[]>;
  getStatus?(): Promise<BridgeTransportStatus> | BridgeTransportStatus;
  close?(): Promise<void>;
}

export interface BridgeOptions {
  runtime?: ClaudeCodeRuntime;
  storageDir?: string;
  transport?: BridgeTransport;
  pollIntervalMs?: number;
  askTimeoutMs?: number;
}
