import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverEventEnvelope, RuntimeDriver, RuntimeDriverRunHandle, RuntimeDriverRunInput } from "@pi-claude-code-agent/runtime";
import {
  ClaudeRuntimeIntercomBridge,
  PiCaLeashManagedPeerApi,
  WaitCompletionError,
  defaultStaleThresholdMsForDriver,
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
import type { RuntimeDriverName } from "@pi-claude-code-agent/runtime";

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
    const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver },
    storageDir: join(storageDir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 2_000 });

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
    const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new SlowDriver() },
    storageDir: join(storageDir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 20 });

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
    const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new SlowResumeDriver() },
    storageDir: join(storageDir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 10 });

  await bridge.launchPeer({ name: "worker", prompt: "boot", driver: "claude-sdk" });
  const result = await bridge.ask("worker", { from: "planner", text: "slow follow-up" });

  assert.equal(result.deliveryState, "delivered_and_running");
  assert.equal(result.reply, "");
  assert.equal(result.peer.state, "busy");
});

test("send can deliver fire-and-forget without waiting for idle", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
    const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new SlowResumeDriver() },
    storageDir: join(storageDir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 10 });

  await bridge.launchPeer({ name: "worker", prompt: "boot", driver: "claude-sdk" });
  const started = Date.now();
  const peer = await bridge.send("worker", { from: "planner", text: "slow send" }, { waitForIdle: false });

  assert.ok(Date.now() - started < 60);
  assert.equal(peer.state, "busy");
});

test("send waits through `starting` window instead of throwing", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
    const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new SlowDriver() },
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
    const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new SlowResumeDriver() },
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
    const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new SlowDriver() },
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
    const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new SlowResumeDriver() },
    storageDir: join(storageDir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 10 });

  await bridge.launchPeer({ name: "worker", prompt: "boot", driver: "claude-sdk" });
  await bridge.send("worker", { from: "planner", text: "slow send" }, { waitForIdle: false });
  const interrupted = await bridge.interrupt("worker");

  assert.equal(interrupted.name, "worker");
  assert.equal(["busy", "interrupted"].includes(interrupted.state), true);
  assert.ok(await bridge.status("worker"));
});

test("interruptWithResult reports whether the runtime was signalled", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
    const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new SlowResumeDriver() },
    storageDir: join(storageDir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 10 });

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
    const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FakeDriver() },
    storageDir: join(storageDir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 2_000 });

  await bridge.launchPeer({ name: "worker", prompt: "boot" });
  const afterSend = await bridge.send("worker", { from: "alice", text: "hello" });
  assert.equal(afterSend.state, "idle");

  const afterReply = await bridge.reply("worker", { from: "alice", text: "ack", replyTo: "msg-1" });
  assert.equal(afterReply.state, "idle");

  const events = await bridge.events(afterReply.sessionId);
  assert.equal(events.items.filter((event) => event.type === "result").length, 3);
});

test("two peers stay isolated while replies ignore thinking and tool traffic", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
    const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FakeDriver() },
    storageDir: join(storageDir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 2_000 });

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
    const transport = new FakeTransport();
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FakeDriver() },
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
  
  const bridge1 = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FakeDriver() },
    storageDir: join(storageDir, "bridge"),
    transport: new FakeTransport(),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });
  const peer = await bridge1.launchPeer({ name: "worker", prompt: "boot" });
  assert.equal(peer.state, "idle");

  const bridge2 = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FakeDriver() },
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
  
  const bridge1 = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FakeDriver() },
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
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FakeDriver() },
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
  
  const dashboardBridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FakeDriver() },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });
  assert.equal((await dashboardBridge.listPeers()).length, 0);

  const externalBridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FakeDriver() },
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
  
  const externalBridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FakeDriver() },
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
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FakeDriver() },
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
  const api = new PiCaLeashManagedPeerApi({
    cwd,
    runtimeOptions: { driver: new FakeDriver() },
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
    runtimeOptions: { storageDir: piCaLeashRuntimeStorageDir(cwd), driver: new FakeDriver() },
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
    const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FakeDriver() },
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

test("launchPeer forwards thinkingLevel through to the driver", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const driver = new FakeDriver();
    const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });

  await bridge.launchPeer({
    name: "worker",
    prompt: "boot",
    driver: "claude-sdk",
    thinkingLevel: "high",
  });

  assert.equal(driver.runs[0]?.thinkingLevel, "high");
});

test("launchPeer omits thinkingLevel when caller does not supply one", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const driver = new FakeDriver();
    const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });

  await bridge.launchPeer({ name: "worker", prompt: "boot", driver: "claude-sdk" });

  assert.equal(driver.runs[0]?.thinkingLevel, undefined);
});

test("deliver forwards driver passthrough fields verbatim to runtime.send (regression: #8, #9)", async () => {
  // Pass-through invariant: every driver-recognised field on an outbound
  // intercom message must reach the driver's `run` call unchanged. Without
  // this, fields that depend on per-send delivery (e.g. `thinkingLevel`,
  // `appendSystemPrompt`, `env`) silently drop, and the only field that
  // is session-sticky at the runtime layer (`securityMode`) cannot be
  // overridden via the Bridge — both shapes caused #8.
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const driver = new FakeDriver();
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });

  await bridge.launchPeer({ name: "worker", prompt: "boot", driver: "claude-sdk" });
  await bridge.send("worker", {
    from: "planner",
    text: "do thing",
    securityMode: "yolo",
    thinkingLevel: "high",
    appendSystemPrompt: "EXTRA",
    env: { CASTRA_MARKER: "1" },
    model: "model-x",
  });

  // First run is the launch; second is the send we care about.
  const sendRun = driver.runs[1];
  assert.ok(sendRun, "expected a second driver run for the send");
  assert.equal(sendRun.securityMode, "yolo");
  assert.equal(sendRun.thinkingLevel, "high");
  assert.equal(sendRun.appendSystemPrompt, "EXTRA");
  assert.equal(sendRun.env?.CASTRA_MARKER, "1");
  assert.equal(sendRun.model, "model-x");
});

test("bridge.statusBySessionId resolves the same peer as status(name)", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FakeDriver() },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });

  const peer = await bridge.launchPeer({ name: "worker", prompt: "boot", driver: "claude-sdk" });
  const byName = await bridge.status("worker");
  const bySession = await bridge.statusBySessionId(peer.sessionId);
  assert.deepEqual(byName, bySession);

  assert.equal(await bridge.statusBySessionId("no-such-session"), undefined);
});

test("bridge.events returns the same chunk shape as runtime.events", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FakeDriver() },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });

  const peer = await bridge.launchPeer({ name: "worker", prompt: "boot", driver: "claude-sdk" });
  const chunk = await bridge.events(peer.sessionId);
  assert.ok(Array.isArray(chunk.items));
  assert.equal(typeof chunk.nextCursor, "number");
  assert.ok(chunk.items.length > 0);
});

test("bridge.subscribe forwards runtime events including sessionId filter", async () => {
  // Asserts the new sessionId-keyed Bridge subscribe path actually routes
  // through to runtime.subscribe — without this, callers that switch from
  // managedApi.runtime.subscribe to bridge.subscribe would silently lose
  // their event stream. Regression scope: #9.
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FakeDriver() },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });

  const allEvents: string[] = [];
  const unsubAll = bridge.subscribe((event) => {
    allEvents.push(`${event.sessionId}:${event.type}`);
  });

  const peerA = await bridge.launchPeer({ name: "alpha", prompt: "boot alpha", driver: "claude-sdk" });
  const filteredEvents: string[] = [];
  const unsubFiltered = bridge.subscribe((event) => {
    filteredEvents.push(`${event.sessionId}:${event.type}`);
  }, peerA.sessionId);

  await bridge.send("alpha", { from: "test", text: "ping" });

  unsubAll();
  unsubFiltered();

  assert.ok(allEvents.length > 0, "unfiltered subscribe should see events");
  assert.ok(filteredEvents.length > 0, "filtered subscribe should see events for its sessionId");
  assert.ok(
    filteredEvents.every((line) => line.startsWith(`${peerA.sessionId}:`)),
    "filtered subscribe should ONLY see events for the bound sessionId",
  );
});

test("BridgeOptions.runtime sibling sharing — two Bridges + sibling consumer see one event stream", async () => {
  // Regression for the in-repo extension pattern: extensions/index.ts
  // constructs a single ClaudeCodeRuntime and passes it to both the Bridge
  // and the SubagentBackend. If the Bridge silently constructed its own
  // Runtime (BridgeOptions.runtime ignored), the SubagentBackend would
  // never see Bridge-launched peer events and vice versa. This test locks
  // the sibling-sharing semantics that 1.0 deliberately preserved.
  const { ClaudeCodeRuntime } = await import("@pi-claude-code-agent/runtime/internal");
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const driver = new FakeDriver();
  const sharedRuntime = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver });

  const bridgeA = new ClaudeRuntimeIntercomBridge({
    runtime: sharedRuntime,
    storageDir: join(storageDir, "bridge-a"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });
  const bridgeB = new ClaudeRuntimeIntercomBridge({
    runtime: sharedRuntime,
    storageDir: join(storageDir, "bridge-b"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });

  const seenByA: string[] = [];
  const seenByB: string[] = [];
  const seenBySibling: string[] = [];
  bridgeA.subscribe((e) => seenByA.push(e.type));
  bridgeB.subscribe((e) => seenByB.push(e.type));
  // Sibling consumer reaches into the same Runtime directly (legitimate —
  // this is the SubagentBackend / TeamsBackend pattern).
  sharedRuntime.subscribe((e) => seenBySibling.push(e.type));

  await bridgeA.launchPeer({ name: "worker", prompt: "boot", driver: "claude-sdk" });

  // All three subscribers must have seen the launch's session.created event.
  // If Bridge had constructed its own Runtime, bridgeB and the sibling
  // would be empty.
  assert.ok(seenByA.includes("session.created"), "bridgeA missed session.created");
  assert.ok(seenByB.includes("session.created"), "bridgeB missed session.created — sibling sharing broken");
  assert.ok(seenBySibling.includes("session.created"), "sibling Runtime consumer missed session.created");
});

test("BridgeOptions.runtime wins over runtimeOptions when both are passed", async () => {
  const { ClaudeCodeRuntime } = await import("@pi-claude-code-agent/runtime/internal");
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const injectedDriver = new FakeDriver();
  const ignoredDriver = new FakeDriver();
  const injected = new ClaudeCodeRuntime({ storageDir: join(storageDir, "runtime"), driver: injectedDriver });

  const bridge = new ClaudeRuntimeIntercomBridge({
    runtime: injected,
    runtimeOptions: { driver: ignoredDriver },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });

  await bridge.launchPeer({ name: "worker", prompt: "boot", driver: "claude-sdk" });

  assert.equal(injectedDriver.runs.length, 1, "injected runtime's driver should have been used");
  assert.equal(ignoredDriver.runs.length, 0, "runtimeOptions.driver should be ignored when runtime is passed");
});

test("BridgePeer.raw projects RuntimeStatus.raw so consumers can read init capability fields", async () => {
  // Without `raw` on BridgePeer, callers who need fields the runtime folds
  // into `status.raw.init` (notably `requestedThinkingLevel`,
  // `effectiveThinkingLevel`, `thinkingLevelSupported`) would have to drop
  // to the Runtime — the very escape hatch #9 closed. This test locks the
  // projection in place.
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FakeDriver() },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });

  const peer = await bridge.launchPeer({ name: "worker", prompt: "boot", driver: "claude-sdk" });
  assert.ok(peer.raw, "BridgePeer.raw should be populated immediately on launch");

  const synced = await bridge.status("worker");
  assert.ok(synced?.raw, "bridge.status should project raw");
  const init = synced?.raw?.init;
  assert.ok(init && typeof init === "object", `bridge.status(...).raw.init missing — got ${JSON.stringify(synced?.raw)}`);
  // FakeDriver emits a system/init with `subtype: "init"` and the expected
  // session/model fields; the runtime folds the payload's `raw` into
  // `status.raw.init`.
  assert.equal((init as { subtype?: string }).subtype, "init");

  // statusBySessionId path must project the same shape.
  const bySession = await bridge.statusBySessionId(peer.sessionId);
  assert.deepEqual(bySession?.raw, synced?.raw);
});

test("ManagedPeerApi exposes sessionId-keyed parity methods (#9 acceptance)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-ca-leash-managed-peer-api-parity-"));
  const api = new PiCaLeashManagedPeerApi({
    cwd,
    runtimeOptions: { driver: new FakeDriver() },
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });

  const peer = await api.launchPeer({ name: "worker", prompt: "boot" });

  const byName = await api.status("worker");
  const bySession = await api.statusBySessionId(peer.sessionId);
  assert.deepEqual(byName, bySession);

  const chunk = await api.events(peer.sessionId);
  assert.ok(chunk.items.length > 0);

  const seen: string[] = [];
  const unsubscribe = api.subscribe((e) => seen.push(e.type), peer.sessionId);
  await api.send("worker", { from: "test", text: "ping" });
  unsubscribe();
  assert.ok(seen.length > 0);
});

// ─── waitForCompletion ─────────────────────────────────────────────────
// Drivers used below cover the staleness/ceiling/abort surface. Each goes
// through the real runtime → real bridge → real subscribe path.

class SilentAfterInitDriver implements RuntimeDriver {
  readonly name: RuntimeDriverName;
  constructor(name: RuntimeDriverName = "claude-sdk") { this.name = name; }
  run(input: RuntimeDriverRunInput, onEvent: (event: DriverEventEnvelope) => Promise<void> | void): RuntimeDriverRunHandle {
    let stopped = false;
    const done = (async () => {
      await onEvent({
        type: "message",
        payload: {
          type: "system", subtype: "init",
          sessionId: input.resumeSessionId ?? input.sessionId,
          model: input.model ?? "fake-model",
          raw: { type: "system", subtype: "init", session_id: input.resumeSessionId ?? input.sessionId, model: input.model ?? "fake-model" },
        },
      });
      // Park until kill() flips `stopped`. Never emits anything else.
      await new Promise<void>((resolve) => {
        const id = setInterval(() => { if (stopped) { clearInterval(id); resolve(); } }, 5);
      });
      return { code: 130, signal: "SIGINT" } as const;
    })();
    return { kill() { stopped = true; }, done };
  }
}

class ChattyForeverDriver implements RuntimeDriver {
  readonly name = "claude-sdk" as const;
  run(input: RuntimeDriverRunInput, onEvent: (event: DriverEventEnvelope) => Promise<void> | void): RuntimeDriverRunHandle {
    let stopped = false;
    const done = (async () => {
      await onEvent({
        type: "message",
        payload: {
          type: "system", subtype: "init",
          sessionId: input.resumeSessionId ?? input.sessionId,
          model: input.model ?? "fake-model",
          raw: { type: "system", subtype: "init", session_id: input.resumeSessionId ?? input.sessionId, model: input.model ?? "fake-model" },
        },
      });
      // Emit a steady drip of assistant text events. Never reaches `result`,
      // so the runtime never flips to `idle` — exactly the case that wall-
      // clock waiters need a hard ceiling for.
      for (let i = 0; !stopped; i++) {
        await new Promise((r) => setTimeout(r, 15));
        if (stopped) break;
        await onEvent({
          type: "message",
          payload: {
            type: "assistant",
            blocks: [{ type: "text", text: `tick:${i}`, raw: { type: "text", text: `tick:${i}` } }],
            raw: { type: "assistant", message: { content: [{ type: "text", text: `tick:${i}` }] } },
          },
        });
      }
      return { code: 130, signal: "SIGINT" } as const;
    })();
    return { kill() { stopped = true; }, done };
  }
}

test("waitForCompletion resolves with terminal status when peer reaches idle", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new SlowDriver() },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 5_000,
  });

  // SlowDriver holds peer in `starting`/`busy` for ~80ms before going idle.
  const launched = await bridge.launchPeer({ name: "worker", prompt: "boot", waitForIdle: false });
  assert.ok(["starting", "busy"].includes(launched.state));

  const status = await bridge.waitForCompletion(launched.sessionId, {
    staleThresholdMs: 5_000,
    hardCeilingMs: 2_000,
  });
  assert.equal(status.state, "idle");
  assert.equal(status.sessionId, launched.sessionId);
});

test("waitForCompletion resolves immediately when peer is already terminal", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FakeDriver() },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });
  const peer = await bridge.launchPeer({ name: "worker", prompt: "boot" });
  assert.equal(peer.state, "idle");

  const t0 = Date.now();
  const status = await bridge.waitForCompletion(peer.sessionId, { hardCeilingMs: 1_000 });
  assert.equal(status.state, "idle");
  // Snapshot path is sync-ish — must not block on any timer.
  assert.ok(Date.now() - t0 < 30, `snapshot path should resolve fast, took ${Date.now() - t0}ms`);
});

test("waitForCompletion rejects with WAIT_STALE when peer goes silent past threshold", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new SilentAfterInitDriver() },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });
  const peer = await bridge.launchPeer({ name: "worker", prompt: "boot", waitForIdle: false });

  await assert.rejects(
    () => bridge.waitForCompletion(peer.sessionId, { staleThresholdMs: 80 }),
    (err: unknown) => {
      assert.ok(err instanceof WaitCompletionError);
      assert.equal(err.code, "WAIT_STALE");
      assert.equal(err.sessionId, peer.sessionId);
      assert.ok(err.stalenessMs! >= 60, `stalenessMs ${err.stalenessMs} should be ~>= threshold`);
      return true;
    },
  );

  await bridge.stop("worker");
});

test("waitForCompletion rejects with WAIT_HARD_CEILING despite continuous activity", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new ChattyForeverDriver() },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });
  const peer = await bridge.launchPeer({ name: "worker", prompt: "boot", waitForIdle: false });

  const t0 = Date.now();
  await assert.rejects(
    () => bridge.waitForCompletion(peer.sessionId, {
      // High enough that activity never trips it. Ceiling must fire instead.
      staleThresholdMs: 5_000,
      hardCeilingMs: 120,
    }),
    (err: unknown) => {
      assert.ok(err instanceof WaitCompletionError);
      assert.equal(err.code, "WAIT_HARD_CEILING");
      assert.ok(err.elapsedMs >= 100, `elapsedMs ${err.elapsedMs} should reflect ceiling`);
      return true;
    },
  );
  // Sanity: real wall clock matches ceiling, not later.
  assert.ok(Date.now() - t0 < 500, "ceiling fired promptly");

  await bridge.stop("worker");
});

test("waitForCompletion rejects with the AbortSignal's reason", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new SilentAfterInitDriver() },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });
  const peer = await bridge.launchPeer({ name: "worker", prompt: "boot", waitForIdle: false });

  // (a) Live abort.
  const live = new AbortController();
  const reason = new Error("caller-cancelled");
  const wait = bridge.waitForCompletion(peer.sessionId, { staleThresholdMs: 5_000, signal: live.signal });
  setTimeout(() => live.abort(reason), 30);
  await assert.rejects(wait, (err: unknown) => {
    assert.equal(err, reason);
    return true;
  });

  // (b) Pre-aborted.
  const pre = new AbortController();
  const preReason = new Error("pre-cancelled");
  pre.abort(preReason);
  await assert.rejects(
    bridge.waitForCompletion(peer.sessionId, { signal: pre.signal }),
    (err: unknown) => { assert.equal(err, preReason); return true; },
  );

  await bridge.stop("worker");
});

test("waitForCompletion uses driver-aware default when staleThresholdMs is omitted", async () => {
  // Unit-level sanity on the exported helper — locks the documented contract.
  assert.equal(defaultStaleThresholdMsForDriver("claude-sdk"), 2 * 60_000);
  assert.equal(defaultStaleThresholdMsForDriver("claude-cli"), 2 * 60_000);
  assert.equal(defaultStaleThresholdMsForDriver("codex-cli"), 5 * 60_000);
  assert.equal(defaultStaleThresholdMsForDriver("pi-coding-agent"), 5 * 60_000);
});

test("waitForCompletion normalizes across drivers — same call shape, codex-cli driver name", async () => {
  // Driver advertising a different name still flows through the same surface.
  // No driver-specific branches at the call site.
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new SilentAfterInitDriver("codex-cli") },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });
  const peer = await bridge.launchPeer({ name: "worker", prompt: "boot", driver: "codex-cli", waitForIdle: false });
  const status = await bridge.statusBySessionId(peer.sessionId);
  assert.equal(status?.driver, "codex-cli");

  await assert.rejects(
    () => bridge.waitForCompletion(peer.sessionId, { staleThresholdMs: 60 }),
    (err: unknown) => err instanceof WaitCompletionError && err.code === "WAIT_STALE",
  );
  await bridge.stop("worker");
});

test("PiCaLeashManagedPeerApi.waitForCompletion delegates to the bridge", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-managed-wait-"));
  const api = new PiCaLeashManagedPeerApi({
    cwd,
    runtimeOptions: { driver: new FakeDriver() },
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });

  const peer = await api.launchPeer({ name: "worker", prompt: "boot" });
  const status = await api.waitForCompletion(peer.sessionId);
  assert.equal(status.state, "idle");
});

class FailingDriver implements RuntimeDriver {
  readonly name = "claude-sdk" as const;
  run(input: RuntimeDriverRunInput, onEvent: (event: DriverEventEnvelope) => Promise<void> | void): RuntimeDriverRunHandle {
    const done = (async () => {
      await onEvent({
        type: "message",
        payload: {
          type: "system", subtype: "init",
          sessionId: input.resumeSessionId ?? input.sessionId,
          model: input.model ?? "fake-model",
          raw: { type: "system", subtype: "init", session_id: input.resumeSessionId ?? input.sessionId, model: input.model ?? "fake-model" },
        },
      });
      await onEvent({ type: "error", payload: { message: "kaboom in driver", code: "BOOM" } });
      // Non-zero exit code → runtime flips state to "failed".
      return { code: 1, signal: null } as const;
    })();
    return { kill() { /* no-op */ }, done };
  }
}

test("waitForCompletion warns loudly on state=failed by default", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FailingDriver() },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });
  const peer = await bridge.launchPeer({ name: "worker", prompt: "boot", waitForIdle: false });

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map((a) => String(a)).join(" ")); };
  try {
    const status = await bridge.waitForCompletion(peer.sessionId, { hardCeilingMs: 1_000 });
    assert.equal(status.state, "failed");
    assert.equal(status.lastError?.message, "kaboom in driver");
  } finally {
    console.warn = origWarn;
  }
  assert.equal(warnings.length, 1, `expected exactly one warning, got ${warnings.length}`);
  assert.match(warnings[0], /state=failed/);
  assert.match(warnings[0], /kaboom in driver/);

  await bridge.stop("worker");
});

test("waitForCompletion stays silent on state=failed when silentOnFailure is set", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new FailingDriver() },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });
  const peer = await bridge.launchPeer({ name: "worker", prompt: "boot", waitForIdle: false });

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map((a) => String(a)).join(" ")); };
  try {
    const status = await bridge.waitForCompletion(peer.sessionId, { silentOnFailure: true });
    assert.equal(status.state, "failed");
  } finally {
    console.warn = origWarn;
  }
  assert.equal(warnings.length, 0);

  await bridge.stop("worker");
});

test("waitForCompletion event refresh prevents stale rejection on a long-but-progressing peer", async () => {
  // Activity must reset the staleness window. ChattyForeverDriver emits every
  // ~15ms, so a 60ms threshold with a high ceiling should NOT fire stale.
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-test-"));
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime"), driver: new ChattyForeverDriver() },
    storageDir: join(storageDir, "bridge"),
    pollIntervalMs: 5,
    askTimeoutMs: 2_000,
  });
  const peer = await bridge.launchPeer({ name: "worker", prompt: "boot", waitForIdle: false });

  // Use ceiling as the terminating condition — proves stale never fired
  // despite many threshold-windows worth of wall clock elapsing.
  await assert.rejects(
    () => bridge.waitForCompletion(peer.sessionId, { staleThresholdMs: 60, hardCeilingMs: 200 }),
    (err: unknown) => {
      assert.ok(err instanceof WaitCompletionError);
      assert.equal(err.code, "WAIT_HARD_CEILING");
      return true;
    },
  );
  await bridge.stop("worker");
});
