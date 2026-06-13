#!/usr/bin/env node
/**
 * Opt-in live E2E smoke for the `claude-pty` driver — drives the REAL Claude
 * Code interactive TUI in a PTY and observes it via the session transcript
 * JSONL + a Stop hook.
 *
 * What it proves end-to-end (things the fake-PTY unit tests cannot):
 *   1. A bare interactive `claude` launches in a PTY, accepts a typed prompt,
 *      and we recover the assistant's reply from the transcript JSONL
 *      (validates the real transcript schema against parseClaudeSdkMessage).
 *   2. The Stop hook fires and the turn resolves (deterministic turn-end).
 *   3. Context stays HOT across turns — a second send() reuses the live
 *      process and the model still remembers turn 1 (no --resume reload).
 *   4. stop() types `/quit` and the session tears down cleanly.
 *
 * Skips (exit 0) when `claude` or `node-pty` is absent. Exits non-zero on a
 * present-prereq assertion failure.
 *
 * Run:  node scripts/smoke-pty.mjs
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
  return await import(join(repoRoot, "packages/runtime/dist/internal.js"));
}

function python3Available() {
  // The default PTY allocator shells out to python3 (stdlib `pty`); no compile.
  return spawnSync("python3", ["-c", "import pty"], { stdio: "ignore" }).status === 0;
}

async function waitFor(runtime, sessionId, predicate, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await runtime.status(sessionId);
    if (status && predicate(status)) return status;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting on session ${sessionId}`);
}

async function assistantText(runtime, sessionId) {
  const transcript = await runtime.readTranscript(sessionId);
  const chunks = [];
  for (const item of transcript.items) {
    if (item.type === "message" && item.message?.role === "assistant") {
      for (const block of item.message.blocks ?? []) {
        if (block.type === "text" && block.text) chunks.push(block.text);
      }
    }
  }
  return chunks.join("\n");
}

const SETTLED = (s) => ["idle", "stopped", "interrupted", "failed"].includes(s.state);

async function main() {
  if (!has("claude")) {
    console.log("- skip: `claude` not on PATH");
    return;
  }
  if (!python3Available()) {
    console.log("- skip: python3 (with stdlib `pty`) not available — required by the PTY allocator");
    return;
  }

  // Build with the latest source so we test what we just changed.
  const build = spawnSync("npm", ["run", "build", "--workspace", "@pi-claude-code-agent/runtime"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (build.status !== 0) throw new Error("runtime build failed");

  const { ClaudeCodeRuntime } = await importRuntime();
  const storageDir = await mkdtemp(join(tmpdir(), "pi-leash-pty-store-"));
  const cwd = await mkdtemp(join(tmpdir(), "pi-leash-pty-cwd-"));
  const runtime = new ClaudeCodeRuntime({ storageDir });
  const token = `pty-${Math.random().toString(36).slice(2, 8)}`;
  const failures = [];

  try {
    // ── Turn 1: establish context (a magic number) and a deterministic echo.
    console.log(`\n=== claude-pty turn 1 (token=${token}) ===`);
    const session = await runtime.start({
      prompt:
        `Remember the magic number 4242. ` +
        `Then reply with exactly this token and nothing else: ${token}`,
      driver: "claude-pty",
      cwd,
      securityMode: "yolo",
    });
    const s1 = await waitFor(runtime, session.sessionId, SETTLED);
    if (s1.state !== "idle") {
      throw new Error(`turn 1 ended in ${s1.state}: ${JSON.stringify(s1.lastError)}`);
    }
    const reply1 = await assistantText(runtime, session.sessionId);
    if (reply1.includes(token)) {
      console.log(`✓ turn 1: assistant reply recovered from transcript (contains ${token})`);
    } else {
      failures.push(`turn 1: token ${token} not found in assistant reply: ${JSON.stringify(reply1.slice(0, 200))}`);
    }

    // ── Turn 2: hot-context check. Reuses the live PTY process; the model
    //    should still recall the number from turn 1 without any --resume.
    console.log(`=== claude-pty turn 2 (hot context) ===`);
    await runtime.send({
      sessionId: session.sessionId,
      message: "What magic number did I ask you to remember? Reply with just the digits.",
      securityMode: "yolo",
    });
    const s2 = await waitFor(runtime, session.sessionId, SETTLED);
    if (s2.state !== "idle") {
      throw new Error(`turn 2 ended in ${s2.state}: ${JSON.stringify(s2.lastError)}`);
    }
    const reply2 = await assistantText(runtime, session.sessionId);
    // reply2 is the full transcript text; check the latest portion contains 4242.
    if (reply2.includes("4242")) {
      console.log("✓ turn 2: hot context preserved across turns (recalled 4242)");
    } else {
      failures.push(`turn 2: model did not recall 4242 — context not hot. reply tail: ${JSON.stringify(reply2.slice(-200))}`);
    }

    // ── Teardown: /quit via dispose().
    await runtime.stop(session.sessionId);
    const s3 = await runtime.status(session.sessionId);
    if (s3?.state === "stopped") {
      console.log("✓ stop(): session torn down (/quit)");
    } else {
      failures.push(`stop(): expected stopped, got ${s3?.state}`);
    }
  } finally {
    await rm(storageDir, { recursive: true, force: true }).catch(() => {});
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }

  if (failures.length > 0) {
    console.error(`\n✗ claude-pty smoke FAILED:\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("\n✓ claude-pty live smoke passed");
}

main().catch((err) => {
  console.error(`\n✗ claude-pty smoke error: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
