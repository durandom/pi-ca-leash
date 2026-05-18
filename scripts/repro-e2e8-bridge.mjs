// E2E.8 repro via PiCaLeashManagedPeerApi — same surface spellkave uses.
import { PiCaLeashManagedPeerApi } from "../packages/intercom-bridge/dist/index.js";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const cwd = mkdtempSync(join(tmpdir(), "repro-e2e8-bridge-"));
console.log("[repro] cwd", cwd);
const api = new PiCaLeashManagedPeerApi({ cwd, askTimeoutMs: 30_000 });

const t0 = Date.now();
api.subscribe((e) => {
  console.log(`[event +${Date.now() - t0}ms]`, JSON.stringify(e).slice(0, 600));
});

const name = "work-issue-test-claude-cli";
console.log("[repro] launchPeer driver=claude-cli waitForIdle=false");
const peer = await api.launchPeer({
  name,
  prompt: "Reply with a single word: pong",
  cwd,
  driver: "claude-cli",
  permissionMode: "bypassPermissions",
  tools: ["Read"],
  additionalDirectories: [cwd],
  env: {},
  waitForIdle: false,
  kind: "managed",
});
console.log(`[repro] launch returned sessionId=${peer.sessionId} state=${peer.state} elapsed=${Date.now() - t0}ms`);

const sid = peer.sessionId;
const deadline = Date.now() + 30_000;
let last = null;
while (Date.now() < deadline) {
  const s = await api.statusBySessionId(sid);
  if (!s) throw new Error("session gone");
  if (s.state !== last) {
    console.log(`[poll +${Date.now() - t0}ms] state=${s.state}`);
    last = s.state;
  }
  if (["idle", "interrupted", "errored", "stopped"].includes(s.state)) {
    console.log(`[repro] DONE state=${s.state} elapsed=${Date.now() - t0}ms`);
    process.exit(s.state === "idle" ? 0 : 2);
  }
  await new Promise((r) => setTimeout(r, 200));
}
console.error(`[repro] TIMEOUT last=${last} elapsed=${Date.now() - t0}ms`);
process.exit(1);
