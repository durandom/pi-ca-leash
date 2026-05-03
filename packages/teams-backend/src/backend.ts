import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ClaudeRuntimeIntercomBridge } from "@pi-claude-code-agent/intercom-bridge";
import { defaultTeamsDir, listTasks, listTeammates, readTask, readTeammate, writeTask, writeTeammate } from "./persistence.js";
import type { SpawnTeammateInput, TeamMessageResult, TeamTask, TeamsBackendOptions, TeammateRecord, TeammateState } from "./types.js";

export class ClaudeCodeTeamsBackend {
  private readonly bridge: ClaudeRuntimeIntercomBridge;
  private readonly storageDir: string;
  private readonly ready: Promise<void>;

  constructor(options: TeamsBackendOptions = {}) {
    this.bridge = options.bridge ?? new ClaudeRuntimeIntercomBridge();
    this.storageDir = resolve(options.storageDir ?? defaultTeamsDir());
    this.ready = this.restoreTeammates();
  }

  async spawnTeammate(input: SpawnTeammateInput): Promise<TeammateRecord> {
    await this.ready;
    const existing = await readTeammate(this.storageDir, input.name);
    if (existing) {
      throw new Error(`Teammate ${input.name} already exists`);
    }
    const peer = await this.bridge.launchPeer({
      name: input.name,
      prompt: input.prompt,
      driver: input.driver,
      cwd: input.cwd,
      model: input.model,
    });
    const record = this.recordFromPeer(peer.name, peer.sessionId, peer.cwd, peer.driver, peer.model, mapState(peer.state), peer.createdAt, peer.updatedAt, peer.lastActivityAt);
    await writeTeammate(this.storageDir, record);
    return record;
  }

  async listTeammates(): Promise<TeammateRecord[]> {
    await this.ready;
    const teammates = await listTeammates(this.storageDir);
    return teammates.sort((a, b) => a.name.localeCompare(b.name));
  }

  async teammateStatus(name: string): Promise<TeammateRecord | undefined> {
    await this.ready;
    const record = await readTeammate(this.storageDir, name);
    if (!record) {
      return undefined;
    }
    const peer = await this.bridge.status(name);
    if (!peer) {
      return record;
    }
    const next = this.recordFromPeer(peer.name, peer.sessionId, peer.cwd, peer.driver, peer.model, mapState(peer.state), record.createdAt, peer.updatedAt, peer.lastActivityAt);
    await writeTeammate(this.storageDir, next);
    return next;
  }

  async assignTask(input: { assignee: string; title: string; details: string }): Promise<TeamTask> {
    await this.ready;
    const teammate = await this.requireTeammate(input.assignee);
    const now = new Date().toISOString();
    const task: TeamTask = {
      taskId: randomUUID(),
      title: input.title,
      details: input.details,
      assignee: teammate.name,
      state: "assigned",
      createdAt: now,
      updatedAt: now,
    };
    await writeTask(this.storageDir, task);

    const result = await this.bridge.ask(teammate.name, {
      from: "team-board",
      text: formatTaskAssignment(task),
    });

    task.state = classifyTaskReply(result.reply);
    task.updatedAt = new Date().toISOString();
    task.lastReply = result.reply;
    await writeTask(this.storageDir, task);
    await this.teammateStatus(teammate.name);
    return task;
  }

  async sendMessage(name: string, text: string): Promise<TeamMessageResult> {
    await this.ready;
    await this.requireTeammate(name);
    const result = await this.bridge.ask(name, {
      from: "team-chat",
      text,
    });
    const teammate = await this.teammateStatus(name);
    if (!teammate) {
      throw new Error(`Teammate ${name} disappeared`);
    }
    return { teammate, reply: result.reply };
  }

  async markTaskDone(taskId: string, note?: string): Promise<TeamTask> {
    await this.ready;
    const task = await this.requireTask(taskId);
    task.state = "done";
    task.updatedAt = new Date().toISOString();
    if (note) {
      task.lastReply = note;
    }
    await writeTask(this.storageDir, task);
    return task;
  }

  async listTasks(): Promise<TeamTask[]> {
    await this.ready;
    const tasks = await listTasks(this.storageDir);
    return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async stopTeammate(name: string): Promise<TeammateRecord> {
    await this.ready;
    const teammate = await this.requireTeammate(name);
    const peer = await this.bridge.stop(name);
    const next = this.recordFromPeer(name, teammate.sessionId, teammate.cwd, peer.driver ?? teammate.driver, teammate.model, mapState(peer.state), teammate.createdAt, peer.updatedAt, peer.lastActivityAt);
    await writeTeammate(this.storageDir, next);
    return next;
  }

  private async restoreTeammates(): Promise<void> {
    const teammates = await listTeammates(this.storageDir);
    for (const teammate of teammates) {
      if (!teammate.sessionId) {
        continue;
      }
      try {
        const peer = await this.bridge.attachPeer({ name: teammate.name, sessionId: teammate.sessionId });
        if (teammate.driver == null) {
          const next = this.recordFromPeer(peer.name, peer.sessionId, peer.cwd, peer.driver, peer.model, mapState(peer.state), teammate.createdAt, peer.updatedAt, peer.lastActivityAt);
          await writeTeammate(this.storageDir, next);
        }
      } catch {
        // Ignore stale bridge/session records.
      }
    }
  }

  private async requireTeammate(name: string): Promise<TeammateRecord> {
    const teammate = await readTeammate(this.storageDir, name);
    if (!teammate) {
      throw new Error(`Unknown teammate ${name}`);
    }
    return teammate;
  }

  private async requireTask(taskId: string): Promise<TeamTask> {
    const task = await readTask(this.storageDir, taskId);
    if (!task) {
      throw new Error(`Unknown task ${taskId}`);
    }
    return task;
  }

  private recordFromPeer(
    name: string,
    sessionId: string | undefined,
    cwd: string,
    driver: import("@pi-claude-code-agent/runtime").RuntimeDriverName | undefined,
    model: string | undefined,
    state: TeammateState,
    createdAt: string,
    updatedAt: string,
    lastActivityAt: string,
  ): TeammateRecord {
    return {
      name,
      backend: "claude-code-agent",
      sessionId,
      state,
      cwd,
      driver,
      model,
      createdAt,
      updatedAt,
      lastActivityAt,
    };
  }
}

function formatTaskAssignment(task: TeamTask): string {
  return [`Task: ${task.title}`, task.details, "Reply with progress and intended next step."].join("\n\n");
}

function classifyTaskReply(reply: string): TeamTask["state"] {
  const normalized = reply.trim().toLowerCase();
  if (normalized.startsWith("done:") || normalized.startsWith("completed:") || normalized.includes("task complete")) {
    return "done";
  }
  if (normalized.startsWith("blocked:") || normalized.includes("blocked")) {
    return "blocked";
  }
  return "in_progress";
}

function mapState(state: import("@pi-claude-code-agent/intercom-bridge").BridgeState): TeammateState {
  switch (state) {
    case "starting":
      return "starting";
    case "busy":
      return "busy";
    case "idle":
    case "connected":
      return "idle";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "errored":
      return "errored";
    case "disconnected":
      return "disconnected";
    default:
      return "errored";
  }
}

export { classifyTaskReply, formatTaskAssignment, mapState };
