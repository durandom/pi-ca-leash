import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverEventEnvelope, RuntimeDriver, RuntimeDriverName, RuntimeDriverRunHandle, RuntimeDriverRunInput } from "../src/types.js";
import { ClaudeCodeRuntime } from "../src/runtime.js";

class FakeDriver implements RuntimeDriver {
  readonly runs: RuntimeDriverRunInput[] = [];

  constructor(readonly name: RuntimeDriverName = "claude-sdk") {}

  protected initSessionId(input: RuntimeDriverRunInput): string {
    return input.sessionId;
  }

  protected initModel(input: RuntimeDriverRunInput): string {
    return input.model ?? "fake-model";
  }

  run(input: RuntimeDriverRunInput, onEvent: (event: DriverEventEnvelope) => Promise<void> | void): RuntimeDriverRunHandle {
    this.runs.push(input);
    let interrupted = false;
    const done = (async () => {
      await onEvent({
        type: "message",
        payload: {
          type: "system",
          subtype: "init",
          sessionId: this.initSessionId(input),
          model: this.initModel(input),
          raw: { type: "system", subtype: "init", session_id: this.initSessionId(input), model: this.initModel(input) },
        },
      });
      await onEvent({
        type: "message",
        payload: {
          type: "assistant",
          blocks: input.prompt.includes("tool")
            ? [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "echo hi" }, raw: { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "echo hi" } } }]
            : [{ type: "text", text: `echo:${input.prompt}`, raw: { type: "text", text: `echo:${input.prompt}` } }],
          raw: {
            type: "assistant",
            message: {
              content: input.prompt.includes("tool")
                ? [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "echo hi" } }]
                : [{ type: "text", text: `echo:${input.prompt}` }],
            },
          },
        },
      });
      if (input.prompt.includes("tool")) {
        await onEvent({
          type: "message",
          payload: {
            type: "tool_use",
            toolName: "Bash",
            toolUseId: "tool-1",
            input: { command: "echo hi" },
            raw: { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "echo hi" } },
          },
        });
        await onEvent({
          type: "message",
          payload: {
            type: "tool_result",
            role: "user",
            blocks: [{
              type: "tool_result",
              content: "hi",
              isError: false,
              raw: { type: "tool_result", tool_use_id: "tool-1", content: "hi", is_error: false },
            }],
            toolName: "Bash",
            toolUseId: "tool-1",
            output: { tool_name: "Bash", stdout: "hi" },
            isError: false,
            raw: {
              type: "user",
              message: {
                content: [{ type: "tool_result", tool_use_id: "tool-1", content: "hi", is_error: false }],
              },
              tool_use_result: { tool_name: "Bash", stdout: "hi" },
            },
          },
        });
      }
      if (!interrupted) {
        await onEvent({
          type: "message",
          payload: {
            type: "result",
            ok: true,
            summary: `done:${input.prompt}`,
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 2, raw: { input_tokens: 1, output_tokens: 2 } },
            raw: {
              type: "result",
              is_error: false,
              result: `done:${input.prompt}`,
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 2 },
            },
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

class StaleInitDriver extends FakeDriver {
  protected override initModel(input: RuntimeDriverRunInput): string {
    return input.resumeSessionId ? "stale-old-model" : input.model ?? "fake-model";
  }
}

class RemappedSessionDriver extends FakeDriver {
  protected override initSessionId(input: RuntimeDriverRunInput): string {
    return input.resumeSessionId ? input.resumeSessionId : `driver-${input.sessionId}`;
  }
}

class LegacyRawDriver implements RuntimeDriver {
  readonly name = "claude-sdk" as const;

  run(input: RuntimeDriverRunInput, onEvent: (event: DriverEventEnvelope) => Promise<void> | void): RuntimeDriverRunHandle {
    const done = (async () => {
      await onEvent({ type: "raw", payload: { type: "system", subtype: "init", session_id: input.sessionId, model: input.model ?? "fake-model" } });
      await onEvent({
        type: "raw",
        payload: {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: `echo:${input.prompt}` },
              { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "echo hi" } },
            ],
          },
        },
      });
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
      return { code: 0, signal: null } as const;
    })();

    return {
      kill() {},
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

test("start persists state, transcript, and explicit driver identity", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-runtime-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir, driver: new FakeDriver() });

  const session = await runtime.start({ prompt: "hello", driver: "claude-sdk" });
  await waitForState(runtime, session.sessionId, "idle");

  const status = await runtime.status(session.sessionId);
  assert.ok(status);
  assert.equal(status.state, "idle");
  assert.equal(status.driver, "claude-sdk");

  const transcript = await runtime.readTranscript(session.sessionId);
  assert.equal(transcript.items.some((item) => item.type === "message"), true);
  assert.equal(transcript.items.some((item) => item.type === "result"), true);
});

test("send reuses persisted driver session id", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-runtime-test-"));
  const driver = new RemappedSessionDriver();
  const runtime = new ClaudeCodeRuntime({ storageDir, driver });

  const session = await runtime.start({ prompt: "one" });
  await waitForState(runtime, session.sessionId, "idle");

  const afterStart = await runtime.status(session.sessionId);
  assert.equal(afterStart?.driverSessionId, `driver-${session.sessionId}`);

  await runtime.send({ sessionId: session.sessionId, message: "two" });
  await waitForState(runtime, session.sessionId, "idle");

  assert.equal(driver.runs.length, 2);
  assert.equal(driver.runs[1]?.resumeSessionId, `driver-${session.sessionId}`);

  const events = await runtime.events(session.sessionId);
  assert.equal(events.items.filter((item) => item.type === "result").length, 2);
});

test("send uses persisted driver identity instead of runtime default", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-runtime-test-"));
  const defaultDriver = new FakeDriver("claude-sdk");
  const codexDriver = new FakeDriver("codex-cli");
  const runtime = new ClaudeCodeRuntime({
    storageDir,
    driver: defaultDriver,
    drivers: { "codex-cli": codexDriver },
  });

  const session = await runtime.start({ prompt: "one", driver: "codex-cli" });
  await waitForState(runtime, session.sessionId, "idle");
  await runtime.send({ sessionId: session.sessionId, message: "two" });
  await waitForState(runtime, session.sessionId, "idle");

  const status = await runtime.status(session.sessionId);
  assert.equal(status?.driver, "codex-cli");
  assert.equal(defaultDriver.runs.length, 0);
  assert.equal(codexDriver.runs.length, 2);
});

test("send model override persists for later turns", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-runtime-test-"));
  const driver = new FakeDriver();
  const runtime = new ClaudeCodeRuntime({ storageDir, driver });

  const session = await runtime.start({ prompt: "one", model: "model-a" });
  await waitForState(runtime, session.sessionId, "idle");

  await runtime.send({ sessionId: session.sessionId, message: "switch", model: "model-b" });
  await waitForState(runtime, session.sessionId, "idle");

  const afterSwitch = await runtime.status(session.sessionId);
  assert.equal(afterSwitch?.model, "model-b");

  await runtime.send({ sessionId: session.sessionId, message: "three" });
  await waitForState(runtime, session.sessionId, "idle");

  assert.equal(driver.runs[0]?.model, "model-a");
  assert.equal(driver.runs[1]?.model, "model-b");
  assert.equal(driver.runs[2]?.model, "model-b");
});

test("send model override survives stale init model on resumed session", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-runtime-test-"));
  const driver = new StaleInitDriver();
  const runtime = new ClaudeCodeRuntime({ storageDir, driver });

  const session = await runtime.start({ prompt: "one", model: "model-a" });
  await waitForState(runtime, session.sessionId, "idle");

  await runtime.send({ sessionId: session.sessionId, message: "switch", model: "model-b" });
  await waitForState(runtime, session.sessionId, "idle");

  const afterSwitch = await runtime.status(session.sessionId);
  assert.equal(afterSwitch?.model, "model-b");

  await runtime.send({ sessionId: session.sessionId, message: "three" });
  await waitForState(runtime, session.sessionId, "idle");

  assert.equal(driver.runs[1]?.model, "model-b");
  assert.equal(driver.runs[2]?.model, "model-b");
});

test("tool events stay normalized with tool names and outputs intact", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-runtime-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir, driver: new FakeDriver() });

  const session = await runtime.start({ prompt: "tool please" });
  await waitForState(runtime, session.sessionId, "idle");

  const transcript = await runtime.readTranscript(session.sessionId);
  const toolEvents = transcript.items.filter((item) => item.type === "tool");
  assert.equal(toolEvents.length, 2);
  assert.equal(toolEvents[0]?.toolName, "Bash");
  assert.equal(toolEvents[1]?.toolName, "Bash");
  assert.deepEqual(toolEvents[1]?.output, { tool_name: "Bash", stdout: "hi" });
});

test("legacy raw envelopes still normalize into public runtime events", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-runtime-test-"));
  const runtime = new ClaudeCodeRuntime({ storageDir, driver: new LegacyRawDriver() });

  const session = await runtime.start({ prompt: "legacy raw" });
  await waitForState(runtime, session.sessionId, "idle");

  const transcript = await runtime.readTranscript(session.sessionId);
  const assistant = transcript.items.find((item) => item.type === "message" && item.role === "assistant");
  const toolEvents = transcript.items.filter((item) => item.type === "tool");
  const result = transcript.items.find((item) => item.type === "result");

  assert.equal(assistant?.type, "message");
  assert.equal(assistant?.type === "message" ? assistant.message.blocks[0]?.text : undefined, "echo:legacy raw");
  assert.equal(toolEvents.length, 2);
  assert.equal(toolEvents[0]?.toolName, "Bash");
  assert.equal(result?.type, "result");
  assert.equal(result?.type === "result" ? result.summary : undefined, "done:legacy raw");
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
