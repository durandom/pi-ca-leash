import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverEventEnvelope, RuntimeDriver, RuntimeDriverRunHandle, RuntimeDriverRunInput } from "@pi-claude-code-agent/runtime";
import { ClaudeCodeRuntime } from "@pi-claude-code-agent/runtime";
import { ClaudeRuntimeIntercomBridge, extractReplyText, formatInboundMessage } from "../src/index.js";

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
