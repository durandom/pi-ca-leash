#!/usr/bin/env node
import { ClaudeCodeTeamsBackend } from "./backend.js";

const backend = new ClaudeCodeTeamsBackend();
const prompt = process.argv.slice(2).join(" ") || "You are persistent teammate. Reply briefly.";

const teammate = await backend.spawnTeammate({ name: "demo-teammate", prompt });
console.log("spawned", JSON.stringify(teammate, null, 2));

const task = await backend.assignTask({
  assignee: "demo-teammate",
  title: "Demo task",
  details: "Reply with exactly: team-ok",
});
console.log("task", JSON.stringify(task, null, 2));

const message = await backend.sendMessage("demo-teammate", "What are you doing?");
console.log("message", JSON.stringify(message, null, 2));

const stopped = await backend.stopTeammate("demo-teammate");
console.log("stopped", JSON.stringify(stopped, null, 2));
