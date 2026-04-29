export type TeammateBackend = "claude-code-agent";
export type TeamTaskState = "todo" | "assigned" | "in_progress" | "done" | "blocked" | "cancelled";
export type TeammateState = "starting" | "idle" | "busy" | "interrupted" | "stopped" | "errored" | "disconnected";

export interface SpawnTeammateInput {
  name: string;
  prompt: string;
  cwd?: string;
  model?: string;
}

export interface TeamTask {
  taskId: string;
  title: string;
  details: string;
  assignee: string;
  state: TeamTaskState;
  createdAt: string;
  updatedAt: string;
  lastReply?: string;
}

export interface TeammateRecord {
  name: string;
  backend: TeammateBackend;
  sessionId?: string;
  state: TeammateState;
  cwd: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
}

export interface TeamMessageResult {
  teammate: TeammateRecord;
  reply: string;
}

export interface TeamsBackendOptions {
  storageDir?: string;
  bridge?: import("@pi-claude-code-agent/intercom-bridge").ClaudeRuntimeIntercomBridge;
}
