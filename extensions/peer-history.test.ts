import test from "node:test";
import assert from "node:assert/strict";
import type { RuntimeEvent } from "@pi-claude-code-agent/runtime";
import { formatPeerHistoryPage } from "./peer-history.js";

function makeEvent(event: Partial<RuntimeEvent> & Pick<RuntimeEvent, "type">): RuntimeEvent {
  return {
    id: `event-${event.type}`,
    sessionId: "session-1",
    sequence: 1,
    timestamp: "2026-05-01T19:14:05.000Z",
    ...event,
  } as RuntimeEvent;
}

test("peer history hides thinking and shows visible transcript items", () => {
  const page = formatPeerHistoryPage([
    makeEvent({
      type: "message",
      sequence: 1,
      role: "assistant",
      message: {
        role: "assistant",
        blocks: [{ type: "thinking", text: "secret" }, { type: "text", text: "Ready." }],
      },
    }),
    makeEvent({
      type: "tool",
      sequence: 2,
      phase: "requested",
      toolName: "Bash",
      input: { command: "pwd" },
    }),
    makeEvent({
      type: "tool",
      sequence: 3,
      phase: "completed",
      toolName: "Bash",
      output: { stdout: "/repo" },
    }),
    makeEvent({
      type: "result",
      sequence: 4,
      ok: true,
      summary: "Ready.",
    }),
  ]);

  assert.match(page.text, /\[1 \d{2}:\d{2}:\d{2}\] assistant\nReady\./);
  assert.match(page.text, /\[2 \d{2}:\d{2}:\d{2}\] tool requested Bash/);
  assert.match(page.text, /"command": "pwd"/);
  assert.match(page.text, /\[3 \d{2}:\d{2}:\d{2}\] tool completed Bash/);
  assert.doesNotMatch(page.text, /secret/);
  assert.doesNotMatch(page.text, /\[4 19:14:05\] result/);
});

test("peer history paginates by visible entries from tail by default and exposes cursors", () => {
  const events = Array.from({ length: 5 }, (_, index) => makeEvent({
    type: "message",
    sequence: index + 1,
    message: {
      role: "assistant",
      blocks: [{ type: "text", text: `msg-${index + 1}` }],
    },
    role: "assistant",
  }));

  const page = formatPeerHistoryPage(events, { limit: 2 });
  assert.equal(page.startCursor, 3);
  assert.equal(page.endCursor, 5);
  assert.equal(page.previousCursor, 1);
  assert.equal(page.nextCursor, undefined);
  assert.match(page.text, /msg-4/);
  assert.match(page.text, /msg-5/);
  assert.doesNotMatch(page.text, /msg-3/);
});

test("peer history cursor ignores hidden events and empty visible ranges", () => {
  const page = formatPeerHistoryPage([
    makeEvent({
      type: "message",
      sequence: 1,
      role: "assistant",
      message: {
        role: "assistant",
        blocks: [{ type: "thinking", text: "secret" }],
      },
    }),
    makeEvent({
      type: "result",
      sequence: 2,
      ok: true,
      summary: "done",
    }),
  ], { cursor: 0, limit: 2 });

  assert.equal(page.startCursor, 0);
  assert.equal(page.endCursor, 0);
  assert.equal(page.text, "<no visible transcript items in this range>");
});

test("peer history limit counts visible entries rather than raw events", () => {
  const page = formatPeerHistoryPage([
    makeEvent({
      type: "message",
      sequence: 1,
      role: "assistant",
      message: {
        role: "assistant",
        blocks: [{ type: "text", text: "msg-1" }],
      },
    }),
    makeEvent({
      type: "result",
      sequence: 2,
      ok: true,
      summary: "done-1",
    }),
    makeEvent({
      type: "message",
      sequence: 3,
      role: "assistant",
      message: {
        role: "assistant",
        blocks: [{ type: "text", text: "msg-2" }],
      },
    }),
    makeEvent({
      type: "result",
      sequence: 4,
      ok: true,
      summary: "done-2",
    }),
  ], { limit: 2 });

  assert.equal(page.total, 2);
  assert.equal(page.startCursor, 0);
  assert.equal(page.endCursor, 2);
  assert.match(page.text, /msg-1/);
  assert.match(page.text, /msg-2/);
});
