import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverEventEnvelope, RuntimeDriver, RuntimeDriverRunHandle, RuntimeDriverRunInput } from "@pi-claude-code-agent/runtime";
import { ClaudeCodeRuntime } from "@pi-claude-code-agent/runtime";
import { ClaudeCodeSubagentBackend, buildTaskPrompt, extractSummary } from "../src/index.js";

class FakeDriver implements RuntimeDriver {
  readonly name = "claude-sdk" as const;

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
