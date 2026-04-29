import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net, { type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  BridgePeer,
  BridgeTransport,
  BridgeTransportIncomingMessage,
  BridgeTransportOutgoingMessage,
  BridgeTransportSessionInfo,
  BridgeTransportStatus,
} from "./types.js";

type BrokerClientMessage =
  | { type: "register"; session: Omit<BridgeTransportSessionInfo, "id"> }
  | { type: "unregister" }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: BrokerMessagePayload }
  | { type: "presence"; name?: string; status?: string; model?: string };

type BrokerServerMessage =
  | { type: "registered"; sessionId: string }
  | { type: "sessions"; requestId: string; sessions: BridgeTransportSessionInfo[] }
  | { type: "message"; from: BridgeTransportSessionInfo; message: BrokerMessagePayload }
  | { type: "delivered"; messageId: string }
  | { type: "delivery_failed"; messageId: string; reason: string }
  | { type: "error"; error: string };

interface BrokerMessagePayload {
  id: string;
  timestamp: number;
  replyTo?: string;
  expectsReply?: boolean;
  content: {
    text: string;
    attachments?: BridgeTransportIncomingMessage["attachments"];
  };
}

interface ClientSendResult {
  id: string;
  delivered: boolean;
  reason?: string;
}

function sanitizePipeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "default";
}

function getBrokerSocketPath(): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\pi-intercom-${sanitizePipeSegment(homedir())}`;
  }
  return join(homedir(), ".pi/agent/intercom/broker.sock");
}

function writeMessage(socket: Socket, message: BrokerClientMessage): void {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
}

function createMessageReader(onMessage: (message: BrokerServerMessage) => void, onError: (error: Error) => void) {
  let buffer = Buffer.alloc(0);
  return (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) {
        return;
      }
      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      try {
        onMessage(JSON.parse(payload.toString("utf8")) as BrokerServerMessage);
      } catch (error) {
        onError(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  };
}

class IntercomBrokerClient extends EventEmitter {
  private socket: Socket | null = null;
  private sessionId: string | null = null;
  private pendingSends = new Map<string, { resolve: (result: ClientSendResult) => void; reject: (error: Error) => void }>();
  private pendingLists = new Map<string, { resolve: (sessions: BridgeTransportSessionInfo[]) => void; reject: (error: Error) => void }>();

  get connected(): boolean {
    return Boolean(this.socket && this.sessionId && !this.socket.destroyed && !this.socket.writableEnded && this.socket.writable);
  }

  async connect(session: Omit<BridgeTransportSessionInfo, "id">): Promise<void> {
    if (this.socket) {
      throw new Error("Already connected");
    }

    const socket = net.connect(getBrokerSocketPath());
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        socket.destroy();
        reject(new Error("Intercom broker connection timeout"));
      }, 5_000);

      const cleanup = () => {
        clearTimeout(timeout);
        socket.off("error", onError);
        socket.off("close", onClose);
        this.off("registered", onRegistered);
      };

      const onError = (error: Error) => {
        cleanup();
        this.socket = null;
        reject(error);
      };

      const onClose = () => {
        cleanup();
        this.socket = null;
        this.sessionId = null;
        reject(new Error("Intercom broker closed before registration"));
      };

      const onRegistered = () => {
        cleanup();
        resolve();
      };

      const reader = createMessageReader(
        (message) => this.handleMessage(message),
        (error) => socket.destroy(error),
      );

      socket.on("data", reader);
      socket.once("error", onError);
      socket.once("close", onClose);
      this.once("registered", onRegistered);

      writeMessage(socket, { type: "register", session });
    });

    socket.on("error", (error) => this.emit("error", error));
    socket.on("close", () => {
      this.socket = null;
      this.sessionId = null;
      this.emit("disconnected");
    });
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.rejectPending(new Error("Intercom client disconnected"));
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      try {
        writeMessage(socket, { type: "unregister" });
        socket.end();
      } catch {
        socket.destroy();
        resolve();
      }
    });
  }

  async listSessions(): Promise<BridgeTransportSessionInfo[]> {
    const socket = this.requireSocket();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingLists.delete(requestId);
        reject(new Error("Intercom list timeout"));
      }, 5_000);
      this.pendingLists.set(requestId, {
        resolve: (sessions) => {
          clearTimeout(timeout);
          resolve(sessions);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      writeMessage(socket, { type: "list", requestId });
    });
  }

  async send(to: string, message: BridgeTransportOutgoingMessage): Promise<ClientSendResult> {
    const socket = this.requireSocket();
    const messageId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingSends.delete(messageId);
        reject(new Error("Intercom send timeout"));
      }, 10_000);
      this.pendingSends.set(messageId, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      writeMessage(socket, {
        type: "send",
        to,
        message: {
          id: messageId,
          timestamp: Date.now(),
          replyTo: message.replyTo,
          expectsReply: message.expectsReply,
          content: {
            text: message.text,
            attachments: message.attachments,
          },
        },
      });
    });
  }

  updatePresence(input: { name?: string; status?: string; model?: string }): void {
    const socket = this.socket;
    if (!socket || !this.sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return;
    }
    writeMessage(socket, { type: "presence", ...input });
  }

  private requireSocket(): Socket {
    if (!this.connected || !this.socket) {
      throw new Error("Intercom broker not connected");
    }
    return this.socket;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingSends.values()) {
      pending.reject(error);
    }
    this.pendingSends.clear();
    for (const pending of this.pendingLists.values()) {
      pending.reject(error);
    }
    this.pendingLists.clear();
  }

  private handleMessage(message: BrokerServerMessage): void {
    switch (message.type) {
      case "registered":
        this.sessionId = message.sessionId;
        this.emit("registered", message.sessionId);
        return;
      case "sessions": {
        const pending = this.pendingLists.get(message.requestId);
        if (!pending) {
          return;
        }
        this.pendingLists.delete(message.requestId);
        pending.resolve(message.sessions);
        return;
      }
      case "message":
        this.emit("message", {
          id: message.message.id,
          timestamp: message.message.timestamp,
          replyTo: message.message.replyTo,
          expectsReply: message.message.expectsReply,
          text: message.message.content.text,
          attachments: message.message.content.attachments,
          from: message.from,
        } satisfies BridgeTransportIncomingMessage);
        return;
      case "delivered": {
        const pending = this.pendingSends.get(message.messageId);
        if (!pending) {
          return;
        }
        this.pendingSends.delete(message.messageId);
        pending.resolve({ id: message.messageId, delivered: true });
        return;
      }
      case "delivery_failed": {
        const pending = this.pendingSends.get(message.messageId);
        if (!pending) {
          return;
        }
        this.pendingSends.delete(message.messageId);
        pending.resolve({ id: message.messageId, delivered: false, reason: message.reason });
        return;
      }
      case "error":
        this.emit("error", new Error(message.error));
        return;
      default:
        return;
    }
  }
}

export class PiIntercomTransport implements BridgeTransport {
  private readonly clients = new Map<string, { client: IntercomBrokerClient; peer: BridgePeer }>();

  static async canConnect(timeoutMs = 500): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect(getBrokerSocketPath());
      const finish = (ok: boolean) => {
        clearTimeout(timeout);
        socket.off("connect", onConnect);
        socket.off("error", onError);
        resolve(ok);
      };
      const onConnect = () => {
        socket.end();
        finish(true);
      };
      const onError = () => {
        socket.destroy();
        finish(false);
      };
      socket.once("connect", onConnect);
      socket.once("error", onError);
      const timeout = setTimeout(() => {
        socket.destroy();
        finish(false);
      }, timeoutMs);
    });
  }

  async registerPeer(peer: BridgePeer, onMessage: (message: BridgeTransportIncomingMessage) => Promise<void> | void): Promise<void> {
    await this.unregisterPeer(peer.name);

    const client = new IntercomBrokerClient();
    client.on("message", async (message: BridgeTransportIncomingMessage) => {
      await onMessage(message);
    });
    client.on("error", () => {
      // Keep transport errors out of stdout; caller sees missing broker on next operation.
    });
    await client.connect(buildSessionInfo(peer));
    this.clients.set(peer.name, { client, peer });
  }

  async updatePeer(peer: BridgePeer): Promise<void> {
    const entry = this.clients.get(peer.name);
    if (!entry) {
      return;
    }
    entry.peer = peer;
    entry.client.updatePresence({
      name: peer.name,
      model: peer.model,
      status: peer.state,
    });
  }

  async unregisterPeer(name: string): Promise<void> {
    const entry = this.clients.get(name);
    if (!entry) {
      return;
    }
    this.clients.delete(name);
    await entry.client.disconnect();
  }

  async sendFromPeer(peerName: string, to: string, message: BridgeTransportOutgoingMessage): Promise<void> {
    const entry = this.clients.get(peerName);
    if (!entry) {
      throw new Error(`Peer ${peerName} not connected to intercom transport`);
    }
    const result = await entry.client.send(to, message);
    if (!result.delivered) {
      throw new Error(result.reason ?? `Failed to deliver message from ${peerName} to ${to}`);
    }
  }

  async listSessions(): Promise<BridgeTransportSessionInfo[]> {
    const first = this.clients.values().next().value as { client: IntercomBrokerClient } | undefined;
    if (!first) {
      return [];
    }
    return first.client.listSessions();
  }

  getStatus(): BridgeTransportStatus {
    const entries = [...this.clients.values()];
    return {
      kind: "pi-intercom",
      boundPeers: entries.length,
      connectedPeers: entries.filter((entry) => entry.client.connected).length,
    };
  }

  async close(): Promise<void> {
    for (const name of [...this.clients.keys()]) {
      await this.unregisterPeer(name);
    }
  }
}

function buildSessionInfo(peer: BridgePeer): Omit<BridgeTransportSessionInfo, "id"> {
  const now = Date.now();
  return {
    name: peer.name,
    cwd: peer.cwd,
    model: peer.model ?? "claude-code-agent",
    pid: process.pid,
    startedAt: now,
    lastActivity: now,
    status: peer.state,
  };
}
