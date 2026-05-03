import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function readPrompt(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./prompts/${name}.md`, import.meta.url)), "utf8").trim();
}

function readPromptBlock(name: string): { snippet: string; guidelines: string[] } {
  const lines = readPrompt(name)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const [snippet = "", ...guidelines] = lines;
  return {
    snippet,
    guidelines: guidelines.map((line) => line.replace(/^- /, "")),
  };
}

export const PEER_BRIDGE_APPEND_SYSTEM_PROMPT = readPrompt("peer-bridge-system").replace(/\s*\n\s*/g, " ");
export const PEER_NO_BABYSITTING_GUIDANCE = readPrompt("peer-no-babysitting");
export const PEER_INIT_GUIDE = readPrompt("peer-init");

export const RUNTIME_MODELS_TOOL_PROMPT = readPromptBlock("runtime-models-tool");
export const PEER_START_TOOL_PROMPT = readPromptBlock("peer-start-tool");
export const PEER_ASK_TOOL_PROMPT = readPromptBlock("peer-ask-tool");
export const PEER_HISTORY_TOOL_PROMPT = readPromptBlock("peer-history-tool");
export const PEER_INTERRUPT_TOOL_PROMPT = readPromptBlock("peer-interrupt-tool");
export const PEER_LIST_TOOL_PROMPT = readPromptBlock("peer-list-tool");
export const PEER_SEND_TOOL_PROMPT = readPromptBlock("peer-send-tool");
export const SUBAGENT_RUN_TOOL_PROMPT = readPromptBlock("subagent-run-tool");
export const PEER_STOP_TOOL_PROMPT = readPromptBlock("peer-stop-tool");
export const SUBAGENT_LIST_TOOL_PROMPT = readPromptBlock("subagent-list-tool");
export const SUBAGENT_STATUS_TOOL_PROMPT = readPromptBlock("subagent-status-tool");
export const TEAM_SPAWN_TOOL_PROMPT = readPromptBlock("team-spawn-tool");
export const TEAM_LIST_TOOL_PROMPT = readPromptBlock("team-list-tool");
export const TEAM_MESSAGE_TOOL_PROMPT = readPromptBlock("team-message-tool");
export const TEAM_STOP_TOOL_PROMPT = readPromptBlock("team-stop-tool");
export const TEAM_TASK_TOOL_PROMPT = readPromptBlock("team-task-tool");
