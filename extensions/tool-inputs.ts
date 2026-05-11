import { parseRuntimeDriverName } from "./runtime-driver.js";
import type { RuntimeDriverName } from "@pi-claude-code-agent/runtime";

export interface ParsedSubagentRunToolInput {
  task: string;
  name: string;
  prompt: string;
  driver?: RuntimeDriverName;
  model?: string;
  cwd?: string;
  async: boolean;
}

export interface ParsedTeamSpawnToolInput {
  name: string;
  prompt: string;
  driver?: RuntimeDriverName;
  model?: string;
  cwd?: string;
}

const DEFAULT_SUBAGENT_NAME = "claude-subagent";
const DEFAULT_SUBAGENT_PROMPT = "You are delegated worker. Be concise and execution-focused.";

export function parseSubagentRunToolInput(input: {
  task?: unknown;
  name?: unknown;
  prompt?: unknown;
  driver?: unknown;
  model?: unknown;
  cwd?: unknown;
  async?: unknown;
}): ParsedSubagentRunToolInput {
  const task = String(input.task ?? "").trim();
  if (!task) {
    throw new Error("task required");
  }

  const driver = input.driver == null ? undefined : parseRuntimeDriverName(input.driver);
  if (input.driver != null && !driver) {
    throw new Error("driver must be claude-sdk, claude-cli, or codex-cli");
  }

  return {
    task,
    name: typeof input.name === "string" ? input.name.trim() || DEFAULT_SUBAGENT_NAME : DEFAULT_SUBAGENT_NAME,
    prompt: typeof input.prompt === "string" ? input.prompt.trim() || DEFAULT_SUBAGENT_PROMPT : DEFAULT_SUBAGENT_PROMPT,
    driver,
    model: typeof input.model === "string" ? input.model.trim() || undefined : undefined,
    cwd: typeof input.cwd === "string" ? input.cwd.trim() || undefined : undefined,
    async: input.async === true,
  };
}

export function parseTeamSpawnToolInput(input: {
  name?: unknown;
  prompt?: unknown;
  driver?: unknown;
  model?: unknown;
  cwd?: unknown;
}): ParsedTeamSpawnToolInput {
  const name = String(input.name ?? "").trim();
  const prompt = String(input.prompt ?? "").trim();
  if (!name || !prompt) {
    throw new Error("name and prompt required");
  }

  const driver = input.driver == null ? undefined : parseRuntimeDriverName(input.driver);
  if (input.driver != null && !driver) {
    throw new Error("driver must be claude-sdk, claude-cli, or codex-cli");
  }

  return {
    name,
    prompt,
    driver,
    model: typeof input.model === "string" ? input.model.trim() || undefined : undefined,
    cwd: typeof input.cwd === "string" ? input.cwd.trim() || undefined : undefined,
  };
}
