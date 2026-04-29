import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverEventEnvelope, RuntimeDriver, RuntimeDriverRunHandle, RuntimeDriverRunInput } from "../src/types.js";
import { ClaudeCodeRuntime } from "../src/runtime.js";

class FakeDriver implements RuntimeDriver {
  readonly name = "claude-sdk" as const;
  readonly runs: RuntimeDriverRunInput[] = [];

  run(input: RuntimeDriverRunInput, onEvent: (event: DriverEventEnvelope) => Promise<void> | void): RuntimeDriverRunHandle {
    this.runs.push(input);
    let interrupted = false;
    const done = (async () => {
      await onEvent({ type: "raw", payload: { type: "system", subtype: "init", session_id: input.sessionId, model: input.model ?? "fake-model" } });
      await onEvent({
        type: "raw",
        payload: {
          type: "assistant",
          message: {
            content: input.prompt.includes("tool")
              ? [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "echo hi" } }]
              : [{ type: "text", text: `echo:${input.prompt}` }],
          },
        },
      });
      if (input.prompt.includes("tool")) {
        await onEvent({
          type: "raw",
          payload: {
            type: "user",
            message: {
              content: [{ type: "tool_result", tool_use_id: "tool-1", content: "hi", is_error: false }],
            },
            tool_use_result: { tool_name: "Bash", stdout: "hi" },
          },
        });
      }
      if (!interrupted) {
        await onEvent({
          type: "raw",
          payload: {
            type: "result",
            is_error: false,
            result: `done:${input.prompt}`,
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 2 },
          },
        });
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

async function waitForState(runtime: ClaudeCodeRuntime, sessionId: string, expected: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    const status = await runtime.status(sessionId);
    if (status?.state === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

test("start persists state and transcript", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-runtime-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir, driver: new FakeDriver() });

  const session = await runtime.start({ prompt: "hello" });
  await waitForState(runtime, session.sessionId, "idle");

  const status = await runtime.status(session.sessionId);
  assert.ok(status);
  assert.equal(status.state, "idle");

  const transcript = await runtime.readTranscript(session.sessionId);
  assert.equal(transcript.items.some((item) => item.type === "message"), true);
  assert.equal(transcript.items.some((item) => item.type === "result"), true);
});

test("send reuses persisted driver session id", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-runtime-test-"));
  const driver = new FakeDriver();
  const runtime = new ClaudeCodeRuntime({ storageDir, driver });

  const session = await runtime.start({ prompt: "one" });
  await waitForState(runtime, session.sessionId, "idle");
  await runtime.send({ sessionId: session.sessionId, message: "two" });
  await waitForState(runtime, session.sessionId, "idle");

  assert.equal(driver.runs.length, 2);
  assert.equal(driver.runs[1]?.resumeSessionId, session.sessionId);

  const events = await runtime.events(session.sessionId);
  assert.equal(events.items.filter((item) => item.type === "result").length, 2);
});

test("tool events normalized", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-runtime-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir, driver: new FakeDriver() });

  const session = await runtime.start({ prompt: "tool please" });
  await waitForState(runtime, session.sessionId, "idle");

  const transcript = await runtime.readTranscript(session.sessionId);
  const toolEvents = transcript.items.filter((item) => item.type === "tool");
  assert.equal(toolEvents.length, 2);
});

test("interrupt marks active run interrupted", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-runtime-test-"));
  const driver = new FakeDriver();
  const runtime = new ClaudeCodeRuntime({ storageDir, driver });

  const session = await runtime.start({ prompt: "interrupt me" });
  const result = await runtime.interrupt(session.sessionId);
  assert.equal(result.interrupted, true);
  await waitForState(runtime, session.sessionId, "interrupted");
});
