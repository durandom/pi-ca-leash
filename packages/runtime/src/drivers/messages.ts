export interface NormalizedDriverMessageBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  content?: unknown;
  isError?: boolean;
  raw?: unknown;
}

export interface NormalizedDriverUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  totalCostUsd?: number;
  raw?: unknown;
}

interface NormalizedDriverMessageBase {
  raw?: unknown;
  metadata?: Record<string, unknown>;
}

export interface SystemDriverMessage extends NormalizedDriverMessageBase {
  type: "system";
  subtype?: string;
  sessionId?: string;
  cwd?: string;
  model?: string;
}

export interface AssistantDriverMessage extends NormalizedDriverMessageBase {
  type: "assistant";
  blocks: NormalizedDriverMessageBlock[];
  model?: string;
}

export interface ToolUseDriverMessage extends NormalizedDriverMessageBase {
  type: "tool_use";
  toolName: string;
  toolUseId?: string;
  input?: unknown;
}

export interface ToolResultDriverMessage extends NormalizedDriverMessageBase {
  type: "tool_result";
  role?: "user" | "tool";
  blocks?: NormalizedDriverMessageBlock[];
  toolName: string;
  toolUseId?: string;
  output?: unknown;
  isError?: boolean;
}

export interface ResultDriverMessage extends NormalizedDriverMessageBase {
  type: "result";
  ok: boolean;
  summary: string;
  stopReason?: string;
  usage?: NormalizedDriverUsage;
}

export interface ErrorDriverMessage extends NormalizedDriverMessageBase {
  type: "error";
  message: string;
  code?: string;
}

export interface StreamEventDriverMessage extends NormalizedDriverMessageBase {
  type: "stream_event";
  summary: string;
}

export type NormalizedDriverMessage =
  | SystemDriverMessage
  | AssistantDriverMessage
  | ToolUseDriverMessage
  | ToolResultDriverMessage
  | ResultDriverMessage
  | ErrorDriverMessage
  | StreamEventDriverMessage;
