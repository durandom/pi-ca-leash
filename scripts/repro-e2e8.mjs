// Minimal reproducer for E2E.8: claude-cli driver hangs in `starting`.
// Skips bridge — exercises ClaudeCodeRuntime directly.
import { ClaudeCodeRuntime } from "../packages/runtime/dist/index.js";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const storageDir = mkdtempSync(join(tmpdir(), "repro-e2e8-"));
console.log("[repro] storageDir", storageDir);
const rt = new ClaudeCodeRuntime({ storageDir });

const t0 = Date.now();
rt.subscribe((event) => {
  console.log(`[event +${Date.now() - t0}ms]`, JSON.stringify(event).slice(0, 200));
});

console.log("[repro] starting session driver=claude-cli");
const status = await rt.start({
  driver: "claude-cli",
  prompt: "Reply with the single word: pong",
  cwd: process.cwd(),
});
console.log("[repro] start() returned, status:", { sessionId: status.sessionId, state: status.state });

// Poll until terminal or 30s
const sid = status.sessionId;
const deadline = Date.now() + 30_000;
let last = null;
while (Date.now() < deadline) {
  const s = await rt.status(sid);
  if (!s) throw new Error("session gone");
  if (s.state !== last) {
    console.log(`[poll +${Date.now() - t0}ms] state=${s.state}`);
    last = s.state;
  }
  if (["idle", "interrupted", "failed", "stopped"].includes(s.state)) {
    console.log(`[repro] DONE state=${s.state} elapsed=${Date.now() - t0}ms`);
    process.exit(s.state === "idle" ? 0 : 2);
  }
  await new Promise((r) => setTimeout(r, 200));
}
console.error(`[repro] TIMEOUT state=${last} elapsed=${Date.now() - t0}ms — bug reproduced`);
process.exit(1);
