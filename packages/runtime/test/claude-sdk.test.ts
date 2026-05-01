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

  const [result] = parseClaudeSdkMessage({ type: "result", result: "done", session_id: "sid-1", is_error: false, duration_ms: 12, total_cost_usd: 0.34, num_turns: 2, usage: { input_tokens: 1 } });
  assert.equal(result?.type, "result");
  assert.equal(result?.type === "result" ? result.usage?.totalCostUsd : undefined, 0.34);
  assert.equal(result?.type === "result" ? result.usage?.inputTokens : undefined, 1);

  const [event] = parseClaudeSdkMessage({ type: "task_notification", session_id: "sid-1", summary: "working" });
  assert.equal(event?.type, "stream_event");
  assert.equal(event?.type === "stream_event" ? event.summary : undefined, "working");
});
