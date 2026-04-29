#!/usr/bin/env node
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeCodeRuntime } from "./runtime.js";

const runtime = new ClaudeCodeRuntime();
const prompt = process.argv.slice(2).join(" ") || "Reply with exactly: smoke-ok";

const session = await runtime.start({
  prompt,
  name: "runtime-smoke",
  permissionMode: "bypassPermissions",
});

console.log(`started ${session.sessionId}`);

for (;;) {
  const status = await runtime.status(session.sessionId);
  if (!status) {
    throw new Error("session disappeared");
  }
  if (["idle", "failed", "stopped", "interrupted"].includes(status.state)) {
    console.log(JSON.stringify(status, null, 2));
    const tail = await runtime.tail(session.sessionId, 10);
    console.log(JSON.stringify(tail, null, 2));
    break;
  }
  await delay(500);
}
