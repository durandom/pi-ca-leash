#!/usr/bin/env node
/**
 * Opt-in Bridge sessionId-parity smoke. Burns real tokens (one short call
 * per driver) to verify the 1.0 sessionId-keyed Bridge methods route
 * correctly against a real session — not just a FakeDriver harness.
 *
 * For each available driver:
 *   1. Launch a peer via Bridge (short prompt → minimal token spend).
 *   2. Assert all three new methods agree with each other and with the
 *      embedded Runtime:
 *        - `bridge.statusBySessionId(sid)` ≡ `bridge.status(name)`
 *        - `bridge.events(sid)` returns the in-order RuntimeEvent log
 *        - `bridge.subscribe(listener, sid)` fires for at least one event
 *   3. Run a follow-up `bridge.ask` and verify the subscribe filter only
 *      sees events for the subscribed sessionId (not any concurrent peer).
 *
 * Skips a driver when its CLI / SDK / credentials are missing. Exits
 * non-zero if any present-driver assertion fails.
 *
 * Run:  node scripts/smoke-bridge-parity.mjs
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

async function runDriver({ driver, peerName, hasCreds }) {
  if (!hasCreds()) {
    console.log(`⏭  ${driver}: credentials / CLI not present — skipping`);
    return;
  }
  const { ClaudeRuntimeIntercomBridge } = await importBridge();
  const storageDir = await mkdtemp(join(tmpdir(), `pi-leash-bridge-parity-${driver}-`));
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtimeOptions: { storageDir: join(storageDir, "runtime") },
    storageDir: join(storageDir, "bridge"),
    askTimeoutMs: 120_000,
  });

  const seenAll = [];
  const seenFiltered = [];
  const seenOther = [];
  const unsubAll = bridge.subscribe((e) => seenAll.push({ sid: e.sessionId, type: e.type }));

  try {
    const launched = await bridge.launchPeer({
      name: peerName,
      prompt: "Reply with exactly the word: parity-ok",
      driver,
    });

    // (1) statusBySessionId ≡ status(name)
    const byName = await bridge.status(peerName);
    const bySession = await bridge.statusBySessionId(launched.sessionId);
    record(
      `${driver}: bridge.statusBySessionId === bridge.status(name)`,
      Boolean(byName) && byName?.sessionId === bySession?.sessionId,
    );

    // (2) bridge.events returns a real chunk
    const chunk = await bridge.events(launched.sessionId);
    record(
      `${driver}: bridge.events returns a non-empty chunk for an idle peer`,
      Array.isArray(chunk.items) && chunk.items.length > 0 && typeof chunk.nextCursor === "number",
      `items=${chunk.items.length}`,
    );

    // (3) subscribe filter — bind AFTER launch so we test that follow-ups
    // emit, and bind a parallel "other" subscriber on a bogus sessionId to
    // make sure the filter excludes non-matching events.
    const unsubFiltered = bridge.subscribe(
      (e) => seenFiltered.push({ sid: e.sessionId, type: e.type }),
      launched.sessionId,
    );
    const unsubOther = bridge.subscribe(
      (e) => seenOther.push({ sid: e.sessionId, type: e.type }),
      "00000000-0000-0000-0000-000000000000",
    );

    await bridge.ask(peerName, { from: "smoke", text: "Reply: still-here" });

    unsubFiltered();
    unsubOther();

    record(
      `${driver}: filtered subscribe saw events for its sessionId`,
      seenFiltered.length > 0,
      `events=${seenFiltered.length}`,
    );
    record(
      `${driver}: filtered subscribe ignored events for a different sessionId`,
      seenOther.length === 0,
      `unexpected events=${seenOther.length}`,
    );
    record(
      `${driver}: unfiltered subscribe saw events`,
      seenAll.length > 0,
      `events=${seenAll.length}`,
    );
  } catch (err) {
    record(`${driver}: smoke threw`, false, String(err && err.message ? err.message : err));
  } finally {
    unsubAll();
    try {
      await bridge.stop(peerName);
    } catch {}
    await rm(storageDir, { recursive: true, force: true }).catch(() => {});
  }
}

console.log("=== pi-ca-leash Bridge sessionId-parity smoke (real tokens) ===");

await runDriver({
  driver: "claude-sdk",
  peerName: "parity-claude-sdk",
  hasCreds: () => Boolean(process.env.ANTHROPIC_API_KEY) || has("claude"),
});
await runDriver({
  driver: "claude-cli",
  peerName: "parity-claude-cli",
  hasCreds: () => has("claude"),
});
await runDriver({
  driver: "codex-cli",
  peerName: "parity-codex-cli",
  hasCreds: () => has("codex"),
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error(`${failed.length} FAILED`);
  process.exit(1);
}
