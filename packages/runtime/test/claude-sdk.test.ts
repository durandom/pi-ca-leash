import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeSdkMessage } from "../src/drivers/claude-sdk.js";

test("parseClaudeSdkMessage maps init system message", () => {
  const [msg] = parseClaudeSdkMessage({ type: "system", subtype: "init", session_id: "sid-1", cwd: "/tmp", model: "claude-sonnet-4-6" });
  assert.equal(msg?.type, "system");
  assert.equal(msg?.subtype, "init");
  assert.equal(msg?.sessionId, "sid-1");
});

test("parseClaudeSdkMessage maps assistant content blocks and tool events", () => {
  const messages = parseClaudeSdkMessage({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
        { type: "thinking", thinking: "plan" },
      ],
    },
  });
  assert.deepEqual(messages.map((msg) => msg.type), ["assistant", "tool_use"]);
  assert.equal(messages[0]?.type, "assistant");
  assert.equal(messages[0]?.type === "assistant" ? messages[0].blocks[0]?.text : undefined, "hello");
  assert.equal(messages[1]?.type, "tool_use");
  assert.equal(messages[1]?.type === "tool_use" ? messages[1].toolName : undefined, "Bash");
});

test("parseClaudeSdkMessage maps tool results, result metadata, and stream events", () => {
  const [toolResult] = parseClaudeSdkMessage({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok", is_error: false }],
    },
    tool_use_result: { tool_name: "Bash", stdout: "ok" },
  });
  assert.equal(toolResult?.type, "tool_result");
  assert.equal(toolResult?.type === "tool_result" ? toolResult.toolName : undefined, "Bash");
  assert.equal(toolResult?.type === "tool_result" ? toolResult.toolUseId : undefined, "tool-1");

  const [result] = parseClaudeSdkMessage({
    type: "result",
    result: "done",
    session_id: "sid-1",
    is_error: false,
    duration_ms: 12,
    total_cost_usd: 0.34,
    num_turns: 2,
    usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 },
    modelUsage: { "claude-sonnet-4-6": { contextWindow: 200_000, maxOutputTokens: 64_000 } },
  });
  assert.equal(result?.type, "result");
  assert.equal(result?.type === "result" ? result.usage?.totalCostUsd : undefined, 0.34);
  assert.equal(result?.type === "result" ? result.usage?.inputTokens : undefined, 1);
  assert.equal(result?.type === "result" ? result.usage?.contextTokens : undefined, 6);
  assert.equal(result?.type === "result" ? result.usage?.contextWindow : undefined, 200_000);
  assert.equal(result?.type === "result" ? result.usage?.contextPercentage : undefined, 0);
  assert.equal(result?.type === "result" ? result.usage?.maxOutputTokens : undefined, 64_000);

  const [event] = parseClaudeSdkMessage({ type: "task_notification", session_id: "sid-1", summary: "working" });
  assert.equal(event?.type, "stream_event");
  assert.equal(event?.type === "stream_event" ? event.summary : undefined, "working");
});

import { EventEmitter } from "node:events";
import { attachChildDeathWatchdog } from "../src/drivers/claude-sdk.js";

test("attachChildDeathWatchdog aborts the controller after child exit + grace window (issue #7)", async () => {
  const child = new EventEmitter();
  const fakeRequest = { subprocess: child };
  const controller = new AbortController();
  let deathInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  const detach = attachChildDeathWatchdog(fakeRequest, 30, controller, (info) => {
    deathInfo = info;
  });

  assert.equal(controller.signal.aborted, false);
  child.emit("close", 137, "SIGKILL");
  assert.deepEqual(deathInfo, { code: 137, signal: "SIGKILL" });
  assert.equal(controller.signal.aborted, false, "abort must wait for grace window");

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(controller.signal.aborted, true, "abort fires after grace window expires");
  detach();
});

test("attachChildDeathWatchdog fires only once across duplicate close+exit events", async () => {
  const child = new EventEmitter();
  const controller = new AbortController();
  let calls = 0;

  attachChildDeathWatchdog({ subprocess: child }, 10, controller, () => {
    calls += 1;
  });

  child.emit("close", 0, null);
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 1);
});

test("attachChildDeathWatchdog returns noop when subprocess handle is absent", () => {
  const controller = new AbortController();
  const detach = attachChildDeathWatchdog({}, 100, controller, () => {
    assert.fail("onDeath must not be called when no handle");
  });
  // Detach must not throw.
  detach();
  assert.equal(controller.signal.aborted, false);
});
