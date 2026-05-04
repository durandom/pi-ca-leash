import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverEventEnvelope, RuntimeDriver, RuntimeDriverRunHandle, RuntimeDriverRunInput } from "@pi-claude-code-agent/runtime";
import { ClaudeCodeRuntime } from "@pi-claude-code-agent/runtime";
import { ClaudeRuntimeIntercomBridge } from "@pi-claude-code-agent/intercom-bridge";
import { ClaudeCodeTeamsBackend, formatTaskAssignment } from "../src/index.js";

class FakeDriver implements RuntimeDriver {
  constructor(readonly name = "claude-sdk" as const) {}

  run(input: RuntimeDriverRunInput, onEvent: (event: DriverEventEnvelope) => Promise<void> | void): RuntimeDriverRunHandle {
    let interrupted = false;
    const done = (async () => {
      await onEvent({ type: "raw", payload: { type: "system", subtype: "init", session_id: input.resumeSessionId ?? input.sessionId, model: input.model ?? "fake-model" } });
      const text = input.prompt.includes("Ship it")
        ? "DONE: shipped"
        : `teammate:${input.prompt}`;
      await onEvent({ type: "raw", payload: { type: "assistant", message: { content: [{ type: "text", text }] } } });
      await onEvent({ type: "raw", payload: { type: "result", is_error: false, result: `done:${input.prompt}`, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } } });
      return { code: interrupted ? 130 : 0, signal: interrupted ? "SIGINT" : null } as const;
    })();
    return {
      kill() {
        interrupted = true;
      },
      done,
    };
  }
}

test("spawn teammate, assign task, exchange message, stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-teams-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(dir, "runtime"), driver: new FakeDriver() });
  const bridge = new ClaudeRuntimeIntercomBridge({ runtime, storageDir: join(dir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 2_000 });
  const backend = new ClaudeCodeTeamsBackend({ storageDir: join(dir, "teams"), bridge });

  const teammate = await backend.spawnTeammate({ name: "worker", prompt: "You are teammate." });
  assert.equal(teammate.state, "idle");

  const task = await backend.assignTask({ assignee: "worker", title: "Investigate", details: "Look at logs" });
  assert.equal(task.state, "in_progress");
  assert.match(task.lastReply ?? "", /teammate:\[intercom kind=ask from=team-board\]/);

  const message = await backend.sendMessage("worker", "Need update");
  assert.match(message.reply, /teammate:\[intercom kind=ask from=team-chat\]/);

  const stopped = await backend.stopTeammate("worker");
  assert.equal(stopped.state, "stopped");
});

test("explicit codex driver is passed through and persisted on teammate record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-teams-test-"));
  const defaultDriver = new FakeDriver("claude-sdk");
  const codexDriver = new FakeDriver("codex-cli");
  const runtime = new ClaudeCodeRuntime({
    storageDir: join(dir, "runtime"),
    driver: defaultDriver,
    drivers: { "codex-cli": codexDriver },
  });
  const bridge = new ClaudeRuntimeIntercomBridge({ runtime, storageDir: join(dir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 2_000 });
  const backend = new ClaudeCodeTeamsBackend({ storageDir: join(dir, "teams"), bridge });

  const teammate = await backend.spawnTeammate({ name: "worker", prompt: "You are teammate.", driver: "codex-cli" });
  assert.equal(teammate.driver, "codex-cli");

  const persisted = await backend.teammateStatus("worker");
  assert.equal(persisted?.driver, "codex-cli");
});

test("backend restore backfills missing teammate driver", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-teams-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(dir, "runtime"), driver: new FakeDriver("codex-cli") });
  const bridge1 = new ClaudeRuntimeIntercomBridge({ runtime, storageDir: join(dir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 2_000 });
  const backend1 = new ClaudeCodeTeamsBackend({ storageDir: join(dir, "teams"), bridge: bridge1 });

  const spawned = await backend1.spawnTeammate({ name: "worker", prompt: "You are teammate.", driver: "codex-cli" });
  const teammateFile = join(dir, "teams", "teammates", "worker.json");
  const persisted = JSON.parse(await (await import("node:fs/promises")).readFile(teammateFile, "utf8"));
  delete persisted.driver;
  await (await import("node:fs/promises")).writeFile(teammateFile, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

  const bridge2 = new ClaudeRuntimeIntercomBridge({ runtime, storageDir: join(dir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 2_000 });
  const backend2 = new ClaudeCodeTeamsBackend({ storageDir: join(dir, "teams"), bridge: bridge2 });
  const teammates = await backend2.listTeammates();
  assert.equal(teammates[0]?.driver, "codex-cli");
  assert.equal(spawned.driver, "codex-cli");
});

test("backend restores persisted teammates after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-teams-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(dir, "runtime"), driver: new FakeDriver() });
  const bridge1 = new ClaudeRuntimeIntercomBridge({ runtime, storageDir: join(dir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 2_000 });
  const backend1 = new ClaudeCodeTeamsBackend({ storageDir: join(dir, "teams"), bridge: bridge1 });

  await backend1.spawnTeammate({ name: "worker", prompt: "You are teammate." });

  const bridge2 = new ClaudeRuntimeIntercomBridge({ runtime, storageDir: join(dir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 2_000 });
  const backend2 = new ClaudeCodeTeamsBackend({ storageDir: join(dir, "teams"), bridge: bridge2 });

  const teammates = await backend2.listTeammates();
  assert.equal(teammates.length, 1);

  const message = await backend2.sendMessage("worker", "Need update");
  assert.match(message.reply, /teammate:\[intercom kind=ask from=team-chat\]/);
});

test("done-like replies auto-complete tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-teams-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(dir, "runtime"), driver: new FakeDriver() });
  const bridge = new ClaudeRuntimeIntercomBridge({ runtime, storageDir: join(dir, "bridge"), pollIntervalMs: 5, askTimeoutMs: 2_000 });
  const backend = new ClaudeCodeTeamsBackend({ storageDir: join(dir, "teams"), bridge });

  await backend.spawnTeammate({ name: "worker", prompt: "You are teammate." });
  const task = await backend.assignTask({ assignee: "worker", title: "Ship it", details: "Finish work" });
  assert.equal(task.state, "done");
  assert.match(task.lastReply ?? "", /^DONE:/);
});

test("task formatter includes title and details", () => {
  const text = formatTaskAssignment({
    taskId: "1",
    title: "Investigate",
    details: "Look at logs",
    assignee: "worker",
    state: "assigned",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assert.match(text, /Task: Investigate/);
  assert.match(text, /Look at logs/);
});
