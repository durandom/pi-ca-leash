import type {
  ClaudeCodeRuntime,
  RuntimeDriverName,
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
  driver?: RuntimeDriverName;
  state: BridgeState;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
}

export interface LaunchPeerInput {
  name: string;
  prompt: string;
  driver?: RuntimeDriverName;
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
