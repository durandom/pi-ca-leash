import type { StartRunInput } from "@pi-claude-code-agent/subagents-backend";
import type { SpawnTeammateInput } from "@pi-claude-code-agent/teams-backend";
import type { ParsedSubagentRunToolInput, ParsedTeamSpawnToolInput } from "./tool-inputs.js";

export function buildSubagentRunRequest(input: ParsedSubagentRunToolInput, baseCwd: string): StartRunInput {
  const cwd = input.cwd ?? baseCwd;
  return {
    agent: {
      name: input.name,
      runner: "claude-code-agent",
      prompt: input.prompt,
      cwd,
      model: input.model,
    },
    task: input.task,
    driver: input.driver,
    cwd,
    model: input.model,
    async: input.async,
  };
}

export function buildTeamSpawnRequest(input: ParsedTeamSpawnToolInput, baseCwd: string): SpawnTeammateInput {
  return {
    name: input.name,
    prompt: input.prompt,
    driver: input.driver,
    model: input.model,
    cwd: input.cwd ?? baseCwd,
  };
}
