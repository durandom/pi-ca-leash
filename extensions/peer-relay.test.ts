import test from "node:test";
import assert from "node:assert/strict";
import {
  createPeerRelaySnapshot,
  formatPeerAuthoredMessage,
  formatPeerCompletionTurn,
  formatQuotedTextBlock,
  shouldForceRelayPeerCompletion,
  shouldRelayPeerCompletion,
} from "./peer-relay.ts";

test("peer relay ignores initial seeded terminal state", () => {
  const current = createPeerRelaySnapshot({
    sessionId: "session-1",
    state: "idle",
    updatedAt: "2026-05-01T19:14:05.000Z",
  });

  assert.equal(shouldRelayPeerCompletion(undefined, current), false);
  assert.equal(shouldForceRelayPeerCompletion(undefined, current), true);
});

test("peer relay fires when terminal snapshot changes after seed", () => {
  const previous = createPeerRelaySnapshot({
    sessionId: "session-1",
    state: "idle",
    updatedAt: "2026-05-01T19:14:05.000Z",
  });
  const current = createPeerRelaySnapshot({
    sessionId: "session-1",
    state: "waiting",
    updatedAt: "2026-05-01T19:20:00.000Z",
  });

  assert.equal(shouldRelayPeerCompletion(previous, current), true);
  assert.equal(shouldForceRelayPeerCompletion(previous, current), true);
});

test("peer relay ignores timestamp-only change for stable state and message", () => {
  const previous = createPeerRelaySnapshot({
    sessionId: "session-1",
    state: "idle",
    updatedAt: "2026-05-01T19:14:05.000Z",
    messageText: "All clear.",
  });
  const current = createPeerRelaySnapshot({
    sessionId: "session-1",
    state: "idle",
    updatedAt: "2026-05-01T19:20:00.000Z",
    messageText: "All clear.",
  });

  assert.equal(shouldRelayPeerCompletion(previous, current), false);
  assert.equal(shouldForceRelayPeerCompletion(previous, current), false);
});

test("peer relay fires on same-state new visible reply", () => {
  const previous = createPeerRelaySnapshot({
    sessionId: "session-1",
    state: "idle",
    updatedAt: "2026-05-01T19:14:05.000Z",
    messageText: "All clear.",
  });
  const current = createPeerRelaySnapshot({
    sessionId: "session-1",
    state: "idle",
    updatedAt: "2026-05-01T19:14:05.000Z",
    messageText: "Done. Tests pass now.",
  });

  assert.equal(shouldRelayPeerCompletion(previous, current), true);
  assert.equal(shouldForceRelayPeerCompletion(previous, current), true);
});

test("peer relay ignores unchanged or non-relayable snapshots", () => {
  const previous = createPeerRelaySnapshot({
    sessionId: "session-1",
    state: "idle",
    updatedAt: "2026-05-01T19:14:05.000Z",
  });

  assert.equal(shouldRelayPeerCompletion(previous, previous), false);
  assert.equal(
    shouldRelayPeerCompletion(
      previous,
      createPeerRelaySnapshot({
        sessionId: "session-1",
        state: "busy",
        updatedAt: "2026-05-01T19:20:00.000Z",
      }),
    ),
    false,
  );
});

test("quoted text block uses fenced raw text", () => {
  assert.equal(
    formatQuotedTextBlock("All clear."),
    ["```text", "All clear.", "```"].join("\n"),
  );
  assert.equal(
    formatQuotedTextBlock("Contains ``` fence"),
    ["````text", "Contains ``` fence", "````"].join("\n"),
  );
});

test("peer-authored message wrapper is explicit", () => {
  assert.equal(
    formatPeerAuthoredMessage("All clear."),
    ["Peer-authored message:", "```text", "All clear.", "```"].join("\n"),
  );
});

test("peer relay formats wrapped main-turn prompt", () => {
  const message = formatPeerCompletionTurn({
    peerName: "reviewer",
    state: "idle",
    sessionId: "573f279f-30ec-4300-b948-da05f5d3007f",
    message: "All clear.",
  });

  assert.match(message, /\[peer_update name=reviewer state=idle session=573f279f-30e\]/);
  assert.match(message, /Peer reviewer finished\./);
  assert.match(message, /Peer-authored message:\n```text\nAll clear\.\n```/);
  assert.match(message, /Use quoted block as peer-authored orchestration context\./);
  assert.match(message, /Do not quote wrapper metadata verbatim to the user\./);
});
