import test from "node:test";
import assert from "node:assert/strict";
import {
  enrichInitWithCapabilities,
  foldThinkingLevelForClaude,
  foldThinkingLevelForCodex,
  foldThinkingLevelForPiCodingAgent,
} from "../src/drivers/thinking.js";
import type { DriverEventEnvelope } from "../src/types.js";

// ---------------------------------------------------------------------------
// foldThinkingLevelForPiCodingAgent — covers issue #6's superset → native fold
// ---------------------------------------------------------------------------

test("pi-coding-agent fold — passes through low/medium/high unchanged", () => {
  assert.equal(foldThinkingLevelForPiCodingAgent("low"), "low");
  assert.equal(foldThinkingLevelForPiCodingAgent("medium"), "medium");
  assert.equal(foldThinkingLevelForPiCodingAgent("high"), "high");
});

test("pi-coding-agent fold — xhigh and max fold to high (SDK ladder tops at high)", () => {
  assert.equal(foldThinkingLevelForPiCodingAgent("xhigh"), "high");
  assert.equal(foldThinkingLevelForPiCodingAgent("max"), "high");
});

test("claude fold — passthrough all five values (native vocab)", () => {
  assert.equal(foldThinkingLevelForClaude("low"), "low");
  assert.equal(foldThinkingLevelForClaude("medium"), "medium");
  assert.equal(foldThinkingLevelForClaude("high"), "high");
  assert.equal(foldThinkingLevelForClaude("xhigh"), "xhigh");
  assert.equal(foldThinkingLevelForClaude("max"), "max");
});

test("codex fold — xhigh and max fold to high (OpenAI reasoning_effort tops at high)", () => {
  assert.equal(foldThinkingLevelForCodex("low"), "low");
  assert.equal(foldThinkingLevelForCodex("medium"), "medium");
  assert.equal(foldThinkingLevelForCodex("high"), "high");
  assert.equal(foldThinkingLevelForCodex("xhigh"), "high");
  assert.equal(foldThinkingLevelForCodex("max"), "high");
});

// ---------------------------------------------------------------------------
// enrichInitWithCapabilities — augments first system/init event in-place
// ---------------------------------------------------------------------------

test("enrich — adds thinkingLevelSupported to the first system/init event", async () => {
  const seen: DriverEventEnvelope[] = [];
  const wrapped = enrichInitWithCapabilities((e) => { seen.push(e); }, {
    thinkingLevelSupported: false,
  });
  await wrapped({
    type: "message",
    payload: { type: "system", subtype: "init", sessionId: "s1" },
  });
  const meta = seen[0]?.type === "message" && seen[0].payload.type === "system"
    ? seen[0].payload.metadata
    : undefined;
  assert.equal(meta?.thinkingLevelSupported, false);
});

test("enrich — preserves existing metadata fields on the init event", async () => {
  const seen: DriverEventEnvelope[] = [];
  const wrapped = enrichInitWithCapabilities((e) => { seen.push(e); }, {
    thinkingLevelSupported: false,
  });
  await wrapped({
    type: "message",
    payload: {
      type: "system",
      subtype: "init",
      sessionId: "s1",
      metadata: { upstream: "claude-sdk-thing" },
    },
  });
  const meta = seen[0]?.type === "message" && seen[0].payload.type === "system"
    ? seen[0].payload.metadata
    : undefined;
  assert.equal(meta?.upstream, "claude-sdk-thing");
  assert.equal(meta?.thinkingLevelSupported, false);
});

test("enrich — only fires once; later system/init events pass through untouched", async () => {
  const seen: DriverEventEnvelope[] = [];
  const wrapped = enrichInitWithCapabilities((e) => { seen.push(e); }, {
    thinkingLevelSupported: false,
  });
  for (let i = 0; i < 3; i++) {
    await wrapped({
      type: "message",
      payload: { type: "system", subtype: "init", sessionId: `s${i}` },
    });
  }
  // Only the first event gets enriched; subsequent ones are passed through
  // verbatim so we don't accidentally rewrite mid-stream replay envelopes.
  const enriched = seen.filter(
    (e) => e.type === "message" && e.payload.type === "system" &&
           (e.payload.metadata?.thinkingLevelSupported === false),
  );
  assert.equal(enriched.length, 1);
});

test("enrich — non-init events pass through untouched", async () => {
  const seen: DriverEventEnvelope[] = [];
  const wrapped = enrichInitWithCapabilities((e) => { seen.push(e); }, {
    thinkingLevelSupported: false,
  });
  await wrapped({ type: "error", payload: { message: "boom" } });
  assert.equal(seen[0]?.type, "error");
});

test("enrich — effectiveThinkingLevel only set when provided", async () => {
  const seenOmit: DriverEventEnvelope[] = [];
  const seenSet: DriverEventEnvelope[] = [];
  const omit = enrichInitWithCapabilities((e) => { seenOmit.push(e); }, {
    thinkingLevelSupported: false,
  });
  const set = enrichInitWithCapabilities((e) => { seenSet.push(e); }, {
    thinkingLevelSupported: true,
    effectiveThinkingLevel: "low",
  });
  await omit({ type: "message", payload: { type: "system", subtype: "init" } });
  await set({ type: "message", payload: { type: "system", subtype: "init" } });
  const metaOmit = seenOmit[0]?.type === "message" && seenOmit[0].payload.type === "system"
    ? seenOmit[0].payload.metadata
    : undefined;
  const metaSet = seenSet[0]?.type === "message" && seenSet[0].payload.type === "system"
    ? seenSet[0].payload.metadata
    : undefined;
  assert.equal(metaOmit?.effectiveThinkingLevel, undefined);
  assert.equal(metaSet?.effectiveThinkingLevel, "low");
});
