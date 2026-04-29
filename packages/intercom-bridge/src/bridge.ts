import {
  ClaudeCodeRuntime,
  type RuntimeEvent,
  type RuntimeMessageBlock,
  type RuntimeSessionId,
  type RuntimeStatus,
} from "@pi-claude-code-agent/runtime";
import type {
  AskResult,
  AttachPeerInput,
  BridgeOptions,
  BridgePeer,
  BridgeState,
  IntercomInboundMessage,
  LaunchPeerInput,
} from "./types.js";

const DEFAULT_ASK_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

const BRIDGE_SYSTEM_PROMPT = [
  "You are a long-lived Claude worker reached through intercom-style messages.",
  "Treat new messages as continuation of same session, not fresh bootstrap.",
  "For asks and replies, answer concisely and directly.",
  "When you finish handling one inbound message, end in a clean idle state.",
].join(" ");

export class ClaudeRuntimeIntercomBridge {
  private readonly runtime: ClaudeCodeRuntime;
  private readonly pollIntervalMs: number;
  private readonly askTimeoutMs: number;
  private readonly peers = new Map<string, BridgePeer>();

  constructor(options: BridgeOptions = {}) {
    this.runtime = options.runtime ?? new ClaudeCodeRuntime();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.askTimeoutMs = options.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  }

  async launchPeer(input: LaunchPeerInput): Promise<BridgePeer> {
    this.assertPeerNameAvailable(input.name);
    const status = await this.runtime.start({
      prompt: input.prompt,
      cwd: input.cwd,
      model: input.model,
      name: input.name,
      appendSystemPrompt: mergeSystemPrompt(input.appendSystemPrompt),
      permissionMode: input.permissionMode,
      tools: input.tools,
      additionalDirectories: input.additionalDirectories,
      env: input.env,
    });
    const peer = this.peerFromStatus(input.name, status, "starting");
    this.peers.set(peer.name, peer);
    await this.waitForTerminalState(peer.sessionId);
    return this.syncPeerFromRuntime(peer.name);
  }

  async attachPeer(input: AttachPeerInput): Promise<BridgePeer> {
    this.assertPeerNameAvailable(input.name);
    const status = await this.runtime.status(input.sessionId);
    if (!status) {
      throw new Error(`Unknown runtime session ${input.sessionId}`);
    }
    const peer = this.peerFromStatus(input.name, status, mapRuntimeState(status.state, true));
    this.peers.set(peer.name, peer);
    return peer;
  }

  async listPeers(): Promise<BridgePeer[]> {
    const peers = await Promise.all([...this.peers.values()].map((peer) => this.syncPeerFromRuntime(peer.name)));
    return peers.sort((a, b) => a.name.localeCompare(b.name));
  }

  async status(name: string): Promise<BridgePeer | undefined> {
    if (!this.peers.has(name)) {
      return undefined;
    }
    return this.syncPeerFromRuntime(name);
  }

  async send(name: string, message: Omit<IntercomInboundMessage, "kind">): Promise<BridgePeer> {
    const result = await this.deliver(name, { ...message, kind: "send" });
    return result.peer;
  }

  async ask(name: string, message: Omit<IntercomInboundMessage, "kind">): Promise<AskResult> {
    return this.deliver(name, { ...message, kind: "ask" });
  }

  async reply(name: string, message: Omit<IntercomInboundMessage, "kind">): Promise<BridgePeer> {
    const result = await this.deliver(name, { ...message, kind: "reply" });
    return result.peer;
  }

  async stop(name: string): Promise<BridgePeer> {
    const peer = this.requirePeer(name);
    await this.runtime.stop(peer.sessionId);
    return this.syncPeerFromRuntime(name);
  }

  async disconnect(name: string): Promise<BridgePeer> {
    const peer = this.requirePeer(name);
    const next: BridgePeer = {
      ...peer,
      state: "disconnected",
      updatedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    this.peers.set(name, next);
    return next;
  }

  private async deliver(name: string, inbound: IntercomInboundMessage): Promise<AskResult> {
    const peer = await this.syncPeerFromRuntime(name);
    if (["busy", "starting"].includes(peer.state)) {
      throw new Error(`Peer ${name} busy`);
    }
    if (["stopped", "disconnected"].includes(peer.state)) {
      throw new Error(`Peer ${name} unavailable (${peer.state})`);
    }

    const before = await this.runtime.events(peer.sessionId);
    const cursor = before.nextCursor;
    await this.runtime.send({
      sessionId: peer.sessionId,
      message: formatInboundMessage(inbound),
    });

    const status = await this.waitForTerminalState(peer.sessionId, inbound.timeoutMs ?? this.askTimeoutMs);
    const chunk = await this.runtime.events(peer.sessionId, cursor);
    const syncedPeer = await this.syncPeerFromRuntime(name);
    return {
      peer: syncedPeer,
      reply: extractReplyText(chunk.items),
      runState: status.state,
      events: chunk.items,
    };
  }

  private async waitForTerminalState(sessionId: RuntimeSessionId, timeoutMs = this.askTimeoutMs): Promise<RuntimeStatus> {
    const started = Date.now();
    for (;;) {
      const status = await this.runtime.status(sessionId);
      if (!status) {
        throw new Error(`Unknown runtime session ${sessionId}`);
      }
      if (["idle", "interrupted", "failed", "stopped"].includes(status.state)) {
        return status;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for peer ${sessionId} to become idle`);
      }
      await delay(this.pollIntervalMs);
    }
  }

  private async syncPeerFromRuntime(name: string): Promise<BridgePeer> {
    const peer = this.requirePeer(name);
    const status = await this.runtime.status(peer.sessionId);
    if (!status) {
      const next: BridgePeer = {
        ...peer,
        state: "disconnected",
        updatedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      };
      this.peers.set(name, next);
      return next;
    }
    const next = this.peerFromStatus(name, status, mapRuntimeState(status.state, true));
    this.peers.set(name, next);
    return next;
  }

  private peerFromStatus(name: string, status: RuntimeStatus, state: BridgeState): BridgePeer {
    return {
      name,
      sessionId: status.sessionId,
      cwd: status.cwd,
      model: status.model,
      state,
      createdAt: status.createdAt,
      updatedAt: status.updatedAt,
      lastActivityAt: status.lastActivityAt,
    };
  }

  private requirePeer(name: string): BridgePeer {
    const peer = this.peers.get(name);
    if (!peer) {
      throw new Error(`Unknown peer ${name}`);
    }
    return peer;
  }

  private assertPeerNameAvailable(name: string): void {
    if (this.peers.has(name)) {
      throw new Error(`Peer name ${name} already registered`);
    }
  }
}

function mergeSystemPrompt(appendSystemPrompt?: string): string {
  return appendSystemPrompt ? `${appendSystemPrompt}\n\n${BRIDGE_SYSTEM_PROMPT}` : BRIDGE_SYSTEM_PROMPT;
}

function formatInboundMessage(message: IntercomInboundMessage): string {
  const header = [
    `kind=${message.kind}`,
    `from=${message.from}`,
    message.replyTo ? `replyTo=${message.replyTo}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  return [`[intercom ${header}]`, message.text].join("\n\n");
}

function extractReplyText(events: RuntimeEvent[]): string {
  const assistantBlocks = events
    .filter((event): event is Extract<RuntimeEvent, { type: "message" }> => event.type === "message" && event.role === "assistant")
    .flatMap((event) => event.message.blocks)
    .map(blockToText)
    .filter((value): value is string => Boolean(value && value.trim()));

  if (assistantBlocks.length > 0) {
    return assistantBlocks.join("\n\n").trim();
  }

  const result = [...events]
    .reverse()
    .find((event): event is Extract<RuntimeEvent, { type: "result" }> => event.type === "result");
  return result?.summary ?? "";
}

function blockToText(block: RuntimeMessageBlock): string | undefined {
  if (typeof block.text === "string") {
    return block.text;
  }
  if (block.type === "thinking" && typeof (block.raw as { thinking?: unknown } | undefined)?.thinking === "string") {
    return String((block.raw as { thinking: string }).thinking);
  }
  return undefined;
}

function mapRuntimeState(state: RuntimeStatus["state"], registered: boolean): BridgeState {
  switch (state) {
    case "starting":
      return registered ? "starting" : "connected";
    case "running":
      return "busy";
    case "idle":
      return "idle";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "failed":
      return "errored";
    default:
      return "connected";
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export { BRIDGE_SYSTEM_PROMPT, extractReplyText, formatInboundMessage, mapRuntimeState };
