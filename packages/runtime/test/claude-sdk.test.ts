import test from "node:test";
import assert from "node:assert/strict";
import { parseClaudeSdkMessage } from "../src/drivers/claude-sdk.js";

test("parseClaudeSdkMessage maps init system message", () => {
  const [msg] = parseClaudeSdkMessage({ type: "system", subtype: "init", session_id: "sid-1", cwd: "/tmp", model: "claude-sonnet-4-6" });
  assert.equal(msg?.type, "system");
  assert.equal(msg?.metadata?.subtype, "init");
  assert.equal(msg?.metadata?.session_id, "sid-1");
});

test("parseClaudeSdkMessage maps assistant content blocks", () => {
  const messages = parseClaudeSdkMessage({
    type: "assistant",
    message: {
      model: "claude-sonnet-4-6",
      content: [
        { type: "text", text: "hello" },
        { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "pwd" } },
        { type: "tool_result", tool_use_id: "tool-1", content: "ok", is_error: false },
        { type: "thinking", thinking: "plan" },
      ],
    },
  });
  assert.deepEqual(messages.map((msg) => msg.type), ["assistant", "tool_use", "tool_result", "assistant"]);
  assert.equal(messages[0]?.content, "hello");
  assert.equal(messages[1]?.metadata?.tool_name, "Bash");
  assert.equal(messages[2]?.metadata?.tool_use_id, "tool-1");
  assert.equal(messages[3]?.metadata?.thinking, true);
});

test("parseClaudeSdkMessage maps result metadata and stream events", () => {
  const [result] = parseClaudeSdkMessage({ type: "result", result: "done", session_id: "sid-1", is_error: false, duration_ms: 12, total_cost_usd: 0.34, num_turns: 2, usage: { input_tokens: 1 } });
  assert.equal(result?.type, "result");
  assert.equal(result?.metadata?.total_cost_usd, 0.34);
  assert.equal(result?.metadata?.num_turns, 2);

  const [event] = parseClaudeSdkMessage({ type: "task_notification", session_id: "sid-1", summary: "working" });
  assert.equal(event?.type, "stream_event");
  assert.equal(event?.content, "working");
});
