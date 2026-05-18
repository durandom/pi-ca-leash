#!/usr/bin/env node
/**
 * Opt-in security-mode smoke. Verifies the only guarantees pi-ca-leash
 * actually documents:
 *
 *   1. codex-cli + securityMode:"safe"   → write outside cwd is blocked
 *   2. codex-cli + securityMode:"yolo"   → write outside cwd succeeds
 *   3. claude-cli + securityMode:"safe"  → no auto-approve (run hangs or
 *      idles without firing the write tool); contrasted with yolo where
 *      the write completes.
 *
 * Skips a sub-suite when the underlying CLI is missing. Exits non-zero
 * if any present-CLI guarantee fails.
 *
 * Run:  node scripts/smoke-security.mjs
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(__dirname);

const has = (bin) =>
  spawnSync("which", [bin], { stdio: ["ignore", "pipe", "ignore"] }).status === 0;

async function importRuntime() {
  // Harness smoke reaches into the runtime supervisor directly — that is
  // why it uses the `/internal` entry point, not the public `index.js`.
  return await import(join(repoRoot, "packages/runtime/dist/internal.js"));
}

async function waitFor(runtime, sessionId, predicate, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await runtime.status(sessionId);
    if (status && predicate(status)) return status;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting on session ${sessionId}`);
}

async function runOnce({ driver, securityMode, prompt, cwd, timeoutMs }) {
  const { ClaudeCodeRuntime } = await importRuntime();
  const storageDir = await mkdtemp(join(tmpdir(), `pi-leash-sec-${driver}-`));
  const runtime = new ClaudeCodeRuntime({ storageDir });
  const session = await runtime.start({ prompt, driver, cwd, securityMode });
  await waitFor(
    runtime,
    session.sessionId,
    (s) => s.state === "idle" || s.state === "failed" || s.state === "stopped",
    timeoutMs,
  );
  return { runtime, sessionId: session.sessionId, storageDir };
}

const results = [];
function record(name, ok, note = "") {
  results.push({ name, ok, note });
  console.log(`${ok ? "✅" : "❌"} ${name}${note ? ` — ${note}` : ""}`);
}

async function codexSuite() {
  if (!has("codex")) {
    console.log("⏭  codex CLI not on PATH — skipping codex security suite");
    return;
  }
  const cwd = await mkdtemp(join(tmpdir(), "pi-leash-sec-codex-cwd-"));
  const outside = join(tmpdir(), `pi-leash-sec-outside-${process.pid}-${Date.now()}`);
  const prompt = `Write the literal text 'ok' into the file ${outside}. Use bash. Do not create it inside the current directory.`;

  try {
    // safe → must NOT exist after run
    await runOnce({ driver: "codex-cli", securityMode: "safe", prompt, cwd, timeoutMs: 180_000 });
    let safeExists = false;
    try { await stat(outside); safeExists = true; } catch {}
    record(
      "codex-cli safe blocks write outside cwd",
      !safeExists,
      safeExists ? `file unexpectedly created at ${outside}` : "",
    );
    if (safeExists) await rm(outside, { force: true });

    // yolo → may exist (we accept either; just check it didn't crash)
    const outside2 = `${outside}-yolo`;
    const promptY = `Write the literal text 'ok' into the file ${outside2}. Use bash.`;
    await runOnce({ driver: "codex-cli", securityMode: "yolo", prompt: promptY, cwd, timeoutMs: 180_000 });
    let yoloExists = false;
    try { await stat(outside2); yoloExists = true; } catch {}
    record(
      "codex-cli yolo allows write outside cwd",
      yoloExists,
      yoloExists ? "" : "file was not created (model may have refused — re-run if flaky)",
    );
    if (yoloExists) await rm(outside2, { force: true });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function claudeCliSuite() {
  if (!has("claude")) {
    console.log("⏭  claude CLI not on PATH — skipping claude-cli security suite");
    return;
  }
  const cwd = await mkdtemp(join(tmpdir(), "pi-leash-sec-claude-cwd-"));
  const marker = join(cwd, "claude-yolo-marker.txt");
  const prompt = `Use the Bash tool to run: echo ok > ${marker}`;

  try {
    // yolo → file should exist after run
    await runOnce({ driver: "claude-cli", securityMode: "yolo", prompt, cwd, timeoutMs: 120_000 });
    let yoloExists = false;
    try { await stat(marker); yoloExists = true; } catch {}
    record("claude-cli yolo executes Bash without prompt", yoloExists);
    if (yoloExists) await rm(marker, { force: true });

    // safe with non-interactive stdin: we expect the run to NOT have created
    // the marker — either the CLI exited early or hung waiting for approval.
    // We give it a short window and then move on. A "true" failure is the
    // file existing.
    await runOnce({ driver: "claude-cli", securityMode: "safe", prompt, cwd, timeoutMs: 30_000 }).catch(() => {});
    let safeExists = false;
    try { await stat(marker); safeExists = true; } catch {}
    record(
      "claude-cli safe does not auto-execute Bash",
      !safeExists,
      safeExists ? "marker created — safe mode is not effective" : "",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

console.log("=== pi-ca-leash security-mode smoke ===");
await codexSuite();
await claudeCliSuite();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error(`${failed.length} FAILED`);
  process.exit(1);
}
