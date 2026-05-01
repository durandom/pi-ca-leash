import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexCliCommand,
  parseCodexCliEvent,
  CodexCliDriver,
} from "../src/drivers/codex-cli.js";
import { ClaudeCodeRuntime } from "../src/runtime.js";
import type { DriverEventEnvelope } from "../src/types.js";

// ---------------------------------------------------------------------------
// buildCodexCliCommand
// ---------------------------------------------------------------------------

test("buildCodexCliCommand — fresh run", () => {
  const args = buildCodexCliCommand({ prompt: "hello", cwd: "/work" });
  assert.deepEqual(args, ["exec", "hello", "--json", "--full-auto", "-C", "/work"]);
});

test("buildCodexCliCommand — resume run", () => {
  const args = buildCodexCliCommand({ prompt: "continue", cwd: "/work", resumeSessionId: "sid-abc" });
  assert.deepEqual(args, ["exec", "resume", "sid-abc", "continue", "--json", "--full-auto", "-C", "/work"]);
});

test("buildCodexCliCommand — model and appendSystemPrompt", () => {
  const args = buildCodexCliCommand({
    prompt: "task",
    cwd: "/work",
    model: "o4-mini",
    appendSystemPrompt: "Be brief.",
  });
  assert.equal(args[0], "exec");
  assert.ok(args[1]?.startsWith("<system>\nBe brief.\n</system>\n\ntask"), "prompt should have system prefix");
  assert.ok(args.includes("-m"), "should include -m flag");
  assert.equal(args[args.indexOf("-m") + 1], "o4-mini");
});

// ---------------------------------------------------------------------------
// parseCodexCliEvent
// ---------------------------------------------------------------------------

test("parseCodexCliEvent — thread.started → system init with sessionId", () => {
  const msg = parseCodexCliEvent({ type: "thread.started", thread_id: "t-123" });
  assert.equal(msg?.type, "system");
  assert.equal(msg?.type === "system" ? msg.subtype : undefined, "init");
  assert.equal(msg?.type === "system" ? msg.sessionId : undefined, "t-123");
});

test("parseCodexCliEvent — item.started command_execution → tool_use", () => {
  const msg = parseCodexCliEvent({
    type: "item.started",
    item: { type: "command_execution", id: "cmd-1", command: "ls", cwd: "/tmp" },
  });
  assert.equal(msg?.type, "tool_use");
  assert.equal(msg?.type === "tool_use" ? msg.toolName : undefined, "command_execution");
  assert.equal(msg?.type === "tool_use" ? msg.toolUseId : undefined, "cmd-1");
});

test("parseCodexCliEvent — item.completed command_execution non-zero exit → tool_result isError", () => {
  const msg = parseCodexCliEvent({
    type: "item.completed",
    item: { type: "command_execution", id: "cmd-1", stdout: "", exit_code: 1 },
  });
  assert.equal(msg?.type, "tool_result");
  assert.equal(msg?.type === "tool_result" ? msg.isError : undefined, true);
  assert.equal(msg?.type === "tool_result" ? msg.toolUseId : undefined, "cmd-1");
});

test("parseCodexCliEvent — item.completed agent_message → assistant with text block", () => {
  const msg = parseCodexCliEvent({
    type: "item.completed",
    item: { type: "agent_message", id: "msg-1", text: "All done!" },
  });
  assert.equal(msg?.type, "assistant");
  assert.equal(msg?.type === "assistant" ? msg.blocks[0]?.text : undefined, "All done!");
});

test("parseCodexCliEvent — turn.completed → result ok with usage", () => {
  const msg = parseCodexCliEvent({
    type: "turn.completed",
    summary: "Finished",
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  assert.equal(msg?.type, "result");
  assert.equal(msg?.type === "result" ? msg.ok : undefined, true);
  assert.equal(msg?.type === "result" ? msg.summary : undefined, "Finished");
  assert.equal(msg?.type === "result" ? msg.usage?.inputTokens : undefined, 10);
  assert.equal(msg?.type === "result" ? msg.usage?.outputTokens : undefined, 5);
});

test("parseCodexCliEvent — error event → null (driver wraps as error envelope)", () => {
  const msg = parseCodexCliEvent({ type: "error", message: "something failed" });
  assert.equal(msg, null);
});

test("parseCodexCliEvent — unknown event type returns null without throwing", () => {
  const msg = parseCodexCliEvent({ type: "some.future.event", data: "ignored" });
  assert.equal(msg, null);
});

// ---------------------------------------------------------------------------
// Fake child process factory
// ---------------------------------------------------------------------------

function makeFakeSpawn(lines: string[], exitCode = 0) {
  return function fakeSpawn(_cmd: string, _args: string[], _opts: unknown) {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: (sig?: string) => void;
    };

    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {};

    setImmediate(() => {
      for (const line of lines) {
        stdout.push(line + "\n");
      }
      stdout.push(null);
      stderr.push(null);
      child.emit("close", exitCode, null);
    });

    return child;
  } as unknown as typeof import("node:child_process").spawn;
}

// ---------------------------------------------------------------------------
// Integration: fake subprocess → ClaudeCodeRuntime
// ---------------------------------------------------------------------------

async function waitForState(runtime: ClaudeCodeRuntime, sessionId: string, expected: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const status = await runtime.status(sessionId);
    if (status?.state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for state ${expected}`);
}

test("integration — fake subprocess produces expected RuntimeEvents", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "codex-test-"));
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "codex-session-42" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", id: "m1", text: "Hello from codex" } }),
    JSON.stringify({ type: "turn.completed", summary: "done" }),
  ];
  const driver = new CodexCliDriver({ spawn: makeFakeSpawn(lines, 0) });
  const runtime = new ClaudeCodeRuntime({ storageDir, drivers: { "codex-cli": driver } });

  const session = await runtime.start({ prompt: "test", driver: "codex-cli", cwd: "/tmp" });
  await waitForState(runtime, session.sessionId, "idle");

  const status = await runtime.status(session.sessionId);
  assert.equal(status?.driver, "codex-cli");
  assert.equal(status?.driverSessionId, "codex-session-42");

  const transcript = await runtime.readTranscript(session.sessionId);
  const hasMessage = transcript.items.some((item) => item.type === "message");
  const hasResult = transcript.items.some((item) => item.type === "result");
  assert.equal(hasMessage, true, "transcript should have a message event");
  assert.equal(hasResult, true, "transcript should have a result event");
  assert.equal(status?.state, "idle");
});

// ---------------------------------------------------------------------------
// Unsupported options reject
// ---------------------------------------------------------------------------

test("unsupported options — tools throws RangeError before spawning", () => {
  let spawnCalled = false;
  const fakeSpawn = (..._args: unknown[]) => { spawnCalled = true; return {} as never; };
  const driver = new CodexCliDriver({ spawn: fakeSpawn as unknown as typeof import("node:child_process").spawn });
  const noop = async (_e: DriverEventEnvelope) => {};

  assert.throws(
    () => driver.run(
      { sessionId: "s1", prompt: "p", cwd: "/tmp", tools: ["Bash"] },
      noop,
    ),
    (err: unknown) => err instanceof RangeError && String(err).includes("allowedTools"),
  );
  assert.equal(spawnCalled, false, "spawn must not be called");
});

// ---------------------------------------------------------------------------
// Non-zero exit surfaces error envelope
// ---------------------------------------------------------------------------

test("non-zero exit — stderr surfaced as error envelope", async () => {
  const lines: string[] = []; // no JSONL output
  const stderrMsg = "boom";
  const fakeSpawn = function(_cmd: string, _args: string[], _opts: unknown) {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: () => void;
    };
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {};
    setImmediate(() => {
      stdout.push(null);
      stderr.push(stderrMsg);
      stderr.push(null);
      child.emit("close", 1, null);
    });
    return child;
  } as unknown as typeof import("node:child_process").spawn;

  const driver = new CodexCliDriver({ spawn: fakeSpawn });
  const events: DriverEventEnvelope[] = [];
  const handle = driver.run(
    { sessionId: "s1", prompt: "fail", cwd: "/tmp" },
    (e) => { events.push(e); },
  );
  const result = await handle.done;

  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  const errorEnv = events.find((e) => e.type === "error");
  assert.ok(errorEnv, "should have an error envelope");
  assert.equal(
    errorEnv?.type === "error" && errorEnv.payload.message?.includes("boom"),
    true,
    "error message should contain stderr",
  );
});

// ---------------------------------------------------------------------------
// Incremental delivery — done awaits all handlers, order preserved
// ---------------------------------------------------------------------------

test("delivery chain — done awaits slow handlers and preserves order", async () => {
  const received: string[] = [];

  // Slow onEvent: takes 5 ms each — done must not resolve until all finish
  const slowOnEvent = async (e: DriverEventEnvelope) => {
    await new Promise((r) => setTimeout(r, 5));
    if (e.type === "message") received.push(e.payload.type);
  };

  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "t-slow" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
    JSON.stringify({ type: "turn.completed", summary: "done" }),
  ];

  const driver = new CodexCliDriver({ spawn: makeFakeSpawn(lines, 0) });
  await driver.run({ sessionId: "s", prompt: "p", cwd: "/tmp" }, slowOnEvent).done;

  // All three events delivered in order before done resolved
  assert.deepEqual(received, ["system", "assistant", "result"]);
});

// ---------------------------------------------------------------------------
// Spawn error (e.g. ENOENT) — error envelope + deterministic done
// ---------------------------------------------------------------------------

function makeSpawnErrorFake(errMsg: string, errCode = "ENOENT") {
  return function fakeSpawn(_cmd: string, _args: string[], _opts: unknown) {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: () => void;
    };
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.push(null);
      child.stderr.push(null);
      child.emit("error", Object.assign(new Error(errMsg), { code: errCode }));
      child.emit("close", null, null);
    });
    return child;
  } as unknown as typeof import("node:child_process").spawn;
}

test("spawn error — ENOENT produces error envelope and done resolves deterministically", async () => {
  const driver = new CodexCliDriver({ spawn: makeSpawnErrorFake("spawn codex ENOENT") });
  const events: DriverEventEnvelope[] = [];

  const result = await driver
    .run({ sessionId: "s", prompt: "p", cwd: "/tmp" }, (e) => { events.push(e); })
    .done;

  assert.deepEqual(result, { code: null, signal: null });
  const errorEnv = events.find((e) => e.type === "error");
  assert.ok(errorEnv, "should emit an error envelope");
  assert.equal(
    errorEnv?.type === "error" && errorEnv.payload.code === "SPAWN_ERROR",
    true,
    "code should be SPAWN_ERROR",
  );
  assert.equal(
    errorEnv?.type === "error" && errorEnv.payload.message?.includes("ENOENT"),
    true,
    "message should reference ENOENT",
  );
});

// ---------------------------------------------------------------------------
// Malformed stdout lines appear in ring-buffer context on non-zero exit
// ---------------------------------------------------------------------------

test("non-zero exit with malformed stdout — ring-buffer context in error message", async () => {
  const badLine = "NOT_JSON_{garbage}";
  const fakeSpawn = function(_cmd: string, _args: string[], _opts: unknown) {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      kill: () => void;
    };
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.kill = () => {};
    setImmediate(() => {
      // emit a malformed line then exit non-zero with no stderr
      child.stdout.push(badLine + "\n");
      child.stdout.push(null);
      child.stderr.push(null);
      child.emit("close", 2, null);
    });
    return child;
  } as unknown as typeof import("node:child_process").spawn;

  const driver = new CodexCliDriver({ spawn: fakeSpawn });
  const events: DriverEventEnvelope[] = [];
  const result = await driver
    .run({ sessionId: "s", prompt: "p", cwd: "/tmp" }, (e) => { events.push(e); })
    .done;

  assert.equal(result.code, 2);
  const errorEnv = events.find((e) => e.type === "error");
  assert.ok(errorEnv, "should emit an error envelope");
  assert.equal(
    errorEnv?.type === "error" && errorEnv.payload.message?.includes(badLine),
    true,
    "error message should include the malformed line from ring buffer",
  );
});
