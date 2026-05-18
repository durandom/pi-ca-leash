#!/usr/bin/env node
/**
 * Opt-in Bridge pass-through smoke. Burns real tokens against each available
 * driver. Verifies the 1.0 pass-through invariant end-to-end: fields set on a
 * Bridge intercom message reach the real driver and are honoured by the real
 * model — not just captured by a FakeDriver assertion.
 *
 * For each available driver:
 *   1. Launch a peer via Bridge with `securityMode: "yolo"` and
 *      `thinkingLevel` set on the launch. Read the init capability surface
 *      via `bridge.status(name).raw.init` (the `BridgePeer.raw` projection).
 *   2. Assert the real model actually reasoned on launch — either
 *      Anthropic-style `type:"thinking"` content blocks on the assistant
 *      message, OR codex-style `usage.reasoningOutputTokens > 0`. Either
 *      is positive evidence that `thinkingLevel` reached the model.
 *   3. Send a follow-up `bridge.send` that EXPLICITLY re-passes
 *      `thinkingLevel`, and assert a second result event appears AND that
 *      it also shows reasoning evidence. This proves pass-through on a
 *      subsequent send — the actual scope of the Bridge's #9 contract.
 *      (Note: `thinkingLevel` is per-send, NOT session-sticky at the
 *      runtime layer — only `securityMode` and `model` re-apply across
 *      sends. The smoke does not assert stickiness for `thinkingLevel`.)
 *   4. Send a third turn that explicitly overrides `securityMode: "safe"`;
 *      verify the Bridge accepts the override (live sandbox-flag effects
 *      are covered by `smoke-security.mjs`).
 *
 * Skips a driver when its CLI / SDK / credentials are missing. Exits
 * non-zero if any present-driver assertion fails.
 *
 * Run:  node scripts/smoke-bridge-passthrough.mjs
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const has = (bin) =>
  spawnSync("which", [bin], { stdio: ["ignore", "pipe", "ignore"] }).status === 0;

async function importBridge() {
  return await import(join(repoRoot, "packages/intercom-bridge/dist/index.js"));
}

const results = [];
function record(name, ok, note = "") {
  results.push({ name, ok, note });
  console.log(`${ok ? "✅" : "❌"} ${name}${note ? ` — ${note}` : ""}`);
}

async function waitForIdle(bridge, name, timeoutMs = 180_000) {
  // BridgePeer.state uses `errored` (not `failed`) for runtime failures —
  // matches the BridgeState enum in packages/intercom-bridge/src/types.ts.
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const peer = await bridge.status(name);
    if (peer && ["idle", "interrupted", "errored", "stopped"].includes(peer.state)) {
      return peer;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for ${name} to idle`);
}

async function gatherEvidence(bridge, sessionId) {
  // Two flavors of "the model reasoned" — accept either, matching the
  // surface that `smoke-thinking.mjs` already validates:
  //   - Anthropic: `type: "thinking"` content blocks on assistant messages.
  //     Thinking tokens are folded into output tokens, no separate counter.
  //   - OpenAI / Codex: `usage.reasoningOutputTokens > 0` on result events.
  const chunk = await bridge.events(sessionId);
  let reasoningTokens = 0;
  let thinkingBlocks = 0;
  let resultCount = 0;
  for (const e of chunk.items) {
    if (e.type === "result") {
      resultCount += 1;
      reasoningTokens += e.usage?.reasoningOutputTokens ?? 0;
    }
    if (e.type === "message" && e.message?.role === "assistant") {
      for (const block of e.message.blocks ?? []) {
        if (block.type === "thinking") thinkingBlocks += 1;
      }
    }
  }
  return { reasoningTokens, thinkingBlocks, resultCount };
}

async function runDriver({ driver, peerName, prompt, thinkingLevel, hasCreds }) {
  if (!hasCreds()) {
    console.log(`⏭  ${driver}: credentials / CLI not present — skipping`);
    return;
  }
  const { ClaudeRuntimeIntercomBridge } = await importBridge();
  const storageDir = await mkdtemp(join(tmpdir(), `pi-leash-bridge-passthrough-${driver}-`));
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime") },
    storageDir: join(storageDir, "bridge"),
    askTimeoutMs: 180_000,
  });

  try {
    // (1) Launch with sticky securityMode + thinkingLevel.
    const launched = await bridge.launchPeer({
      name: peerName,
      prompt,
      driver,
      securityMode: "yolo",
      thinkingLevel,
    });

    // Read the init capability surface directly via the Bridge — this is
    // the 1.0 `BridgePeer.raw` projection. If consumers had to drop to
    // Runtime to read this, the #9 escape hatch would still effectively
    // exist for capability discovery.
    const peerLaunched = await bridge.status(peerName);
    const init = peerLaunched?.raw && typeof peerLaunched.raw === "object"
      ? peerLaunched.raw.init
      : undefined;
    record(
      `${driver}: BridgePeer.raw.init carries driver capability fields`,
      Boolean(init && typeof init === "object"),
      init && typeof init === "object" ? "init present on bridge.status" : "init missing — BridgePeer.raw projection broken",
    );

    const ev1 = await gatherEvidence(bridge, launched.sessionId);
    // Either flavor of reasoning counts: Anthropic surfaces thinking blocks
    // (folded into output tokens), OpenAI surfaces reasoning_output_tokens.
    record(
      `${driver}: real model reasoned on launch (Bridge → driver → model)`,
      ev1.reasoningTokens > 0 || ev1.thinkingBlocks > 0,
      `reasoningTokens=${ev1.reasoningTokens} thinkingBlocks=${ev1.thinkingBlocks} resultEvents=${ev1.resultCount}`,
    );

    // (2) Send a non-trivial follow-up that EXPLICITLY re-passes
    // `thinkingLevel`. This is the actual scope of the Bridge's #9
    // contract: every driver field on the inbound intercom message
    // reaches the driver verbatim, on every send. `thinkingLevel` is
    // not session-sticky at the runtime layer (only `securityMode` and
    // `model` are re-applied), so the way to assert pass-through on a
    // subsequent send is to set the field again and check the model
    // reasoned again.
    await bridge.send(peerName, {
      from: "smoke",
      text: "Now solve this: a snail climbs 3 ft up a wall by day and slides 2 ft down at night. The wall is 10 ft. How many days to escape? Explain.",
      thinkingLevel,
    });
    const afterFollowup = await bridge.status(peerName);
    const bySession = await bridge.statusBySessionId(launched.sessionId);
    record(
      `${driver}: statusBySessionId resolves same peer as status(name)`,
      afterFollowup?.sessionId === bySession?.sessionId,
    );

    const ev2 = await gatherEvidence(bridge, launched.sessionId);
    record(
      `${driver}: follow-up produced a second turn (Bridge.send → runtime.send routed)`,
      ev2.resultCount > ev1.resultCount,
      `result events: ${ev1.resultCount} → ${ev2.resultCount}`,
    );
    // Per-send pass-through: the follow-up explicitly re-passed
    // `thinkingLevel`, so the model should reason again. This catches
    // "Bridge accepts the field but doesn't actually forward it on
    // subsequent sends" — a different failure mode than first-send
    // pass-through.
    record(
      `${driver}: thinkingLevel pass-through reaches model on follow-up send`,
      ev2.reasoningTokens > ev1.reasoningTokens || ev2.thinkingBlocks > ev1.thinkingBlocks,
      `reasoningTokens ${ev1.reasoningTokens}→${ev2.reasoningTokens} thinkingBlocks ${ev1.thinkingBlocks}→${ev2.thinkingBlocks}`,
    );

    // (3) Explicit override per-send. Best-effort: we just verify the send
    // didn't throw. Verifying that securityMode=safe actually changes
    // sandbox behaviour live is what smoke-security.mjs covers.
    await bridge.send(peerName, {
      from: "smoke",
      text: "Final step.",
      securityMode: "safe",
    });
    record(`${driver}: explicit per-send securityMode override accepted by Bridge`, true);
  } catch (err) {
    record(`${driver}: smoke threw`, false, String(err && err.message ? err.message : err));
  } finally {
    try {
      await bridge.stop(peerName);
    } catch {}
    await rm(storageDir, { recursive: true, force: true }).catch(() => {});
  }
}

console.log("=== pi-ca-leash Bridge pass-through smoke (real tokens) ===");

// Anthropic only reliably emits thinking blocks at effort=max for non-trivial
// prompts. OpenAI burns reasoning tokens at any non-low level. Mirror what
// smoke-thinking.mjs picks.
const REASONING_PROMPT =
  "Think step by step. A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost? Explain your reasoning.";

await runDriver({
  driver: "claude-sdk",
  peerName: "passthrough-claude-sdk",
  prompt: REASONING_PROMPT,
  thinkingLevel: "max",
  hasCreds: () => Boolean(process.env.ANTHROPIC_API_KEY) || has("claude"),
});

await runDriver({
  driver: "claude-cli",
  peerName: "passthrough-claude-cli",
  prompt: REASONING_PROMPT,
  thinkingLevel: "max",
  hasCreds: () => has("claude"),
});

await runDriver({
  driver: "codex-cli",
  peerName: "passthrough-codex-cli",
  prompt: REASONING_PROMPT,
  thinkingLevel: "high",
  hasCreds: () => has("codex"),
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error(`${failed.length} FAILED`);
  process.exit(1);
}
