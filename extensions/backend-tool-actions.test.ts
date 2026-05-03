import test from "node:test";
import assert from "node:assert/strict";
import { buildSubagentRunRequest, buildTeamSpawnRequest } from "./backend-tool-actions.ts";

test("buildSubagentRunRequest threads driver, model, async, and cwd", () => {
  assert.deepEqual(buildSubagentRunRequest({
    task: "do work",
    name: "worker",
    prompt: "be brief",
    driver: "claude-sdk",
    model: "o4-mini",
    cwd: "/tmp/run",
    async: true,
  }, "/base"), {
    agent: {
      name: "worker",
      runner: "claude-code-agent",
      prompt: "be brief",
      cwd: "/tmp/run",
      model: "o4-mini",
    },
    task: "do work",
    driver: "claude-sdk",
    cwd: "/tmp/run",
    model: "o4-mini",
    async: true,
  });
});

test("buildSubagentRunRequest falls back to base cwd", () => {
  const request = buildSubagentRunRequest({
    task: "do work",
    name: "worker",
    prompt: "be brief",
    driver: "codex-cli",
    model: undefined,
    cwd: undefined,
    async: false,
  }, "/base");
  assert.equal(request.driver, "codex-cli");
  assert.equal(request.cwd, "/base");
  assert.equal(request.agent.cwd, "/base");
});

test("buildTeamSpawnRequest threads driver and falls back to base cwd", () => {
  assert.deepEqual(buildTeamSpawnRequest({
    name: "teammate",
    prompt: "hello",
    driver: "codex-cli",
    model: "o4-mini",
    cwd: undefined,
  }, "/base"), {
    name: "teammate",
    prompt: "hello",
    driver: "codex-cli",
    model: "o4-mini",
    cwd: "/base",
  });
});
