import type {
  InterruptResult,
  RuntimeDriverName,
  RuntimeEvent,
  RuntimeOptions,
  RuntimeSessionId,
  RuntimeStatus,
  RuntimeSecurityMode,
  RuntimeThinkingLevel,
  StartSessionInput,
} from "@pi-claude-code-agent/runtime";
import type { ClaudeCodeRuntime } from "@pi-claude-code-agent/runtime/internal";

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
  /**
   * Verbatim projection of `RuntimeStatus.raw` — driver-specific init payload
   * plus any other runtime-level scratch state. The runtime folds system/init
   * driver messages into `raw.init` rather than emitting them as transcript
   * events, so this is the only surface where consumers can read capability
   * fields like `requestedThinkingLevel` / `effectiveThinkingLevel` /
   * `thinkingLevelSupported`. Opaque by design — drivers control the shape.
   */
  raw?: Record<string, unknown>;
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
  /**
   * Driver fields forwarded verbatim to `runtime.send`. The Bridge does not
   * filter these — drivers ignore fields they don't understand. Of these
   * four, only `securityMode` is session-sticky at the runtime layer (see
   * `RuntimeStatus.securityMode`): omitting it on a follow-up re-applies
   * the value captured at `start()`. `appendSystemPrompt`, `env`, and
   * `thinkingLevel` are per-send only — omit on a follow-up and the
   * driver falls back to its own defaults (no implicit re-application).
   */
  appendSystemPrompt?: string;
  env?: Record<string, string>;
  thinkingLevel?: RuntimeThinkingLevel;
  securityMode?: RuntimeSecurityMode;
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
  /**
   * Share an externally-constructed Runtime with the Bridge. Use this when a
   * sibling consumer (e.g. `ClaudeCodeSubagentBackend`) needs the same
   * in-process event source and storage owner. The Bridge does NOT expose
   * this back to its public surface — callers are responsible for not
   * leaking their own reference.
   *
   * If both `runtime` and `runtimeOptions` are set, `runtime` wins and
   * `runtimeOptions` is ignored.
   */
  runtime?: ClaudeCodeRuntime;
  /**
   * Construction options for a Bridge-owned `ClaudeCodeRuntime`. Use this in
   * the common case where the Bridge is the sole Runtime consumer (most
   * applications, all tests with a fake driver). Ignored if `runtime` is
   * also passed.
   */
  runtimeOptions?: RuntimeOptions;
  storageDir?: string;
  transport?: BridgeTransport;
  pollIntervalMs?: number;
  askTimeoutMs?: number;
}
