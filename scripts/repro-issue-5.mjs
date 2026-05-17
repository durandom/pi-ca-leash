// Reproducer for pi-ca-leash issue #5:
//   pi-coding-agent driver: session resume is silently a no-op.
//
// Run: `node scripts/repro-issue-5.mjs`
//
// Findings:
//   1. SessionManager._persist() ONLY flushes the JSONL file once an
//      `assistant` message has been appended (session-manager.js:552).
//      Before that, every entry — including thinking-level changes — sits in
//      memory. If the peer exits before a successful assistant turn lands,
//      nothing is ever written and continueRecent() finds nothing.
//   2. continueRecent(cwd) NEVER errors when no file exists. It silently
//      returns a fresh SessionManager with a new sessionId. The driver has
//      no way to tell "I tried to resume but there was nothing to resume."
//   3. When a file IS on disk (after an assistant turn flushed), continueRecent
//      finds it and createAgentSession({ sessionManager }) restores the
//      same sessionId. The resume mechanism itself works.
//
// Conclusion: the driver does NOT have a code bug at pi-coding-agent.ts:248
// per se — continueRecent works. The bug is that the driver passes
// continueRecent's silent-no-op result downstream as if resume succeeded,
// even when it didn't. The init event still reports a "session id" but it
// is a NEW id, and resumed status is never surfaced.
//
// Recommended driver fix (no SDK change needed):
//   - After calling continueRecent, compare the returned sessionId against
//     the prior session file (sessionManager.getSessionFile() existsSync?
//     entries non-empty?) to determine actual resume.
//   - Emit `resumed: <bool>` and `resumeSupported: true` on the init system
//     event, mirroring what claude-sdk surfaces, so downstream callers like
//     spellkave can see when resume silently failed and adapt.

import { mkdtempSync, existsSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sdk = await import("@earendil-works/pi-coding-agent");
const { createAgentSession, SessionManager } = sdk;

const cwd = mkdtempSync(join(tmpdir(), "pi-repro-"));
console.log("cwd:", cwd);

// Helper: write a session file the way a completed turn would --------------
function seedSessionWithAssistantTurn(cwd) {
  const sm = SessionManager.create(cwd);
  // appendMessage with role=assistant triggers the flush of buffered entries
  sm.appendThinkingLevelChange("high");
  sm.appendMessage({
    role: "user",
    content: [{ type: "text", text: "hello" }],
  });
  sm.appendMessage({
    role: "assistant",
    model: "test/seed",
    content: [{ type: "text", text: "hi" }],
    usage: { input: 10, output: 5 },
    stopReason: "end_turn",
  });
  return sm;
}

// --- Scenario A: cold cwd, nothing on disk → continueRecent silently no-ops -
{
  const sm = SessionManager.continueRecent(cwd);
  console.log("\n[A] no prior write");
  console.log("    continueRecent id:        ", sm.getSessionId());
  console.log("    file on disk?:            ", existsSync(sm.getSessionFile()));
  console.log("    => caller cannot distinguish 'fresh' from 'failed resume'");
}

// --- Seed a real persisted session ----------------------------------------
const seeded = seedSessionWithAssistantTurn(cwd);
console.log("\n[seed] persisted sessionId: ", seeded.getSessionId());
console.log("[seed] file:                ", seeded.getSessionFile());
console.log("[seed] file on disk?:       ", existsSync(seeded.getSessionFile()));
if (existsSync(seeded.getSessionFile())) {
  const lines = readFileSync(seeded.getSessionFile(), "utf8").trim().split("\n");
  console.log("[seed] entries written:     ", lines.length);
}

// --- Scenario B: prior write present → continueRecent resumes correctly ---
{
  const sm = SessionManager.continueRecent(cwd);
  console.log("\n[B] file present");
  console.log("    continueRecent id:        ", sm.getSessionId());
  console.log("    matches seeded?:          ", sm.getSessionId() === seeded.getSessionId());

  // Now run the FULL driver code path: createAgentSession({ sessionManager })
  const { session } = await createAgentSession({
    cwd,
    tools: ["read"],
    thinkingLevel: "high",
    sessionManager: sm,
  });
  console.log("    createAgentSession id:    ", session.sessionId);
  console.log("    matches seeded?:          ", session.sessionId === seeded.getSessionId());
  session.dispose?.();
}

// --- Scenario C: simulate the spellkave shape — peer 1 runs, peer 2 resumes -
// In real life pi-ca-leash creates a fresh PiCodingAgentDriver run() per
// turn. We mimic that here: run, exit (dispose), then run again with
// resumeSessionId set.
{
  console.log("\n[C] two-peer round-trip via the actual driver code path");
  // Peer 1: cold start. We have to manually persist something the SDK would
  // have persisted naturally during a real turn — without an LLM call, no
  // assistant message lands and nothing flushes.
  const { session: peer1 } = await createAgentSession({
    cwd,
    tools: ["read"],
    thinkingLevel: "high",
  });
  console.log("    peer1 sessionId:          ", peer1.sessionId);
  console.log("    peer1 file on disk?:      ", existsSync(peer1.sessionFile),
    "  <-- no assistant turn ⇒ no flush ⇒ no resume target");
  peer1.dispose?.();

  // Peer 2: tries to resume.
  const sm = SessionManager.continueRecent(cwd);
  const { session: peer2 } = await createAgentSession({
    cwd,
    tools: ["read"],
    thinkingLevel: "high",
    sessionManager: sm,
  });
  console.log("    peer2 sessionId:          ", peer2.sessionId);
  console.log("    matches peer1?:           ", peer2.sessionId === peer1.sessionId,
    "  <-- bug surface: silently a fresh session");
  peer2.dispose?.();
}

// --- Inspect on-disk session dir ------------------------------------------
const encoded = cwd.replace(/^\//, "").replace(/\//g, "-");
const dir = `${process.env.HOME}/.pi/agent/sessions/--${encoded}--`;
console.log("\nsession dir:", dir);
console.log("contents:   ", existsSync(dir) ? readdirSync(dir) : "(missing)");

rmSync(cwd, { recursive: true, force: true });
