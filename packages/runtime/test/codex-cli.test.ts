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
import type { DriverEventEnvelope, ResultEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// buildCodexCliCommand
// ---------------------------------------------------------------------------

// securityMode mapping:
//   safe (default) → --sandbox workspace-write (workspace-write sandbox, cwd writable)
//   yolo           → --dangerously-bypass-approvals-and-sandbox

test("buildCodexCliCommand — fresh run defaults to --sandbox workspace-write (safe)", () => {
  const args = buildCodexCliCommand({ prompt: "hello", cwd: "/work" });
  assert.deepEqual(args, ["exec", "--json", "--sandbox", "workspace-write", "-C", "/work", "hello"]);
});

test("buildCodexCliCommand — securityMode=safe is explicit --sandbox workspace-write", () => {
  const args = buildCodexCliCommand({ prompt: "hello", cwd: "/work", securityMode: "safe" });
  assert.deepEqual(args, ["exec", "--json", "--sandbox", "workspace-write", "-C", "/work", "hello"]);
});

test("buildCodexCliCommand — securityMode=yolo disables sandbox", () => {
  const args = buildCodexCliCommand({ prompt: "hello", cwd: "/work", securityMode: "yolo" });
  assert.deepEqual(args, [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    "/work",
    "hello",
  ]);
});

test("buildCodexCliCommand — securityMode is preserved on resume", () => {
  const yolo = buildCodexCliCommand({
    prompt: "continue",
    cwd: "/work",
    resumeSessionId: "sid-abc",
    securityMode: "yolo",
  });
  const safe = buildCodexCliCommand({
    prompt: "continue",
    cwd: "/work",
    resumeSessionId: "sid-abc",
    securityMode: "safe",
  });
  assert.ok(yolo.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!yolo.includes("--sandbox"));
  assert.ok(safe.includes("--sandbox"));
  assert.ok(safe.includes("workspace-write"));
  assert.ok(!safe.includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("buildCodexCliCommand — model and appendSystemPrompt", () => {
  const args = buildCodexCliCommand({
    prompt: "task",
    cwd: "/work",
    model: "o4-mini",
    appendSystemPrompt: "Be brief.",
  });
  assert.equal(args[0], "exec");
  assert.equal(args.at(-1)?.startsWith("<system>\nBe brief.\n</system>\n\ntask"), true, "prompt should have system prefix");
  assert.ok(args.includes("-m"), "should include -m flag");
  assert.equal(args[args.indexOf("-m") + 1], "o4-mini");
});

// ---------------------------------------------------------------------------
// parseCodexCliEvent
// ---------------------------------------------------------------------------

test("parseCodexCliEvent — thread.started → system init with sessionId and model when reported", () => {
  const msg = parseCodexCliEvent({ type: "thread.started", thread_id: "t-123", model: "gpt-5-codex" });
  assert.equal(msg?.type, "system");
  assert.equal(msg?.type === "system" ? msg.subtype : undefined, "init");
  assert.equal(msg?.type === "system" ? msg.sessionId : undefined, "t-123");
  assert.equal(msg?.type === "system" ? msg.model : undefined, "gpt-5-codex");
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
    usage: { input_tokens: 10, cached_input_tokens: 7, output_tokens: 5, reasoning_output_tokens: 2 },
  });
  assert.equal(msg?.type, "result");
  assert.equal(msg?.type === "result" ? msg.ok : undefined, true);
  assert.equal(msg?.type === "result" ? msg.summary : undefined, "Finished");
  assert.equal(msg?.type === "result" ? msg.usage?.inputTokens : undefined, 10);
  assert.equal(msg?.type === "result" ? msg.usage?.cacheReadInputTokens : undefined, 7);
  assert.equal(msg?.type === "result" ? msg.usage?.outputTokens : undefined, 5);
  assert.equal(msg?.type === "result" ? msg.usage?.reasoningOutputTokens : undefined, 2);
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

function makeSequentialFakeSpawn(runs: string[][], exitCode = 0) {
  let index = 0;
  return function fakeSpawn(_cmd: string, _args: string[], _opts: unknown) {
    const lines = runs[index++] ?? [];
    return makeFakeSpawn(lines, exitCode)(_cmd, _args, _opts);
  } as unknown as typeof import("node:child_process").spawn;
}

function resultEvents(items: { type: string }[]): ResultEvent[] {
  return items.filter((item): item is ResultEvent => item.type === "result");
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

test("integration — one turn.completed usage event is reported exactly for a fresh run", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "codex-test-"));
  const usage = {
    input_tokens: 101,
    cached_input_tokens: 70,
    output_tokens: 11,
    reasoning_output_tokens: 3,
  };
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "codex-fresh-usage" }),
    JSON.stringify({ type: "turn.completed", summary: "fresh done", usage }),
  ];
  const driver = new CodexCliDriver({ spawn: makeFakeSpawn(lines, 0) });
  const runtime = new ClaudeCodeRuntime({ storageDir, drivers: { "codex-cli": driver } });

  const session = await runtime.start({ prompt: "test", driver: "codex-cli", cwd: "/tmp" });
  await waitForState(runtime, session.sessionId, "idle");

  const transcript = await runtime.readTranscript(session.sessionId);
  const results = resultEvents(transcript.items);
  assert.equal(results.length, 1);
  assert.equal(results[0]?.usage?.inputTokens, 101);
  assert.equal(results[0]?.usage?.cacheReadInputTokens, 70);
  assert.equal(results[0]?.usage?.outputTokens, 11);
  assert.equal(results[0]?.usage?.reasoningOutputTokens, 3);
  assert.deepEqual(results[0]?.usage?.raw, usage);
});

test("integration — resumed send reports only the new turn.completed usage", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "codex-test-"));
  const oldUsage = {
    input_tokens: 1000,
    cached_input_tokens: 800,
    output_tokens: 100,
    reasoning_output_tokens: 50,
  };
  const newUsage = {
    input_tokens: 21,
    cached_input_tokens: 18,
    output_tokens: 7,
    reasoning_output_tokens: 2,
  };
  const spawn = makeSequentialFakeSpawn([
    [
      JSON.stringify({ type: "thread.started", thread_id: "codex-resume-usage" }),
      JSON.stringify({ type: "turn.completed", summary: "old done", usage: oldUsage }),
    ],
    [
      JSON.stringify({ type: "thread.started", thread_id: "codex-resume-usage" }),
      JSON.stringify({ type: "turn.completed", summary: "new done", usage: newUsage }),
    ],
  ]);
  const driver = new CodexCliDriver({ spawn });
  const runtime = new ClaudeCodeRuntime({ storageDir, drivers: { "codex-cli": driver } });

  const session = await runtime.start({ prompt: "first", driver: "codex-cli", cwd: "/tmp" });
  await waitForState(runtime, session.sessionId, "idle");
  const afterFirstRun = await runtime.events(session.sessionId);

  await runtime.send({ sessionId: session.sessionId, message: "second" });
  await waitForState(runtime, session.sessionId, "idle");

  const newEvents = await runtime.events(session.sessionId, afterFirstRun.nextCursor);
  const newResults = resultEvents(newEvents.items);
  assert.equal(newResults.length, 1);
  assert.equal(newResults[0]?.usage?.inputTokens, 21);
  assert.equal(newResults[0]?.usage?.cacheReadInputTokens, 18);
  assert.equal(newResults[0]?.usage?.outputTokens, 7);
  assert.equal(newResults[0]?.usage?.reasoningOutputTokens, 2);
  assert.deepEqual(newResults[0]?.usage?.raw, newUsage);

  const transcript = await runtime.readTranscript(session.sessionId);
  const allResults = resultEvents(transcript.items);
  assert.equal(allResults.length, 2);
  assert.equal(allResults[0]?.usage?.inputTokens, 1000);
  assert.equal(allResults[1]?.usage?.inputTokens, 21);
});

test("integration — multiple turn.completed events are emitted separately without summing usage", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "codex-test-"));
  const firstUsage = {
    input_tokens: 1,
    cached_input_tokens: 2,
    output_tokens: 3,
    reasoning_output_tokens: 4,
  };
  const secondUsage = {
    input_tokens: 10,
    cached_input_tokens: 20,
    output_tokens: 30,
    reasoning_output_tokens: 40,
  };
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "codex-multi-usage" }),
    JSON.stringify({ type: "turn.completed", summary: "first", usage: firstUsage }),
    JSON.stringify({ type: "turn.completed", summary: "second", usage: secondUsage }),
  ];
  const driver = new CodexCliDriver({ spawn: makeFakeSpawn(lines, 0) });
  const runtime = new ClaudeCodeRuntime({ storageDir, drivers: { "codex-cli": driver } });

  const session = await runtime.start({ prompt: "test", driver: "codex-cli", cwd: "/tmp" });
  await waitForState(runtime, session.sessionId, "idle");

  const transcript = await runtime.readTranscript(session.sessionId);
  const results = resultEvents(transcript.items);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.summary, "first");
  assert.equal(results[0]?.usage?.inputTokens, 1);
  assert.equal(results[0]?.usage?.cacheReadInputTokens, 2);
  assert.equal(results[0]?.usage?.outputTokens, 3);
  assert.equal(results[0]?.usage?.reasoningOutputTokens, 4);
  assert.equal(results[1]?.summary, "second");
  assert.equal(results[1]?.usage?.inputTokens, 10);
  assert.equal(results[1]?.usage?.cacheReadInputTokens, 20);
  assert.equal(results[1]?.usage?.outputTokens, 30);
  assert.equal(results[1]?.usage?.reasoningOutputTokens, 40);
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

test("thinkingLevel — codex-cli forwards `-c model_reasoning_effort=...` and surfaces request/effective/supported on init", async () => {
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "t-tl-probe", model: "gpt-5-codex" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }),
    JSON.stringify({ type: "turn.completed", summary: "done" }),
  ];
  let spawnedArgs: string[] | undefined;
  const captureSpawn: typeof import("node:child_process").spawn = ((cmd: string, args: string[], opts: unknown) => {
    spawnedArgs = args;
    return (makeFakeSpawn(lines, 0) as unknown as (c: string, a: string[], o: unknown) => unknown)(cmd, args, opts);
  }) as unknown as typeof import("node:child_process").spawn;
  const driver = new CodexCliDriver({ spawn: captureSpawn });
  const events: DriverEventEnvelope[] = [];
  await driver.run({ sessionId: "s", prompt: "p", cwd: "/tmp", thinkingLevel: "xhigh" }, (e) => { events.push(e); }).done;

  // CLI plumbing: codex forwards via the TOML config override.
  // OpenAI's reasoning_effort tops at "high"; xhigh folds down.
  assert.ok(spawnedArgs?.includes("-c"));
  assert.ok(
    spawnedArgs?.some((a) => a === 'model_reasoning_effort="high"'),
    `expected model_reasoning_effort="high" in args, got: ${spawnedArgs?.join(" ")}`,
  );

  const init = events.find(
    (e) => e.type === "message" && e.payload.type === "system" && e.payload.subtype === "init",
  );
  const meta = init?.type === "message" && init.payload.type === "system"
    ? init.payload.metadata
    : undefined;
  assert.equal(meta?.thinkingLevelSupported, true);
  assert.equal(meta?.requestedThinkingLevel, "xhigh");
  assert.equal(meta?.effectiveThinkingLevel, "high");
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
