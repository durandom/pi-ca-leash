#!/usr/bin/env node
import { ClaudeCodeSubagentBackend } from "./backend.js";

const backend = new ClaudeCodeSubagentBackend();
const task = process.argv.slice(2).join(" ") || "Reply with exactly: subagent-ok";

const run = await backend.startRun({
  agent: {
    name: "demo-subagent",
    runner: "claude-code-agent",
    prompt: "You are demo delegated worker. Reply briefly.",
  },
  task,
});

console.log(JSON.stringify(run, null, 2));
console.log(JSON.stringify(await backend.collectResult(run.runId), null, 2));
