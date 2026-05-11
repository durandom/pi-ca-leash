import test from "node:test";
import assert from "node:assert/strict";
import { parseSubagentRunToolInput, parseTeamSpawnToolInput } from "./tool-inputs.ts";

test("parseSubagentRunToolInput applies defaults and parses codex driver", () => {
  assert.deepEqual(parseSubagentRunToolInput({
    task: "  do work  ",
    driver: "codex-cli",
    async: true,
  }), {
    task: "do work",
    name: "claude-subagent",
    prompt: "You are delegated worker. Be concise and execution-focused.",
    driver: "codex-cli",
    model: undefined,
    cwd: undefined,
    async: true,
  });
});

test("parseSubagentRunToolInput rejects missing task and invalid driver", () => {
  assert.throws(() => parseSubagentRunToolInput({}), /task required/);
  assert.throws(() => parseSubagentRunToolInput({ task: "x", driver: "wat" }), /driver must be claude-sdk, claude-cli, or codex-cli/);
});

test("parseTeamSpawnToolInput trims strings and parses claude driver", () => {
  assert.deepEqual(parseTeamSpawnToolInput({
    name: " worker ",
    prompt: " hello ",
    driver: "claude-sdk",
    model: " o4-mini ",
    cwd: " /tmp ",
  }), {
    name: "worker",
    prompt: "hello",
    driver: "claude-sdk",
    model: "o4-mini",
    cwd: "/tmp",
  });
});

test("parseTeamSpawnToolInput rejects missing required fields and invalid driver", () => {
  assert.throws(() => parseTeamSpawnToolInput({ name: "worker" }), /name and prompt required/);
  assert.throws(() => parseTeamSpawnToolInput({ name: "worker", prompt: "hi", driver: "wat" }), /driver must be claude-sdk, claude-cli, or codex-cli/);
});
