import test from "node:test";
import assert from "node:assert/strict";
import { parsePeerStartCommandInput, parseSubagentRunCommandInput, parseTeamSpawnCommandInput } from "./command-drivers.ts";

test("parsePeerStartCommandInput supports old and driver-aware forms", () => {
  assert.deepEqual(parsePeerStartCommandInput("Investigate flaky tests"), { prompt: "Investigate flaky tests", autoNamed: true });
  assert.deepEqual(parsePeerStartCommandInput("codex-cli | Investigate flaky tests"), { prompt: "Investigate flaky tests", driver: "codex-cli", autoNamed: true });
  assert.deepEqual(parsePeerStartCommandInput("claude-cli | Investigate flaky tests"), { prompt: "Investigate flaky tests", driver: "claude-cli", autoNamed: true });
  assert.deepEqual(parsePeerStartCommandInput("Investigate flaky tests | codex-cli | gpt-5.4-mini"), { prompt: "Investigate flaky tests", driver: "codex-cli", model: "gpt-5.4-mini", autoNamed: true });
  assert.deepEqual(parsePeerStartCommandInput("reviewer | Review auth flow"), { name: "reviewer", prompt: "Review auth flow", autoNamed: false });
  assert.deepEqual(parsePeerStartCommandInput("reviewer | Review auth flow | claude-sdk"), { name: "reviewer", prompt: "Review auth flow", driver: "claude-sdk", autoNamed: false });
  assert.deepEqual(parsePeerStartCommandInput("reviewer | Review auth flow | claude-sdk | claude-sonnet-4-6"), { name: "reviewer", prompt: "Review auth flow", driver: "claude-sdk", model: "claude-sonnet-4-6", autoNamed: false });
});

test("parsePeerStartCommandInput rejects invalid driver or too many fields", () => {
  assert.throws(() => parsePeerStartCommandInput("reviewer | Review auth flow | wat"), /driver must be claude-sdk, claude-cli, or codex-cli/);
  assert.throws(() => parsePeerStartCommandInput("a | b | c | d | e"), /usage: <prompt> \| \[driver\] \| \[model\] OR <name> \| <prompt> \| \[driver\] \| \[model\]/);
});

test("parseSubagentRunCommandInput supports plain task and driver prefix", () => {
  assert.deepEqual(parseSubagentRunCommandInput("do work"), { task: "do work" });
  assert.deepEqual(parseSubagentRunCommandInput("codex-cli | do work"), { driver: "codex-cli", task: "do work" });
  assert.deepEqual(parseSubagentRunCommandInput("claude-sdk | do | work"), { driver: "claude-sdk", task: "do | work" });
});

test("parseSubagentRunCommandInput rejects invalid driver in piped form", () => {
  assert.throws(() => parseSubagentRunCommandInput("wat | do work"), /driver must be claude-sdk, claude-cli, or codex-cli/);
});

test("parseTeamSpawnCommandInput supports old and new forms", () => {
  assert.deepEqual(parseTeamSpawnCommandInput("worker | hello"), { name: "worker", prompt: "hello" });
  assert.deepEqual(parseTeamSpawnCommandInput("worker | hello | codex-cli"), { name: "worker", prompt: "hello", driver: "codex-cli" });
});

test("parseTeamSpawnCommandInput rejects invalid driver or too many fields", () => {
  assert.throws(() => parseTeamSpawnCommandInput("worker | hello | wat"), /driver must be claude-sdk, claude-cli, or codex-cli/);
  assert.throws(() => parseTeamSpawnCommandInput("worker | hello | codex-cli | extra"), /usage: <name> \| <prompt> \| \[driver\]/);
});
