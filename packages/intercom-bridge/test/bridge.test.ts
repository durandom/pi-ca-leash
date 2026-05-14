import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverEventEnvelope, RuntimeDriver, RuntimeDriverRunHandle, RuntimeDriverRunInput } from "@pi-claude-code-agent/runtime";
import { ClaudeCodeRuntime } from "@pi-claude-code-agent/runtime";
import {
  ClaudeRuntimeIntercomBridge,
  PiCaLeashManagedPeerApi,
  extractLatestReplyText,
  extractReplyText,
  formatInboundMessage,
  piCaLeashBridgeStorageDir,
  piCaLeashRuntimeStorageDir,
  type BridgeTransport,
  type BridgeTransportIncomingMessage,
  type BridgeTransportOutgoingMessage,
  type BridgeTransportSessionInfo,
} from "../src/index.js";

class FakeDriver implements RuntimeDriver {
  readonly name = "claude-sdk" as const;
  readonly runs: RuntimeDriverRunInput[] = [];

  run(input: RuntimeDriverRunInput, onEvent: (event: DriverEventEnvelope) => Promise<void> | void): RuntimeDriverRunHandle {
    this.runs.push(input);
    let interrupted = false;
    const done = (async () => {
      await onEvent({
        type: "message",
        payload: {
          type: "system",
          subtype: "init",
          sessionId: input.resumeSessionId ?? input.sessionId,
          model: input.model ?? "fake-model",
          raw: { type: "system", subtype: "init", session_id: input.resumeSessionId ?? input.sessionId, model: input.model ?? "fake-model" },
        },
      });
      if (input.prompt.includes("use-tool")) {
        await onEvent({
          type: "message",
          payload: {
            type: "assistant",
            blocks: [
              { type: "thinking", text: "secret plan", raw: { type: "thinking", thinking: "secret plan" } },
              { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" }, raw: { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } } },
              { type: "text", text: `visible:${input.prompt}`, raw: { type: "text", text: `visible:${input.prompt}` } },
            ],
            raw: {
              type: "assistant",
              message: {
                content: [
                  { type: "thinking", thinking: "secret plan" },
                  { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
                  { type: "text", text: `visible:${input.prompt}` },
                ],
              },
            },
          },
        });
        await onEvent({
          type: "message",
          payload: {
            type: "tool_use",
            toolName: "Bash",
            toolUseId: "tool-1",
            input: { command: "pwd" },
            raw: { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
          },
        });
        await onEvent({
          type: "message",
          payload: {
            type: "tool_result",
            role: "user",
            blocks: [{
              type: "tool_result",
              content: "/tmp/demo",
              isError: false,
              raw: { type: "tool_result", tool_use_id: "tool-1", content: "/tmp/demo", is_error: false },
            }],
            toolName: "Bash",
            toolUseId: "tool-1",
            output: { tool_name: "Bash", stdout: "/tmp/demo" },
            isError: false,
            raw: {
              type: "user",
              message: {
                content: [{ type: "tool_result", tool_use_id: "tool-1", content: "/tmp/demo", is_error: false }],
              },
              tool_use_result: { tool_name: "Bash", stdout: "/tmp/demo" },
            },
          },
        });
      } else {
        await onEvent({
          type: "message",
          payload: {
            type: "assistant",
            blocks: [{ type: "text", text: `reply:${input.prompt}`, raw: { type: "text", text: `reply:${input.prompt}` } }],
            raw: {
              type: "assistant",
              message: {
                content: [{ type: "text", text: `reply:${input.prompt}` }],
              },
            },
          },
        });
      }
      await onEvent({
        type: "message",
        payload: {
          type: "result",
          ok: true,
          summary: `done:${input.prompt}`,
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 2, raw: { input_tokens: 1, output_tokens: 2 } },
          raw: {
            type: "result",
            is_error: false,
            result: `done:${input.prompt}`,
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 2 },
          },
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

class SlowDriver implements RuntimeDriver {
  readonly name = "claude-sdk" as const;

  run(input: RuntimeDriverRunInput, onEvent: (event: DriverEventEnvelope) => Promise<void> | void): RuntimeDriverRunHandle {
    let interrupted = false;
    const done = (async () => {
      await onEvent({
        type: "message",
        payload: {
          type: "system",
          subtype: "init",
          sessionId: input.resumeSessionId ?? input.sessionId,
          model: input.model ?? "fake-model",
          raw: { type: "system", subtype: "init", session_id: input.resumeSessionId ?? input.sessionId, model: input.model ?? "fake-model" },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (!interrupted) {
        await onEvent({
          type: "message",
          payload: {
            type: "assistant",
            blocks: [{ type: "text", text: `reply:${input.prompt}`, raw: { type: "text", text: `reply:${input.prompt}` } }],
            raw: { type: "assistant", message: { content: [{ type: "text", text: `reply:${input.prompt}` }] } },
          },
        });
        await onEvent({
          type: "message",
          payload: {
            type: "result",
            ok: true,
            summary: `done:${input.prompt}`,
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 2, raw: { input_tokens: 1, output_tokens: 2 } },
            raw: {
              type: "result",
              is_error: false,
              result: `done:${input.prompt}`,
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 2 },
            },
          },
        });
      }
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

class SlowResumeDriver extends FakeDriver {
  override run(input: RuntimeDriverRunInput, onEvent: (event: DriverEventEnvelope) => Promise<void> | void): RuntimeDriverRunHandle {
    if (!input.resumeSessionId) {
      return super.run(input, onEvent);
    }
    return new SlowDriver().run(input, onEvent);
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
  const driver = new FakeDriver();
  const runtime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver });
  const bridge = new ClaudeRuntimeIntercomBridge({ runtime, storageDir: join(storageDir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 2_000 });

  const peer = await bridge.launchPeer({ name: "worker", prompt: "boot", driver: "claude-sdk", cwd: "/tmp/worker", model: "model-a" });
  assert.equal(peer.name, "worker");
  assert.equal(peer.state, "idle");
  assert.equal(peer.cwd, "/tmp/worker");
  assert.equal(peer.model, "model-a");
  assert.equal(peer.driver, "claude-sdk");

  const result = await bridge.ask("worker", { from: "planner", text: "status?", model: "model-b" });
  assert.equal(result.peer.state, "idle");
  assert.equal(result.peer.model, "model-b");
  assert.match(result.reply, /reply:\[intercom kind=ask from=planner\]/);

  const followUp = await bridge.ask("worker", { from: "planner", text: "status again?" });
  assert.equal(followUp.peer.model, "model-b");

  assert.equal(driver.runs[0]?.cwd, "/tmp/worker");
  assert.equal(driver.runs[0]?.model, "model-a");
  assert.equal(driver.runs[1]?.model, "model-b");
  assert.equal(driver.runs[2]?.model, "model-b");
});

test("launch can return before idle when requested", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver: new SlowDriver() });
  const bridge = new ClaudeRuntimeIntercomBridge({ runtime, storageDir: join(storageDir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 20 });

  const started = Date.now();
  const peer = await bridge.launchPeer({ name: "worker", prompt: "boot", waitForIdle: false });
  assert.ok(Date.now() - started < 60);
  assert.ok(["starting", "busy", "idle"].includes(peer.state));

  await new Promise((resolve) => setTimeout(resolve, 120));
  const settled = await bridge.status("worker");
  assert.equal(settled?.state, "idle");
});

test("ask timeout returns delivered_and_running instead of throwing after delivery", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver: new SlowResumeDriver() });
  const bridge = new ClaudeRuntimeIntercomBridge({ runtime, storageDir: join(storageDir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 10 });

  await bridge.launchPeer({ name: "worker", prompt: "boot", driver: "claude-sdk" });
  const result = await bridge.ask("worker", { from: "planner", text: "slow follow-up" });

  assert.equal(result.deliveryState, "delivered_and_running");
  assert.equal(result.reply, "");
  assert.equal(result.peer.state, "busy");
});

test("send can deliver fire-and-forget without waiting for idle", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver: new SlowResumeDriver() });
  const bridge = new ClaudeRuntimeIntercomBridge({ runtime, storageDir: join(storageDir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 10 });

  await bridge.launchPeer({ name: "worker", prompt: "boot", driver: "claude-sdk" });
  const started = Date.now();
  const peer = await bridge.send("worker", { from: "planner", text: "slow send" }, { waitForIdle: false });

  assert.ok(Date.now() - started < 60);
  assert.equal(peer.state, "busy");
});

test("send waits through `starting` window instead of throwing", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver: new SlowDriver() });
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtime,
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 5_000,
  });

  // Launch fire-and-forget. SlowDriver holds the peer in `starting` for ~80ms.
  const launched = await bridge.launchPeer({ name: "worker", prompt: "boot", waitForIdle: false });
  assert.ok(["starting", "busy"].includes(launched.state));

  // A concurrent send must wait through the bootstrap window rather than
  // throw "busy". By the time it returns, the peer has completed both runs.
  const result = await bridge.send("worker", { from: "planner", text: "follow-up" });
  assert.equal(result.state, "idle");
});

test("send to a genuinely busy peer throws PEER_BUSY with code", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver: new SlowResumeDriver() });
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtime,
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 50,
  });

  await bridge.launchPeer({ name: "worker", prompt: "boot", driver: "claude-sdk" });
  // SlowResumeDriver makes the resume slow; first fire-and-forget flips peer to busy.
  await bridge.send("worker", { from: "planner", text: "slow" }, { waitForIdle: false });

  await assert.rejects(
    () => bridge.send("worker", { from: "planner", text: "second" }, { waitForIdle: false }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PEER_BUSY");
      assert.match((err as Error).message, /busy executing a prior message/);
      return true;
    },
  );
});

test("send during `starting` surfaces PEER_STARTING_TIMEOUT when timeout elapses", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver: new SlowDriver() });
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtime,
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 5_000,
  });

  await bridge.launchPeer({ name: "worker", prompt: "boot", waitForIdle: false });
  // SlowDriver takes ~80ms; ask with timeoutMs=20 forces the starting-window wait to expire.
  await assert.rejects(
    () => bridge.ask("worker", { from: "planner", text: "follow-up", timeoutMs: 20 }),
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "PEER_STARTING_TIMEOUT");
      return true;
    },
  );
});

test("interrupt signals a busy peer and keeps it registered", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver: new SlowResumeDriver() });
  const bridge = new ClaudeRuntimeIntercomBridge({ runtime, storageDir: join(storageDir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 10 });

  await bridge.launchPeer({ name: "worker", prompt: "boot", driver: "claude-sdk" });
  await bridge.send("worker", { from: "planner", text: "slow send" }, { waitForIdle: false });
  const interrupted = await bridge.interrupt("worker");

  assert.equal(interrupted.name, "worker");
  assert.equal(["busy", "interrupted"].includes(interrupted.state), true);
  assert.ok(await bridge.status("worker"));
});

test("interruptWithResult reports whether the runtime was signalled", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver: new SlowResumeDriver() });
  const bridge = new ClaudeRuntimeIntercomBridge({ runtime, storageDir: join(storageDir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 10 });

  await bridge.launchPeer({ name: "worker", prompt: "boot", driver: "claude-sdk" });

  const idleResult = await bridge.interruptWithResult("worker");
  assert.equal(idleResult.peer.name, "worker");
  assert.equal(idleResult.interrupt.interrupted, false);
  assert.equal(idleResult.interrupt.reason, "no-active-run");

  await bridge.send("worker", { from: "planner", text: "slow send" }, { waitForIdle: false });
  const busyResult = await bridge.interruptWithResult("worker");

  assert.equal(busyResult.peer.name, "worker");
  assert.equal(busyResult.interrupt.interrupted, true);
  assert.equal(busyResult.interrupt.reason, "signalled");
  assert.equal(busyResult.interrupt.signal, "SIGINT");
  assert.equal(["busy", "interrupted"].includes(busyResult.peer.state), true);
});

test("send and reply both route through runtime send", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver: new FakeDriver() });
  const bridge = new ClaudeRuntimeIntercomBridge({ runtime, storageDir: join(storageDir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 2_000 });

  await bridge.launchPeer({ name: "worker", prompt: "boot" });
  const afterSend = await bridge.send("worker", { from: "alice", text: "hello" });
  assert.equal(afterSend.state, "idle");

  const afterReply = await bridge.reply("worker", { from: "alice", text: "ack", replyTo: "msg-1" });
  assert.equal(afterReply.state, "idle");

  const events = await runtime.events(afterReply.sessionId);
  assert.equal(events.items.filter((event) => event.type === "result").length, 3);
});

test("two peers stay isolated while replies ignore thinking and tool traffic", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver: new FakeDriver() });
  const bridge = new ClaudeRuntimeIntercomBridge({ runtime, storageDir: join(storageDir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 2_000 });

  const alpha = await bridge.launchPeer({ name: "alpha", prompt: "boot alpha" });
  const beta = await bridge.launchPeer({ name: "beta", prompt: "boot beta" });

  const alphaAsk1 = await bridge.ask("alpha", { from: "planner", text: "use-tool alpha status" });
  assert.equal(alphaAsk1.peer.state, "idle");
  assert.equal(alphaAsk1.peer.sessionId, alpha.sessionId);
  assert.match(alphaAsk1.reply, /visible:\[intercom kind=ask from=planner\]\n\nuse-tool alpha status/);
  assert.doesNotMatch(alphaAsk1.reply, /secret plan/);
  assert.doesNotMatch(alphaAsk1.reply, /\/tmp\/demo/);
  assert.equal(alphaAsk1.events.filter((event) => event.type === "tool").length, 2);

  const betaAsk = await bridge.ask("beta", { from: "planner", text: "plain beta status" });
  assert.equal(betaAsk.peer.state, "idle");
  assert.equal(betaAsk.peer.sessionId, beta.sessionId);
  assert.match(betaAsk.reply, /reply:\[intercom kind=ask from=planner\]\n\nplain beta status/);
  assert.doesNotMatch(betaAsk.reply, /alpha status/);

  const alphaAsk2 = await bridge.ask("alpha", { from: "planner", text: "plain alpha follow-up" });
  assert.equal(alphaAsk2.peer.sessionId, alpha.sessionId);
  assert.match(alphaAsk2.reply, /reply:\[intercom kind=ask from=planner\]\n\nplain alpha follow-up/);

  const peers = await bridge.listPeers();
  assert.deepEqual(peers.map((peer) => [peer.name, peer.state]), [["alpha", "idle"], ["beta", "idle"]]);
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

test("restorePeers preserves managed metadata", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver: new FakeDriver() });

  const bridge1 = new ClaudeRuntimeIntercomBridge({
    runtime,
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });
  await bridge1.launchPeer({
    name: "worker",
    prompt: "boot",
    kind: "managed",
    metadata: { owner: "castra", persona: "atlas" },
  });

  const bridge2 = new ClaudeRuntimeIntercomBridge({
    runtime,
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });

  const restored = await bridge2.restorePeers();
  assert.equal(restored[0]?.kind, "managed");
  assert.deepEqual(restored[0]?.metadata, { owner: "castra", persona: "atlas" });
});

test("listPeers reconciles externally created peers without restart", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver: new FakeDriver() });

  const dashboardBridge = new ClaudeRuntimeIntercomBridge({
    runtime,
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });
  assert.equal((await dashboardBridge.listPeers()).length, 0);

  const externalBridge = new ClaudeRuntimeIntercomBridge({
    runtime,
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });
  await externalBridge.launchPeer({
    name: "worker",
    prompt: "boot",
    kind: "managed",
    metadata: { owner: "castra", cycleId: "cycle-1" },
  });

  const listed = await dashboardBridge.listPeers();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.name, "worker");
  assert.equal(listed[0]?.kind, "managed");
  assert.deepEqual(listed[0]?.metadata, { cycleId: "cycle-1", owner: "castra" });
  assert.equal((await dashboardBridge.status("worker"))?.sessionId, listed[0]?.sessionId);
});

test("stop restores externally listed peers before stopping", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver: new FakeDriver() });

  const externalBridge = new ClaudeRuntimeIntercomBridge({
    runtime,
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });
  await externalBridge.launchPeer({
    name: "worker",
    prompt: "boot",
    kind: "managed",
    metadata: { owner: "castra" },
  });

  const commandBridge = new ClaudeRuntimeIntercomBridge({
    runtime,
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });

  const stopped = await commandBridge.stop("worker");
  assert.equal(stopped.name, "worker");
  assert.equal(stopped.state, "stopped");
  assert.equal((await commandBridge.listPeers()).length, 0);
});

test("PiCaLeashManagedPeerApi uses shared pi-ca-leash state paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ca-leash-managed-peer-api-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: piCaLeashRuntimeStorageDir(cwd), driver: new FakeDriver() });
  const api = new PiCaLeashManagedPeerApi({
    cwd,
    runtime,
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });

  const peer = await api.launchPeer({
    name: "worker",
    prompt: "boot",
    metadata: { owner: "castra" },
  });
  assert.equal(peer.kind, "managed");
  assert.equal(peer.sessionId.length > 0, true);

  const bridge = new ClaudeRuntimeIntercomBridge({
    runtime,
    storageDir: piCaLeashBridgeStorageDir(cwd),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });
  const listed = await bridge.listPeers();
  assert.equal(listed[0]?.name, "worker");
  assert.equal(listed[0]?.kind, "managed");
  assert.deepEqual(listed[0]?.metadata, { owner: "castra" });
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

test("helper formatting extracts visible assistant text only", () => {
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
        blocks: [
          { type: "thinking", text: "secret plan", raw: { thinking: "secret plan" } },
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
    },
  ]);
  assert.equal(reply, "first\n\nsecond");
});

test("helper formatting falls back to result summary when assistant text is only thinking", () => {
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
        blocks: [{ type: "thinking", text: "secret plan", raw: { thinking: "secret plan" } }],
      },
    },
    {
      id: "2",
      sessionId: "sid",
      sequence: 2,
      timestamp: new Date().toISOString(),
      type: "result",
      ok: true,
      summary: "done without visible reply",
      raw: {},
    },
  ]);

  assert.equal(reply, "done without visible reply");
});

test("latest reply extraction returns only the last visible assistant message", () => {
  const timestamp = new Date().toISOString();
  const reply = extractLatestReplyText([
    {
      id: "1",
      sessionId: "sid",
      sequence: 1,
      timestamp,
      type: "message",
      role: "assistant",
      message: {
        role: "assistant",
        blocks: [{ type: "text", text: "Ready." }],
      },
    },
    {
      id: "2",
      sessionId: "sid",
      sequence: 2,
      timestamp,
      type: "result",
      ok: true,
      summary: "done:ready",
      raw: {},
    },
    {
      id: "3",
      sessionId: "sid",
      sequence: 3,
      timestamp,
      type: "message",
      role: "assistant",
      message: {
        role: "assistant",
        blocks: [
          { type: "thinking", text: "secret plan", raw: { thinking: "secret plan" } },
          { type: "text", text: "final-only" },
        ],
      },
    },
  ]);

  assert.equal(reply, "final-only");
});
