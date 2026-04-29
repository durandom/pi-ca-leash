import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverEventEnvelope, RuntimeDriver, RuntimeDriverRunHandle, RuntimeDriverRunInput } from "@pi-claude-code-agent/runtime";
import { ClaudeCodeRuntime } from "@pi-claude-code-agent/runtime";
import {
  ClaudeRuntimeIntercomBridge,
  extractReplyText,
  formatInboundMessage,
  type BridgeTransport,
  type BridgeTransportIncomingMessage,
  type BridgeTransportOutgoingMessage,
  type BridgeTransportSessionInfo,
} from "../src/index.js";

class FakeDriver implements RuntimeDriver {
  readonly name = "claude-sdk" as const;

  run(input: RuntimeDriverRunInput, onEvent: (event: DriverEventEnvelope) => Promise<void> | void): RuntimeDriverRunHandle {
    let interrupted = false;
    const done = (async () => {
      await onEvent({ type: "raw", payload: { type: "system", subtype: "init", session_id: input.resumeSessionId ?? input.sessionId, model: input.model ?? "fake-model" } });
      await onEvent({
        type: "raw",
        payload: {
          type: "assistant",
          message: {
            content: [{ type: "text", text: `reply:${input.prompt}` }],
          },
        },
      });
      await onEvent({
        type: "raw",
        payload: {
          type: "result",
          is_error: false,
          result: `done:${input.prompt}`,
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 2 },
        },
      });
      return { code: interrupted ? 130 : 0, signal: interrupted ? "SIGINT" : null } as const;
    })();

    return {
      kill() {
        interrupted = true;
      },
      done,
    };
  }
}

class FakeTransport implements BridgeTransport {
  readonly registrations = new Map<string, { onMessage: (message: BridgeTransportIncomingMessage) => Promise<void> | void }>();
  readonly sent: Array<{ peerName: string; to: string; message: BridgeTransportOutgoingMessage }> = [];
  readonly unregistered: string[] = [];

  async registerPeer(peer: { name: string }, onMessage: (message: BridgeTransportIncomingMessage) => Promise<void> | void): Promise<void> {
    this.registrations.set(peer.name, { onMessage });
  }

  async updatePeer(): Promise<void> {
    // no-op
  }

  async unregisterPeer(name: string): Promise<void> {
    this.unregistered.push(name);
    this.registrations.delete(name);
  }

  async sendFromPeer(peerName: string, to: string, message: BridgeTransportOutgoingMessage): Promise<void> {
    this.sent.push({ peerName, to, message });
  }

  async listSessions(): Promise<BridgeTransportSessionInfo[]> {
    return [];
  }

  async deliver(name: string, message: BridgeTransportIncomingMessage): Promise<void> {
    const registration = this.registrations.get(name);
    assert.ok(registration, `Expected transport registration for ${name}`);
    await registration.onMessage(message);
  }
}

test("launch registers peer and ask waits for idle-cycle reply", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir, driver: new FakeDriver() });
  const bridge = new ClaudeRuntimeIntercomBridge({ runtime, pollIntervalMs: 5, askTimeoutMs: 2_000 });

  const peer = await bridge.launchPeer({ name: "worker", prompt: "boot" });
  assert.equal(peer.name, "worker");
  assert.equal(peer.state, "idle");

  const result = await bridge.ask("worker", { from: "planner", text: "status?" });
  assert.equal(result.peer.state, "idle");
  assert.match(result.reply, /reply:\[intercom kind=ask from=planner\]/);
});

test("send and reply both route through runtime send", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir, driver: new FakeDriver() });
  const bridge = new ClaudeRuntimeIntercomBridge({ runtime, pollIntervalMs: 5, askTimeoutMs: 2_000 });

  await bridge.launchPeer({ name: "worker", prompt: "boot" });
  const afterSend = await bridge.send("worker", { from: "alice", text: "hello" });
  assert.equal(afterSend.state, "idle");

  const afterReply = await bridge.reply("worker", { from: "alice", text: "ack", replyTo: "msg-1" });
  assert.equal(afterReply.state, "idle");

  const events = await runtime.events(afterReply.sessionId);
  assert.equal(events.items.filter((event) => event.type === "result").length, 3);
});

test("transport registers peer and inbound ask auto-replies", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver: new FakeDriver() });
  const transport = new FakeTransport();
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtime,
    storageDir: join(storageDir, "bridge"),
    transport,
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });

  await bridge.launchPeer({ name: "worker", prompt: "boot" });
  assert.equal(transport.registrations.has("worker"), true);

  await transport.deliver("worker", {
    id: "msg-1",
    timestamp: Date.now(),
    expectsReply: true,
    text: "status?",
    from: {
      id: "planner-id",
      name: "planner",
      cwd: "/tmp/planner",
      model: "planner-model",
      pid: 123,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    },
  });

  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0]?.peerName, "worker");
  assert.equal(transport.sent[0]?.to, "planner-id");
  assert.equal(transport.sent[0]?.message.replyTo, "msg-1");
  assert.match(transport.sent[0]?.message.text ?? "", /reply:\[intercom kind=ask from=planner\]/);
});

test("restorePeers reattaches persisted peers", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver: new FakeDriver() });

  const bridge1 = new ClaudeRuntimeIntercomBridge({
    runtime,
    storageDir: join(storageDir, "bridge"),
    transport: new FakeTransport(),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });
  const peer = await bridge1.launchPeer({ name: "worker", prompt: "boot" });
  assert.equal(peer.state, "idle");

  const bridge2 = new ClaudeRuntimeIntercomBridge({
    runtime,
    storageDir: join(storageDir, "bridge"),
    transport: new FakeTransport(),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });

  const restored = await bridge2.restorePeers();
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.name, "worker");

  const listed = await bridge2.listPeers();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.name, "worker");
});

test("setTransport late-binds existing peers", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver: new FakeDriver() });
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtime,
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });

  await bridge.launchPeer({ name: "worker", prompt: "boot" });
  const transport = new FakeTransport();
  await bridge.setTransport(transport);

  assert.equal(transport.registrations.has("worker"), true);
});

test("helper formatting extracts last assistant text", () => {
  const inbound = formatInboundMessage({ kind: "ask", from: "planner", text: "hi", replyTo: "msg-1" });
  assert.match(inbound, /^\[intercom kind=ask from=planner replyTo=msg-1\]/);

  const reply = extractReplyText([
    {
      id: "1",
      sessionId: "sid",
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: "message",
      role: "assistant",
      message: {
        role: "assistant",
        blocks: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
      },
    },
  ]);
  assert.equal(reply, "first\n\nsecond");
});
