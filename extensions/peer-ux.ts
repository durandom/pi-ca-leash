import { basename } from "node:path";
import type { BridgePeer } from "@pi-claude-code-agent/intercom-bridge";
import type { RuntimeEvent, ToolEvent } from "@pi-claude-code-agent/runtime";

export interface PeerActivityRow {
  name: string;
  state: string;
  activity: string;
  lastUpdateAt: string;
  sessionId: string;
  driver?: string;
  model?: string;
  contextTokens?: number;
  contextWindow?: number;
  contextPercentage?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  reasoningOutputTokens?: number;
}

export function buildPeerActivityRow(peer: BridgePeer, events: RuntimeEvent[]): PeerActivityRow {
  const summary = summarizePeerActivity(peer, events);
  const usage = findLastResultUsage(events);
  return {
    name: peer.name,
    state: summary.state,
    activity: summary.activity,
    lastUpdateAt: peer.updatedAt,
    sessionId: peer.sessionId,
    driver: peer.driver,
    model: peer.model,
    contextTokens: usage?.contextTokens,
    contextWindow: usage?.contextWindow,
    contextPercentage: usage?.contextPercentage,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cacheReadInputTokens: usage?.cacheReadInputTokens,
    reasoningOutputTokens: usage?.reasoningOutputTokens,
  };
}

export function summarizePeerActivity(peer: BridgePeer, events: RuntimeEvent[]): { state: string; activity: string } {
  const lastAssistantText = findLastAssistantText(events);
  const waitingForInput = Boolean(lastAssistantText && looksLikeWaitingForInput(lastAssistantText));

  switch (peer.state) {
    case "errored":
      return {
        state: "error",
        activity: summarizeError(events),
      };
    case "disconnected":
      return {
        state: "offline",
        activity: `last seen ${formatIsoTime(peer.updatedAt, false)}`,
      };
    case "stopped":
      return {
        state: "stopped",
        activity: `last seen ${formatIsoTime(peer.updatedAt, false)}`,
      };
    case "interrupted":
      return {
        state: waitingForInput ? "waiting" : "stopped",
        activity: waitingForInput ? "needs input" : "interrupted",
      };
    default:
      break;
  }

  const activeTool = findActiveTool(events);
  if (["starting", "busy"].includes(peer.state)) {
    if (activeTool) {
      return {
        state: "busy",
        activity: summarizeTool(activeTool),
      };
    }
    return {
      state: "busy",
      activity: peer.state === "starting" ? "starting" : "drafting reply",
    };
  }

  if (waitingForInput) {
    return {
      state: "waiting",
      activity: "needs input",
    };
  }

  if (lastAssistantText) {
    return {
      state: "idle",
      activity: `last reply: ${summarizeReply(lastAssistantText)}`,
    };
  }

  const lastResult = findLastResultSummary(events);
  if (lastResult) {
    return {
      state: "idle",
      activity: `last reply: ${summarizeReply(lastResult)}`,
    };
  }

  return {
    state: "idle",
    activity: "idle",
  };
}

export function getPeerFirstHealth(rows: PeerActivityRow[], transportDegraded: boolean): "idle" | "active" | "warning" {
  if (transportDegraded || rows.some((row) => ["error", "offline", "waiting"].includes(row.state))) {
    return "warning";
  }
  if (rows.some((row) => row.state === "busy")) {
    return "active";
  }
  return "idle";
}

export function isPeerVisibleInWidget(row: PeerActivityRow): boolean {
  return row.state !== "stopped";
}

function findActiveTool(events: RuntimeEvent[]): ToolEvent | undefined {
  return [...events]
    .reverse()
    .find((event): event is ToolEvent => event.type === "tool" && event.phase === "requested");
}

function summarizeTool(event: ToolEvent): string {
  const toolName = event.toolName || "Tool";
  const input = event.input && typeof event.input === "object" ? event.input as Record<string, unknown> : undefined;
  const lowerToolName = toolName.toLowerCase();

  if (lowerToolName === "bash") {
    const command = firstString(input?.command, input?.cmd, input?.script);
    return command ? `Bash: ${truncateInline(command, 36)}` : "Bash";
  }

  if (["read", "view", "open"].includes(lowerToolName)) {
    const path = firstString(input?.path, input?.filePath, input?.file, input?.target_file);
    return path ? `Read: ${compactPath(path)}` : "Read";
  }

  if (["edit", "multiedit", "apply_patch"].includes(lowerToolName)) {
    const path = firstString(input?.path, input?.filePath, input?.file, input?.target_file);
    return path ? `Edit: ${compactPath(path)}` : "Edit";
  }

  if (["write", "create"].includes(lowerToolName)) {
    const path = firstString(input?.path, input?.filePath, input?.file, input?.target_file);
    return path ? `Write: ${compactPath(path)}` : "Write";
  }

  const path = firstString(input?.path, input?.filePath, input?.file, input?.target_file);
  if (path) {
    return `${capitalize(toolName)}: ${compactPath(path)}`;
  }

  return capitalize(toolName);
}

function findLastAssistantText(events: RuntimeEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== "message" || event.role !== "assistant") {
      continue;
    }
    const texts = event.message.blocks
      .filter((block) => block.type !== "thinking")
      .map((block) => block.text?.trim())
      .filter((value): value is string => Boolean(value));
    if (texts.length > 0) {
      return texts.join(" ");
    }
  }
  return undefined;
}

function findLastResultSummary(events: RuntimeEvent[]): string | undefined {
  return [...events]
    .reverse()
    .find((event): event is Extract<RuntimeEvent, { type: "result" }> => event.type === "result")
    ?.summary;
}

function findLastResultUsage(events: RuntimeEvent[]) {
  const event = [...events]
    .reverse()
    .find((entry): entry is Extract<RuntimeEvent, { type: "result" }> => entry.type === "result" && (Boolean(entry.usage) || Boolean(entry.raw)));
  if (!event) {
    return undefined;
  }
  if (event.usage?.contextPercentage != null) {
    return event.usage;
  }
  return {
    ...event.usage,
    ...deriveContextUsageFromRawResult(event.raw, event.usage),
  };
}

function deriveContextUsageFromRawResult(raw: unknown, usage: Extract<RuntimeEvent, { type: "result" }>["usage"] = {}) {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const modelUsage = (raw as Record<string, unknown>).modelUsage;
  if (!modelUsage || typeof modelUsage !== "object") {
    return undefined;
  }

  const entries = Object.values(modelUsage as Record<string, unknown>)
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return undefined;
      }
      const item = entry as Record<string, unknown>;
      const input = numberValue(item.inputTokens);
      const cacheCreation = numberValue(item.cacheCreationInputTokens);
      const cacheRead = numberValue(item.cacheReadInputTokens);
      const contextTokens = [input, cacheCreation, cacheRead]
        .filter((value): value is number => value != null)
        .reduce((sum, value) => sum + value, 0);
      const contextWindow = numberValue(item.contextWindow);
      const maxOutputTokens = numberValue(item.maxOutputTokens);
      return { contextTokens, contextWindow, maxOutputTokens };
    })
    .filter((entry): entry is { contextTokens: number; contextWindow?: number; maxOutputTokens?: number } => Boolean(entry));

  const best = entries.sort((a, b) => b.contextTokens - a.contextTokens)[0];
  if (!best?.contextWindow) {
    return undefined;
  }

  const fallbackContextTokens = [usage.inputTokens, usage.cacheCreationInputTokens, usage.cacheReadInputTokens]
    .filter((value): value is number => value != null)
    .reduce((sum, value) => sum + value, 0);
  const contextTokens = best.contextTokens > 0 ? best.contextTokens : fallbackContextTokens;
  return {
    contextTokens: contextTokens > 0 ? contextTokens : undefined,
    contextWindow: best.contextWindow,
    contextPercentage: contextTokens > 0 ? Math.round((contextTokens / best.contextWindow) * 1000) / 10 : undefined,
    maxOutputTokens: best.maxOutputTokens,
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function summarizeError(events: RuntimeEvent[]): string {
  const error = [...events]
    .reverse()
    .find((event): event is Extract<RuntimeEvent, { type: "error" }> => event.type === "error");
  return error?.message ? `error: ${truncateInline(error.message, 40)}` : "error";
}

function looksLikeWaitingForInput(text: string): boolean {
  const normalized = text.toLowerCase();
  if (normalized.includes("need") && normalized.includes("input")) {
    return true;
  }
  return [
    "please provide",
    "let me know",
    "which ",
    "what ",
    "can you",
    "could you",
    "i need",
    "share the",
  ].some((token) => normalized.includes(token)) || normalized.trim().endsWith("?");
}

function summarizeReply(text: string): string {
  return truncateInline(text.replace(/\s+/g, " ").trim(), 42);
}

function compactPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) {
    return basename(path);
  }
  return parts.length <= 3 ? parts.join("/") : parts.slice(-3).join("/");
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function truncateInline(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function capitalize(value: string): string {
  return value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function formatIsoTime(value: string, includeSeconds: boolean): string {
  const date = new Date(value);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  if (!includeSeconds) {
    return `${hours}:${minutes}`;
  }
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}
