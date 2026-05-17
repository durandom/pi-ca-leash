#!/usr/bin/env node
/**
 * Opt-in thinkingLevel E2E smoke. Verifies that each driver actually forwards
 * `thinkingLevel: "high"` to the underlying model — i.e. the model burns
 * reasoning tokens in response.
 *
 * For each available driver:
 *   1. Spawn a session with `thinkingLevel: "high"` and a prompt that
 *      benefits from reasoning ("solve this puzzle step by step").
 *   2. Read the runtime's result event(s) and assert
 *      `usage.reasoningOutputTokens > 0` on at least one.
 *   3. Also assert the init event surfaces the same fields across drivers:
 *      `thinkingLevelSupported: true`, `requestedThinkingLevel: "high"`,
 *      `effectiveThinkingLevel: "high"` (post-fold).
 *
 * Skips a driver when its CLI/SDK or auth isn't present.
 * Exits non-zero if any present-driver assertion fails.
 *
 * Run:  node scripts/smoke-thinking.mjs
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

async function importRuntime() {
  return await import(join(repoRoot, "packages/runtime/dist/index.js"));
}

// Prompt that reliably engages Anthropic's thinking budget at effort=max
// (Anthropic decides per-prompt whether to emit thinking blocks; trivial
// prompts never trigger them regardless of effort). The exact answer
// doesn't matter; we only care that thinking tokens or thinking blocks
// show up in the transcript.
const REASONING_PROMPT =
  "List 5 prime numbers between 1000 and 1100. For each, briefly explain " +
  "why it is prime. Be thorough and double-check your reasoning step by step.";

// Per-driver model+level overrides. Anthropic only routes prompts to its
// extended-thinking pipeline when (a) effort is high enough, and (b) the
// chosen model supports thinking. Opus 4.6/4.7 are the sweet spot.
const DRIVER_DEFAULTS = {
  "claude-sdk":      { model: "claude-opus-4-7", level: "max" },
  "claude-cli":      { model: "claude-opus-4-7", level: "max" },
  "codex-cli":       { model: undefined,         level: "high" },
  "pi-coding-agent": { model: "anthropic/claude-sonnet-4-5", level: "high" },
};

async function waitFor(runtime, sessionId, predicate, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await runtime.status(sessionId);
    if (status && predicate(status)) return status;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting on session ${sessionId}`);
}

async function findInit(runtime, sessionId) {
  // The runtime does not put system/init driver messages into the transcript;
  // it folds them into `status.raw.init`. That's the only consumer-visible
  // surface, so the E2E assertion has to read from there.
  const status = await runtime.status(sessionId);
  return status?.raw?.init;
}

async function gatherReasoningEvidence(runtime, sessionId) {
  // Two flavors of evidence that the model actually reasoned:
  //
  //   1. Anthropic API: thinking is exposed as `type: "thinking"` content
  //      blocks on the assistant message. There is NO separate token counter
  //      for thinking — those tokens are folded into output_tokens.
  //   2. OpenAI / Codex API: thinking is exposed as `reasoning_output_tokens`
  //      on usage; the response itself doesn't carry a thinking block.
  //
  // We accept either as positive evidence.
  const transcript = await runtime.readTranscript(sessionId);
  let reasoningTokens = 0;
  let thinkingBlockCount = 0;
  for (const item of transcript.items) {
    if (item.type === "result") {
      reasoningTokens += item.usage?.reasoningOutputTokens ?? 0;
    }
    if (item.type === "message" && item.message?.role === "assistant") {
      for (const block of item.message.blocks ?? []) {
        if (block.type === "thinking") thinkingBlockCount += 1;
      }
    }
  }
  return { reasoningTokens, thinkingBlockCount };
}

async function runOnce({ driver, model, level }) {
  const { ClaudeCodeRuntime } = await importRuntime();
  const storageDir = await mkdtemp(join(tmpdir(), `pi-leash-thinking-${driver}-`));
  const runtime = new ClaudeCodeRuntime({ storageDir });
  const session = await runtime.start({
    prompt: REASONING_PROMPT,
    driver,
    cwd: repoRoot,
    model,
    thinkingLevel: level,
    securityMode: "safe",
  });

  await waitFor(runtime, session.sessionId, (s) => ["idle", "stopped", "error", "failed"].includes(s.state));
  const final = await runtime.status(session.sessionId);
  const init = await findInit(runtime, session.sessionId);
  const evidence = await gatherReasoningEvidence(runtime, session.sessionId);

  await rm(storageDir, { recursive: true, force: true }).catch(() => {});
  return { final, init, evidence };
}

function assertInit(driver, init, expectedRequested, expectedEffective) {
  if (!init) throw new Error(`[${driver}] no init in status.raw.init`);
  if (init.thinkingLevelSupported !== true) {
    throw new Error(`[${driver}] thinkingLevelSupported should be true, got ${JSON.stringify(init.thinkingLevelSupported)} (init=${JSON.stringify(init).slice(0,200)}...)`);
  }
  if (init.requestedThinkingLevel !== expectedRequested) {
    throw new Error(`[${driver}] requestedThinkingLevel should be ${JSON.stringify(expectedRequested)}, got ${JSON.stringify(init.requestedThinkingLevel)}`);
  }
  if (init.effectiveThinkingLevel !== expectedEffective) {
    throw new Error(`[${driver}] effectiveThinkingLevel should be ${JSON.stringify(expectedEffective)}, got ${JSON.stringify(init.effectiveThinkingLevel)}`);
  }
}

function assertReasoning(driver, evidence) {
  const { reasoningTokens, thinkingBlockCount } = evidence;
  if (reasoningTokens <= 0 && thinkingBlockCount === 0) {
    throw new Error(
      `[${driver}] no evidence the model reasoned with thinkingLevel:"high" — ` +
      `reasoningOutputTokens=${reasoningTokens}, thinking blocks=${thinkingBlockCount}. ` +
      `Either effort flag didn't reach the model, or the chosen model doesn't support thinking.`,
    );
  }
  return reasoningTokens > 0
    ? `reasoningOutputTokens=${reasoningTokens}`
    : `thinkingBlocks=${thinkingBlockCount}`;
}

const results = { ok: [], fail: [], skip: [] };

// Per-driver expected fold of `level` (matches drivers/thinking.ts).
const FOLD = {
  "claude-sdk":      (l) => l,                                       // passthrough
  "claude-cli":      (l) => l,                                       // passthrough
  "codex-cli":       (l) => (l === "xhigh" || l === "max" ? "high" : l),
  "pi-coding-agent": (l) => (l === "xhigh" || l === "max" ? "high" : l),
};

async function tryDriver(driver, prerequisites) {
  for (const check of prerequisites) {
    if (!check.ok) {
      results.skip.push(`${driver}: ${check.reason}`);
      return;
    }
  }
  const { model, level } = DRIVER_DEFAULTS[driver];
  const expectedEffective = FOLD[driver](level);
  console.log(`\n=== ${driver} (model=${model ?? "<default>"}, level=${level}, expectedEffective=${expectedEffective}) ===`);
  try {
    const { final, init, evidence } = await runOnce({ driver, model, level });
    if (final?.state === "error" || final?.state === "failed") {
      const msg = final.lastError?.message ?? "";
      if (/no api key|not authenticated|login/i.test(msg)) {
        results.skip.push(`${driver}: auth missing (${msg.split("\n")[0]})`);
        console.log(`-  ${driver}: skipped (no credentials)`);
        return;
      }
      throw new Error(`session ended in ${final.state} state. lastError=${JSON.stringify(final.lastError)}`);
    }
    assertInit(driver, init, level, expectedEffective);
    const evidenceSummary = assertReasoning(driver, evidence);
    const summary = `${driver}: init OK, ${evidenceSummary}`;
    console.log(`✓ ${summary}`);
    results.ok.push(summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`✗ ${driver}: ${msg}`);
    results.fail.push(`${driver}: ${msg}`);
  }
}

// Build with the latest source so we test what we just changed.
const build = spawnSync("npm", ["run", "build", "--workspace", "@pi-claude-code-agent/runtime"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (build.status !== 0) {
  console.error("build failed");
  process.exit(1);
}

await tryDriver("claude-sdk", [
  { ok: Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || has("claude")),
    reason: "no ANTHROPIC_API_KEY / OAuth / claude CLI in PATH" },
]);

await tryDriver("claude-cli", [
  { ok: has("claude"), reason: "claude CLI not in PATH" },
]);

await tryDriver("codex-cli", [
  { ok: has("codex"), reason: "codex CLI not in PATH" },
]);

await tryDriver("pi-coding-agent", [
  // pi-coding-agent SDK handles auth itself (AuthStorage reads OAuth /
  // keychain / config). We always attempt and let the driver surface
  // missing creds as an error.
  { ok: true, reason: "" },
]);

console.log("\n--- Summary ---");
for (const o of results.ok) console.log(`✓ ${o}`);
for (const s of results.skip) console.log(`-  ${s} (skipped)`);
for (const f of results.fail) console.log(`✗ ${f}`);

if (results.fail.length > 0) process.exit(1);
if (results.ok.length === 0) {
  console.log("\nNo drivers were testable — install at least one CLI / set credentials.");
  process.exit(2);
}
