import test from "node:test";
import assert from "node:assert/strict";
import type { BridgePeer } from "@pi-claude-code-agent/intercom-bridge";
import type { RuntimeEvent } from "@pi-claude-code-agent/runtime";
import { buildPeerActivityRow, getPeerFirstHealth, isPeerVisibleInWidget } from "./peer-ux.js";

function makePeer(overrides: Partial<BridgePeer> = {}): BridgePeer {
  return {
    name: "reviewer",
    sessionId: "session-1",
    cwd: process.cwd(),
    state: "idle",
    createdAt: "2026-05-01T19:10:00.000Z",
    updatedAt: "2026-05-01T19:14:05.000Z",
    lastActivityAt: "2026-05-01T19:14:05.000Z",
    ...overrides,
  };
}

function makeEvent(event: Partial<RuntimeEvent> & Pick<RuntimeEvent, "type">): RuntimeEvent {
  return {
    id: "event-1",
    sessionId: "session-1",
    sequence: 1,
    timestamp: "2026-05-01T19:14:05.000Z",
    ...event,
  } as RuntimeEvent;
}

test("buildPeerActivityRow summarizes active Bash tool use", () => {
  const row = buildPeerActivityRow(makePeer({ state: "busy" }), [
    makeEvent({
      type: "tool",
      phase: "requested",
      toolName: "Bash",
      input: { command: "npm test" },
    }),
  ]);

  assert.equal(row.state, "busy");
  assert.equal(row.activity, "Bash: npm test");
});

test("buildPeerActivityRow summarizes last reply for idle peer", () => {
  const row = buildPeerActivityRow(makePeer(), [
    makeEvent({
      type: "message",
      role: "assistant",
      message: {
        role: "assistant",
        blocks: [{ type: "text", text: "peer-ok" }],
      },
    }),
  ]);

  assert.equal(row.state, "idle");
  assert.equal(row.activity, "last reply: peer-ok");
});

test("buildPeerActivityRow detects waiting for input", () => {
  const row = buildPeerActivityRow(makePeer(), [
    makeEvent({
      type: "message",
      role: "assistant",
      message: {
        role: "assistant",
        blocks: [{ type: "text", text: "Please provide the failing command." }],
      },
    }),
  ]);

  assert.equal(row.state, "waiting");
  assert.equal(row.activity, "needs input");
});

test("buildPeerActivityRow does not flag completed reports as waiting", () => {
  const row = buildPeerActivityRow(makePeer(), [
    makeEvent({
      type: "message",
      role: "assistant",
      message: {
        role: "assistant",
        blocks: [{
          type: "text",
          text: [
            "Slice implemented.",
            "",
            "Changed files:",
            "- extensions/peer-ux.ts",
            "",
            "Commands:",
            "- npm test",
            "",
            "Blockers: none.",
            "Residual risk: low.",
          ].join("\n"),
        }],
      },
    }),
  ]);

  assert.equal(row.state, "idle");
  assert.match(row.activity, /^last reply:/);
});

test("buildPeerActivityRow does not treat report headings as unresolved asks", () => {
  const row = buildPeerActivityRow(makePeer(), [
    makeEvent({
      type: "message",
      role: "assistant",
      message: {
        role: "assistant",
        blocks: [{ type: "text", text: "What changed:\n- tightened peer state mapping\n\nNext steps: none." }],
      },
    }),
  ]);

  assert.equal(row.state, "idle");
  assert.match(row.activity, /^last reply:/);
});

test("buildPeerActivityRow includes latest token usage from result events", () => {
  const row = buildPeerActivityRow(makePeer(), [
    makeEvent({
      type: "result",
      ok: true,
      summary: "done",
      usage: {
        inputTokens: 123_000,
        outputTokens: 456,
        cacheReadInputTokens: 100_000,
        reasoningOutputTokens: 12,
      },
    }),
  ]);

  assert.equal(row.inputTokens, 123_000);
  assert.equal(row.outputTokens, 456);
  assert.equal(row.cacheReadInputTokens, 100_000);
  assert.equal(row.reasoningOutputTokens, 12);
});

test("buildPeerActivityRow includes latest context usage from result events", () => {
  const row = buildPeerActivityRow(makePeer(), [
    makeEvent({
      type: "result",
      ok: true,
      summary: "done",
      usage: {
        inputTokens: 20_000,
        outputTokens: 100,
        contextTokens: 50_000,
        contextWindow: 200_000,
        contextPercentage: 25,
      },
    }),
  ]);

  assert.equal(row.contextTokens, 50_000);
  assert.equal(row.contextWindow, 200_000);
  assert.equal(row.contextPercentage, 25);
});

test("buildPeerActivityRow derives context usage from raw Claude SDK modelUsage fallback", () => {
  const row = buildPeerActivityRow(makePeer(), [
    makeEvent({
      type: "result",
      ok: true,
      summary: "done",
      usage: {
        inputTokens: 6,
        outputTokens: 23,
        cacheCreationInputTokens: 29_989,
        cacheReadInputTokens: 0,
      },
      raw: {
        type: "result",
        modelUsage: {
          "claude-haiku-4-5-20251001": {
            inputTokens: 359,
            outputTokens: 13,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            contextWindow: 200_000,
            maxOutputTokens: 32_000,
          },
          "claude-opus-4-7[1m]": {
            inputTokens: 6,
            outputTokens: 23,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 29_989,
            contextWindow: 1_000_000,
            maxOutputTokens: 64_000,
          },
        },
      },
    }),
  ]);

  assert.equal(row.contextTokens, 29_995);
  assert.equal(row.contextWindow, 1_000_000);
  assert.equal(row.contextPercentage, 3);
});

test("buildPeerActivityRow includes driver and model from peer", () => {
  const row = buildPeerActivityRow(makePeer({ driver: "codex-cli", model: "claude-sonnet-4-6" }), []);
  assert.equal(row.driver, "codex-cli");
  assert.equal(row.model, "claude-sonnet-4-6");
});

test("buildPeerActivityRow has undefined driver and model when peer has none", () => {
  const row = buildPeerActivityRow(makePeer(), []);
  assert.equal(row.driver, undefined);
  assert.equal(row.model, undefined);
});

test("stopped peers are hidden from the compact widget", () => {
  assert.equal(isPeerVisibleInWidget(buildPeerActivityRow(makePeer({ state: "idle" }), [])), true);
  assert.equal(isPeerVisibleInWidget(buildPeerActivityRow(makePeer({ state: "stopped" }), [])), false);
});

test("peer-first health favors warning over activity", () => {
  const busy = buildPeerActivityRow(makePeer({ state: "busy" }), []);
  const waiting = buildPeerActivityRow(makePeer(), [
    makeEvent({
      type: "message",
      role: "assistant",
      message: {
        role: "assistant",
        blocks: [{ type: "text", text: "What file should I inspect next?" }],
      },
    }),
  ]);

  assert.equal(getPeerFirstHealth([busy], false), "active");
  assert.equal(getPeerFirstHealth([waiting], false), "warning");
  assert.equal(getPeerFirstHealth([], true), "warning");
  assert.equal(getPeerFirstHealth([], false), "idle");
});
