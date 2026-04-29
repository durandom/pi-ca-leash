import type {
  ClaudeCodeRuntime,
  RuntimeEvent,
  RuntimeSessionId,
  RuntimeSessionState,
  RuntimeStatus,
} from "@pi-claude-code-agent/runtime";

export type SubagentRunner = "pi" | "claude-code-agent";
export type SubagentContextMode = "fresh" | "fork";
export type SubagentRunState =
  | "queued"
  | "starting"
  | "running"
  | "idle"
  | "interrupted"
  | "failed"
  | "completed"
  | "stopped";

export interface SubagentDefinition {
  name: string;
  prompt?: string;
  runner?: SubagentRunner;
  cwd?: string;
  model?: string;
}

export interface StartRunInput {
  agent: SubagentDefinition;
  task: string;
  cwd?: string;
  model?: string;
  async?: boolean;
  context?: SubagentContextMode;
}

export interface RunResult {
  summary: string;
  events: RuntimeEvent[];
  runtimeState: RuntimeSessionState;
}

export interface SubagentRunRecord {
  runId: string;
  runner: SubagentRunner;
  agentName: string;
  sessionId?: RuntimeSessionId;
  cwd: string;
  model?: string;
  state: SubagentRunState;
  context: SubagentContextMode;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  task: string;
  result?: RunResult;
  note?: string;
  raw?: Record<string, unknown>;
}

export interface SubagentRunChunk {
  items: RuntimeEvent[];
  nextCursor: number;
}

export interface SubagentBackend {
  readonly runner: SubagentRunner;
  startRun(input: StartRunInput): Promise<SubagentRunRecord>;
  statusRun(runId: string): Promise<SubagentRunRecord | undefined>;
  listRuns(): Promise<SubagentRunRecord[]>;
  eventsRun(runId: string, cursor?: number): Promise<SubagentRunChunk>;
  interruptRun(runId: string): Promise<SubagentRunRecord>;
  stopRun(runId: string): Promise<SubagentRunRecord>;
  collectResult(runId: string): Promise<RunResult | undefined>;
}

export interface RuntimeSubagentBackendOptions {
  runtime?: ClaudeCodeRuntime;
  storageDir?: string;
  pollIntervalMs?: number;
  completionTimeoutMs?: number;
}

export interface PersistedRunStatus {
  runId: string;
  sessionId?: RuntimeSessionId;
  state: SubagentRunState;
  updatedAt: string;
  lastActivityAt: string;
}
