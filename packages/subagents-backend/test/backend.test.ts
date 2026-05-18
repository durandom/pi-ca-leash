import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverEventEnvelope, RuntimeDriver, RuntimeDriverRunHandle, RuntimeDriverRunInput } from "@pi-claude-code-agent/runtime";
import { ClaudeCodeRuntime } from "@pi-claude-code-agent/runtime/internal";
import {
  ClaudeCodeSubagentBackend,
  buildTaskPrompt,
  extractSummary,
  ensureRunLayout,
  writeRunState,
} from "../src/index.js";

class FakeDriver implements RuntimeDriver {
  constructor(readonly name = "claude-sdk" as const) {}

  run(input: RuntimeDriverRunInput, onEvent: (event: DriverEventEnvelope) => Promise<void> | void): RuntimeDriverRunHandle {
    let interrupted = false;
    const done = (async () => {
      await onEvent({ type: "raw", payload: { type: "system", subtype: "init", session_id: input.resumeSessionId ?? input.sessionId, model: input.model ?? "fake-model" } });
      await onEvent({ type: "raw", payload: { type: "assistant", message: { content: [{ type: "text", text: `assistant:${input.prompt}` }] } } });
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

test("runtime-backed run completes and persists result envelope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-subagent-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(dir, "runtime"), driver: new FakeDriver() });
  const backend = new ClaudeCodeSubagentBackend({ runtime, storageDir: join(dir, "subagents"), pollIntervalMs: 5, completionTimeoutMs: 2_000 });

  const run = await backend.startRun({
    agent: { name: "worker", runner: "claude-code-agent", prompt: "You are worker." },
    task: "status?",
  });

  assert.equal(run.state, "completed");
  assert.ok(run.sessionId);
  assert.match(run.result?.summary ?? "", /assistant:You are worker\./);

  const result = await backend.collectResult(run.runId);
  assert.match(result?.summary ?? "", /assistant:/);
});

test("explicit codex driver is passed through and persisted on run record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-subagent-test-"));
  const defaultDriver = new FakeDriver("claude-sdk");
  const codexDriver = new FakeDriver("codex-cli");
  const runtime = new ClaudeCodeRuntime({
    storageDir: join(dir, "runtime"),
    driver: defaultDriver,
    drivers: { "codex-cli": codexDriver },
  });
  const backend = new ClaudeCodeSubagentBackend({ runtime, storageDir: join(dir, "subagents"), pollIntervalMs: 5, completionTimeoutMs: 2_000 });

  const run = await backend.startRun({
    agent: { name: "worker", runner: "claude-code-agent" },
    task: "hello",
    driver: "codex-cli",
  });

  assert.equal(run.driver, "codex-cli");
  assert.equal(defaultDriver.name, "claude-sdk");
  assert.equal(codexDriver.name, "codex-cli");
  const persisted = await backend.statusRun(run.runId);
  assert.equal(persisted?.driver, "codex-cli");
});

test("async run can be listed and event-tailed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-subagent-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(dir, "runtime"), driver: new FakeDriver() });
  const backend = new ClaudeCodeSubagentBackend({ runtime, storageDir: join(dir, "subagents"), pollIntervalMs: 5, completionTimeoutMs: 2_000 });

  const run = await backend.startRun({
    agent: { name: "worker", runner: "claude-code-agent" },
    task: "hello",
    async: true,
  });

  const listed = await backend.listRuns();
  assert.equal(listed.length, 1);
  const status = await backend.statusRun(run.runId);
  assert.ok(status);

  const events = await backend.eventsRun(run.runId);
  assert.ok(events.nextCursor >= 0);
});

test("fork mode rejected honestly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-subagent-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(dir, "runtime"), driver: new FakeDriver() });
  const backend = new ClaudeCodeSubagentBackend({ runtime, storageDir: join(dir, "subagents"), pollIntervalMs: 5, completionTimeoutMs: 2_000 });

  await assert.rejects(
    backend.startRun({
      agent: { name: "worker", runner: "claude-code-agent" },
      task: "hello",
      context: "fork",
    }),
    /does not support real fork/,
  );
});

class SlowDriver implements RuntimeDriver {
  readonly name = "claude-sdk" as const;

  run(input: RuntimeDriverRunInput, onEvent: (event: DriverEventEnvelope) => Promise<void> | void): RuntimeDriverRunHandle {
    let interrupted = false;
    const done = (async () => {
      await onEvent({ type: "raw", payload: { type: "system", subtype: "init", session_id: input.resumeSessionId ?? input.sessionId, model: input.model ?? "fake-model" } });
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (!interrupted) {
        await onEvent({ type: "raw", payload: { type: "assistant", message: { content: [{ type: "text", text: `assistant:${input.prompt}` }] } } });
        await onEvent({ type: "raw", payload: { type: "result", is_error: false, result: `done:${input.prompt}`, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 2 } } });
      }
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

test("backend rehydrates persisted terminal run and backfills missing driver", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-subagent-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(dir, "runtime"), driver: new FakeDriver("codex-cli") });
  const session = await runtime.start({ prompt: "hello", name: "worker", driver: "codex-cli" });
  for (let i = 0; i < 50; i += 1) {
    const status = await runtime.status(session.sessionId);
    if (status?.state === "idle") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const runId = "run-terminal";
  const storageDir = join(dir, "subagents");
  await ensureRunLayout(storageDir, runId);
  const now = new Date().toISOString();
  await writeRunState(storageDir, {
    runId,
    runner: "claude-code-agent",
    agentName: "worker",
    sessionId: session.sessionId,
    cwd: process.cwd(),
    state: "completed",
    context: "fresh",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    task: "hello",
  });

  const backend = new ClaudeCodeSubagentBackend({ runtime, storageDir, pollIntervalMs: 5, completionTimeoutMs: 2_000 });
  const listed = await backend.listRuns();
  assert.equal(listed[0]?.driver, "codex-cli");
});

test("backend rehydrates persisted run state from runtime status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-subagent-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(dir, "runtime"), driver: new FakeDriver() });
  const session = await runtime.start({ prompt: "hello", name: "worker" });
  for (let i = 0; i < 50; i += 1) {
    const status = await runtime.status(session.sessionId);
    if (status?.state === "idle") {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const runId = "run-1";
  const storageDir = join(dir, "subagents");
  await ensureRunLayout(storageDir, runId);
  const now = new Date().toISOString();
  await writeRunState(storageDir, {
    runId,
    runner: "claude-code-agent",
    agentName: "worker",
    sessionId: session.sessionId,
    cwd: process.cwd(),
    state: "running",
    context: "fresh",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    task: "hello",
  });

  const backend = new ClaudeCodeSubagentBackend({ runtime, storageDir, pollIntervalMs: 5, completionTimeoutMs: 2_000 });
  const status = await backend.statusRun(runId);
  assert.equal(status?.state, "completed");
  assert.match(status?.result?.summary ?? "", /assistant:/);
});

test("attention event emitted for stale async run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "claude-subagent-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir: join(dir, "runtime"), driver: new SlowDriver() });
  const backend = new ClaudeCodeSubagentBackend({
    runtime,
    storageDir: join(dir, "subagents"),
    pollIntervalMs: 5,
    completionTimeoutMs: 2_000,
    needsAttentionAfterMs: 20,
    attentionPollIntervalMs: 5,
  });

  const run = await backend.startRun({
    agent: { name: "worker", runner: "claude-code-agent" },
    task: "hello",
    async: true,
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  const events = await backend.eventsRun(run.runId);
  assert.equal(events.items.some((event) => event.type === "attention"), true);
});

test("helpers build task prompt and extract summary", () => {
  assert.equal(buildTaskPrompt("System", "Do work"), "System\n\nTask:\nDo work");
  assert.equal(
    extractSummary([
      {
        id: "1",
        sessionId: "sid",
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: "message",
        role: "assistant",
        message: { role: "assistant", blocks: [{ type: "text", text: "done" }] },
      },
    ]),
    "done",
  );
});
