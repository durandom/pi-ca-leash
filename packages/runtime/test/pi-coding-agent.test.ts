import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parsePiCodingAgentEvent,
  PiCodingAgentDriver,
  type PiCodingAgentSessionFactory,
  type PiCodingAgentSessionFactoryInput,
  type PiCodingAgentSessionLike,
} from "../src/drivers/pi-coding-agent.js";
import { ClaudeCodeRuntime } from "../src/runtime.js";
import type { DriverEventEnvelope, ResultEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// parsePiCodingAgentEvent — translation table coverage
// ---------------------------------------------------------------------------

test("parsePiCodingAgentEvent — tool_execution_start → tool_use", () => {
  const [msg] = parsePiCodingAgentEvent({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "ls" },
  });
  assert.equal(msg?.type, "tool_use");
  assert.equal(msg?.type === "tool_use" ? msg.toolName : undefined, "bash");
  assert.equal(msg?.type === "tool_use" ? msg.toolUseId : undefined, "call-1");
});

test("parsePiCodingAgentEvent — message_end (assistant) → assistant with text/thinking/tool_use blocks", () => {
  const messages = parsePiCodingAgentEvent({
    type: "message_end",
    message: {
      role: "assistant",
      model: "anthropic/claude-opus-4-5",
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "Doing the task." },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "x.ts" } },
      ],
    },
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.type, "assistant");
  assert.equal(
    messages[0]?.type === "assistant" ? messages[0].model : undefined,
    "anthropic/claude-opus-4-5",
  );
  const blocks = messages[0]?.type === "assistant" ? messages[0].blocks : [];
  assert.deepEqual(
    blocks.map((b) => b.type),
    ["thinking", "text", "tool_use"],
  );
  const toolUseBlock = blocks.find((b) => b.type === "tool_use");
  assert.equal(toolUseBlock?.name, "read");
  assert.equal(toolUseBlock?.id, "call-1");
});

test("parsePiCodingAgentEvent — message_end (toolResult) → tool_result with toolUseId", () => {
  const [msg] = parsePiCodingAgentEvent({
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "bash",
      content: [{ type: "text", text: "stdout" }],
      isError: false,
    },
  });
  assert.equal(msg?.type, "tool_result");
  assert.equal(msg?.type === "tool_result" ? msg.toolName : undefined, "bash");
  assert.equal(msg?.type === "tool_result" ? msg.toolUseId : undefined, "call-1");
  assert.equal(msg?.type === "tool_result" ? msg.isError : undefined, false);
});

test("parsePiCodingAgentEvent — turn_end → result with usage from assistant message", () => {
  const [msg] = parsePiCodingAgentEvent({
    type: "turn_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "All done." }],
      usage: {
        input: 100,
        output: 20,
        cacheRead: 30,
        cacheWrite: 5,
        totalTokens: 155,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.12 },
      },
    },
    toolResults: [],
  });
  assert.equal(msg?.type, "result");
  assert.equal(msg?.type === "result" ? msg.ok : undefined, true);
  assert.equal(msg?.type === "result" ? msg.summary : undefined, "All done.");
  assert.equal(msg?.type === "result" ? msg.stopReason : undefined, "stop");
  assert.equal(msg?.type === "result" ? msg.usage?.inputTokens : undefined, 100);
  assert.equal(msg?.type === "result" ? msg.usage?.outputTokens : undefined, 20);
  assert.equal(msg?.type === "result" ? msg.usage?.cacheReadInputTokens : undefined, 30);
  assert.equal(msg?.type === "result" ? msg.usage?.cacheCreationInputTokens : undefined, 5);
  assert.equal(msg?.type === "result" ? msg.usage?.totalCostUsd : undefined, 0.12);
  assert.equal(msg?.type === "result" ? msg.usage?.contextTokens : undefined, 135);
});

test("parsePiCodingAgentEvent — turn_end with error stopReason → result.ok=false", () => {
  const [msg] = parsePiCodingAgentEvent({
    type: "turn_end",
    message: {
      role: "assistant",
      stopReason: "error",
      content: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  });
  assert.equal(msg?.type, "result");
  assert.equal(msg?.type === "result" ? msg.ok : undefined, false);
});

test("parsePiCodingAgentEvent — lifecycle events return []", () => {
  for (const type of ["agent_start", "agent_end", "turn_start", "message_start", "message_update", "tool_execution_update", "tool_execution_end", "queue_update"]) {
    assert.deepEqual(parsePiCodingAgentEvent({ type }), [], `expected ${type} to be dropped`);
  }
});

// ---------------------------------------------------------------------------
// Fake AgentSession factory
// ---------------------------------------------------------------------------

interface ScriptedEvent {
  delayMs?: number;
  event: unknown;
}

function makeFakeSessionFactory(
  scripts: ScriptedEvent[][],
  options: { sessionId?: string; throwOnCreate?: Error } = {},
): PiCodingAgentSessionFactory {
  let runIndex = 0;
  const sessionId = options.sessionId ?? "pi-session-1";
  return async (_input) => {
    if (options.throwOnCreate) throw options.throwOnCreate;
    const script = scripts[runIndex++] ?? [];
    let listener: ((event: unknown) => void) | undefined;
    let disposed = false;
    const session: PiCodingAgentSessionLike = {
      sessionId,
      subscribe(l) {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
      async prompt(_text, _opts) {
        for (const item of script) {
          if (item.delayMs) await new Promise((r) => setTimeout(r, item.delayMs));
          if (!listener) break;
          listener(item.event);
        }
      },
      abort() {
        listener = undefined;
      },
      dispose() {
        disposed = true;
        listener = undefined;
      },
    };
    // Expose for assertions
    Object.defineProperty(session, "__disposed", { get: () => disposed });
    return session;
  };
}

async function waitForState(runtime: ClaudeCodeRuntime, sessionId: string, expected: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const status = await runtime.status(sessionId);
    if (status?.state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for state ${expected}`);
}

function resultEvents(items: { type: string }[]): ResultEvent[] {
  return items.filter((item): item is ResultEvent => item.type === "result");
}

// ---------------------------------------------------------------------------
// Integration via ClaudeCodeRuntime
// ---------------------------------------------------------------------------

test("integration — start produces RuntimeEvents and reaches idle", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "pi-coding-agent-test-"));
  const script: ScriptedEvent[] = [
    { event: { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a.ts" } } },
    {
      event: {
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
          isError: false,
        },
      },
    },
    {
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          model: "anthropic/claude-opus-4-5",
          content: [{ type: "text", text: "Read it." }],
        },
      },
    },
    {
      event: {
        type: "turn_end",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Read it." }],
          usage: { input: 10, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        },
      },
    },
  ];
  const factory = makeFakeSessionFactory([script], { sessionId: "pi-session-42" });
  const driver = new PiCodingAgentDriver({ createSession: factory });
  const runtime = new ClaudeCodeRuntime({ storageDir, drivers: { "pi-coding-agent": driver } });

  const session = await runtime.start({ prompt: "test", driver: "pi-coding-agent", cwd: "/tmp" });
  await waitForState(runtime, session.sessionId, "idle");

  const status = await runtime.status(session.sessionId);
  assert.equal(status?.driver, "pi-coding-agent");
  assert.equal(status?.driverSessionId, "pi-session-42");
  assert.equal(status?.state, "idle");

  const transcript = await runtime.readTranscript(session.sessionId);
  assert.equal(transcript.items.some((i) => i.type === "message"), true);
  assert.equal(transcript.items.some((i) => i.type === "tool"), true);
  assert.equal(transcript.items.some((i) => i.type === "result"), true);
});

test("integration — usage is reported per turn_end and accumulates across two runs", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "pi-coding-agent-usage-"));
  const firstUsage = {
    input: 100, output: 10, cacheRead: 50, cacheWrite: 5, totalTokens: 165,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
  };
  const secondUsage = {
    input: 20, output: 5, cacheRead: 10, cacheWrite: 2, totalTokens: 37,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.005 },
  };
  const factory = makeFakeSessionFactory([
    [{
      event: {
        type: "turn_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "one" }], usage: firstUsage },
      },
    }],
    [{
      event: {
        type: "turn_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "two" }], usage: secondUsage },
      },
    }],
  ]);
  const driver = new PiCodingAgentDriver({ createSession: factory });
  const runtime = new ClaudeCodeRuntime({ storageDir, drivers: { "pi-coding-agent": driver } });

  const session = await runtime.start({ prompt: "first", driver: "pi-coding-agent", cwd: "/tmp" });
  await waitForState(runtime, session.sessionId, "idle");
  await runtime.send({ sessionId: session.sessionId, message: "second" });
  await waitForState(runtime, session.sessionId, "idle");

  const transcript = await runtime.readTranscript(session.sessionId);
  const results = resultEvents(transcript.items);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.usage?.inputTokens, 100);
  assert.equal(results[1]?.usage?.inputTokens, 20);

  // Consumers can sum per-result usage client-side; verify the total is non-zero.
  const totalInput = results.reduce((sum, r) => sum + (r.usage?.inputTokens ?? 0), 0);
  assert.equal(totalInput, 120);
});

test("integration — send forwards driverSessionId as resumeSessionId so the SDK can continue prior history", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "pi-coding-agent-resume-"));
  const seenInputs: Array<{ resumeSessionId?: string }> = [];
  const scripts: ScriptedEvent[][] = [
    [{
      event: {
        type: "turn_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "one" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
      },
    }],
    [{
      event: {
        type: "turn_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "two" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
      },
    }],
  ];
  let runIndex = 0;
  const factory: PiCodingAgentSessionFactory = async (input) => {
    seenInputs.push({ resumeSessionId: input.resumeSessionId });
    const script = scripts[runIndex++] ?? [];
    let listener: ((event: unknown) => void) | undefined;
    return {
      sessionId: "pi-session-resume",
      subscribe(l) {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
      async prompt(_text, _opts) {
        for (const item of script) {
          if (!listener) break;
          listener(item.event);
        }
      },
      async abort() {},
      dispose() {},
      get state() {
        return { messages: [] };
      },
    } as PiCodingAgentSessionLike;
  };
  const driver = new PiCodingAgentDriver({ createSession: factory });
  const runtime = new ClaudeCodeRuntime({ storageDir, drivers: { "pi-coding-agent": driver } });

  const session = await runtime.start({ prompt: "first", driver: "pi-coding-agent", cwd: "/tmp" });
  await waitForState(runtime, session.sessionId, "idle");
  await runtime.send({ sessionId: session.sessionId, message: "second" });
  await waitForState(runtime, session.sessionId, "idle");

  // First createSession invocation is a fresh start (no resumeSessionId).
  // Second one carries the persisted driverSessionId so the driver can
  // hand it to SessionManager.continueRecent.
  assert.equal(seenInputs.length, 2);
  assert.equal(seenInputs[0]?.resumeSessionId, undefined);
  assert.equal(seenInputs[1]?.resumeSessionId, "pi-session-resume");
});

test("integration — send routes through driver.run and produces a result", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "pi-coding-agent-send-"));
  const factory = makeFakeSessionFactory([
    [{
      event: {
        type: "turn_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "first" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
      },
    }],
    [{
      event: {
        type: "turn_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "second" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
      },
    }],
  ]);
  const driver = new PiCodingAgentDriver({ createSession: factory });
  const runtime = new ClaudeCodeRuntime({ storageDir, drivers: { "pi-coding-agent": driver } });

  const session = await runtime.start({ prompt: "first", driver: "pi-coding-agent", cwd: "/tmp" });
  await waitForState(runtime, session.sessionId, "idle");
  const afterFirst = await runtime.events(session.sessionId);

  await runtime.send({ sessionId: session.sessionId, message: "second" });
  await waitForState(runtime, session.sessionId, "idle");

  const newEvents = await runtime.events(session.sessionId, afterFirst.nextCursor);
  assert.equal(newEvents.items.some((i) => i.type === "result"), true);
});

test("integration — status returns idle after a successful run", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "pi-coding-agent-status-"));
  const factory = makeFakeSessionFactory([
    [{
      event: {
        type: "turn_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
      },
    }],
  ]);
  const driver = new PiCodingAgentDriver({ createSession: factory });
  const runtime = new ClaudeCodeRuntime({ storageDir, drivers: { "pi-coding-agent": driver } });

  const session = await runtime.start({ prompt: "test", driver: "pi-coding-agent", cwd: "/tmp" });
  await waitForState(runtime, session.sessionId, "idle");
  const status = await runtime.status(session.sessionId);
  assert.equal(status?.state, "idle");
  assert.equal(status?.driver, "pi-coding-agent");
});

test("integration — stop interrupts a long-running session and transitions to stopped", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "pi-coding-agent-stop-"));
  // Use a long-delayed event so we can interrupt mid-prompt.
  const factory = makeFakeSessionFactory([
    [
      { delayMs: 500, event: { type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "late" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } } },
    ],
  ]);
  const driver = new PiCodingAgentDriver({ createSession: factory });
  const runtime = new ClaudeCodeRuntime({ storageDir, drivers: { "pi-coding-agent": driver } });

  const session = await runtime.start({ prompt: "test", driver: "pi-coding-agent", cwd: "/tmp" });
  // Give the driver time to spawn the session and start the prompt.
  await new Promise((r) => setTimeout(r, 50));
  await runtime.stop(session.sessionId);

  const status = await runtime.status(session.sessionId);
  assert.ok(status?.state === "stopped" || status?.state === "interrupted" || status?.state === "idle");
});

test("integration — createSession failure surfaces as an error envelope and run fails", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "pi-coding-agent-fail-"));
  const factory = makeFakeSessionFactory([], { throwOnCreate: new Error("boom") });
  const driver = new PiCodingAgentDriver({ createSession: factory });
  const runtime = new ClaudeCodeRuntime({ storageDir, drivers: { "pi-coding-agent": driver } });

  const session = await runtime.start({ prompt: "test", driver: "pi-coding-agent", cwd: "/tmp" });
  await waitForState(runtime, session.sessionId, "failed");
  const status = await runtime.status(session.sessionId);
  assert.equal(status?.state, "failed");
  assert.ok(status?.lastError?.message?.includes("boom"));
});

// ---------------------------------------------------------------------------
// Direct driver invocation — kill semantics, delivery ordering
// ---------------------------------------------------------------------------

test("direct driver — kill aborts in-flight prompt and resolves done with SIGINT", async () => {
  const factory = makeFakeSessionFactory([
    [
      { delayMs: 1000, event: { type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } } },
    ],
  ]);
  const driver = new PiCodingAgentDriver({ createSession: factory });
  const events: DriverEventEnvelope[] = [];
  const handle = driver.run(
    { sessionId: "s", prompt: "p", cwd: "/tmp" },
    (e) => { events.push(e); },
  );
  // Yield once so createSession resolves and the init system event fires.
  await new Promise((r) => setTimeout(r, 20));
  handle.kill();
  const result = await handle.done;
  assert.equal(result.code, 130);
  assert.equal(result.signal, "SIGINT");
});

// ---------------------------------------------------------------------------
// Per-call thinkingLevel resolution
// ---------------------------------------------------------------------------

function makeRecordingFactory(): {
  factory: PiCodingAgentSessionFactory;
  inputs: PiCodingAgentSessionFactoryInput[];
} {
  const inputs: PiCodingAgentSessionFactoryInput[] = [];
  const factory: PiCodingAgentSessionFactory = async (input) => {
    inputs.push(input);
    let listener: ((event: unknown) => void) | undefined;
    return {
      sessionId: "pi-session-tl",
      subscribe(l) {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
      async prompt(_t) {
        listener?.({
          type: "turn_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "ok" }],
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          },
        });
      },
    } satisfies PiCodingAgentSessionLike;
  };
  return { factory, inputs };
}

test("thinkingLevel — per-call value is forwarded to the session factory", async () => {
  const { factory, inputs } = makeRecordingFactory();
  const driver = new PiCodingAgentDriver({ createSession: factory, defaultThinkingLevel: "low" });
  await driver.run(
    { sessionId: "s", prompt: "p", cwd: "/tmp", thinkingLevel: "high" },
    () => {},
  ).done;
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]?.thinkingLevel, "high");
});

test("thinkingLevel — falls back to defaultThinkingLevel when omitted", async () => {
  const { factory, inputs } = makeRecordingFactory();
  const driver = new PiCodingAgentDriver({ createSession: factory, defaultThinkingLevel: "medium" });
  await driver.run({ sessionId: "s", prompt: "p", cwd: "/tmp" }, () => {}).done;
  assert.equal(inputs[0]?.thinkingLevel, "medium");
});

test("thinkingLevel — default-of-defaults is 'high' when nothing is configured", async () => {
  const { factory, inputs } = makeRecordingFactory();
  const driver = new PiCodingAgentDriver({ createSession: factory });
  await driver.run({ sessionId: "s", prompt: "p", cwd: "/tmp" }, () => {}).done;
  assert.equal(inputs[0]?.thinkingLevel, "high");
});

test("thinkingLevel — effective level + source are echoed on the init system event", async () => {
  const { factory } = makeRecordingFactory();
  const driver = new PiCodingAgentDriver({ createSession: factory, defaultThinkingLevel: "low" });

  // Per-call override path
  const perCall: DriverEventEnvelope[] = [];
  await driver.run(
    { sessionId: "s", prompt: "p", cwd: "/tmp", thinkingLevel: "high" },
    (e) => { perCall.push(e); },
  ).done;
  const initPerCall = perCall.find(
    (e) => e.type === "message" && e.payload.type === "system" && e.payload.subtype === "init",
  );
  assert.ok(initPerCall);
  const rawPerCall =
    initPerCall.type === "message" && initPerCall.payload.type === "system"
      ? (initPerCall.payload.raw as Record<string, unknown>)
      : {};
  assert.equal(rawPerCall.thinkingLevel, "high");
  assert.equal(rawPerCall.thinkingLevelSource, "per-call");

  // Default fallback path
  const defaulted: DriverEventEnvelope[] = [];
  await driver.run(
    { sessionId: "s", prompt: "p", cwd: "/tmp" },
    (e) => { defaulted.push(e); },
  ).done;
  const initDefault = defaulted.find(
    (e) => e.type === "message" && e.payload.type === "system" && e.payload.subtype === "init",
  );
  assert.ok(initDefault);
  const rawDefault =
    initDefault.type === "message" && initDefault.payload.type === "system"
      ? (initDefault.payload.raw as Record<string, unknown>)
      : {};
  assert.equal(rawDefault.thinkingLevel, "low");
  assert.equal(rawDefault.thinkingLevelSource, "default");
});

test("securityMode — init event echoes requested mode + enforcement note (pi-coding-agent has no native sandbox)", async () => {
  const { factory } = makeRecordingFactory();
  const driver = new PiCodingAgentDriver({ createSession: factory });

  const events: DriverEventEnvelope[] = [];
  await driver.run(
    { sessionId: "s", prompt: "p", cwd: "/tmp", securityMode: "yolo" },
    (e) => { events.push(e); },
  ).done;

  const init = events.find(
    (e) => e.type === "message" && e.payload.type === "system" && e.payload.subtype === "init",
  );
  assert.ok(init);
  const raw =
    init.type === "message" && init.payload.type === "system"
      ? (init.payload.raw as Record<string, unknown>)
      : {};
  assert.equal(raw.securityMode, "yolo");
  assert.equal(raw.securityModeEnforced, false);
  assert.match(String(raw.securityModeNote), /no native sandbox/i);
});

test("securityMode — defaults to 'safe' on the init event when caller omits it", async () => {
  const { factory } = makeRecordingFactory();
  const driver = new PiCodingAgentDriver({ createSession: factory });

  const events: DriverEventEnvelope[] = [];
  await driver.run({ sessionId: "s", prompt: "p", cwd: "/tmp" }, (e) => { events.push(e); }).done;

  const init = events.find(
    (e) => e.type === "message" && e.payload.type === "system" && e.payload.subtype === "init",
  );
  const raw =
    init?.type === "message" && init.payload.type === "system"
      ? (init.payload.raw as Record<string, unknown>)
      : {};
  assert.equal(raw.securityMode, "safe");
  assert.equal(raw.securityModeEnforced, false);
});

test("thinkingLevel — runtime.start propagates per-call value through to the driver", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "pi-coding-agent-tl-"));
  const { factory, inputs } = makeRecordingFactory();
  const driver = new PiCodingAgentDriver({ createSession: factory, defaultThinkingLevel: "low" });
  const runtime = new ClaudeCodeRuntime({ storageDir, drivers: { "pi-coding-agent": driver } });

  const session = await runtime.start({
    prompt: "test",
    driver: "pi-coding-agent",
    cwd: "/tmp",
    thinkingLevel: "high",
  });
  await waitForState(runtime, session.sessionId, "idle");
  assert.equal(inputs[0]?.thinkingLevel, "high");
});

test("resume — driverSessionDir is stable across runs for the same sessionId even when cwd changes (issue #5)", async () => {
  // Regression for https://github.com/durandom/pi-ca-leash/issues/5
  // Callers like spellkave run each turn from a fresh worktree, so cwd
  // changes per turn. The SDK's continueRecent(cwd) keys by cwd-encoded
  // path, which would silently fail to find prior session files. The fix
  // pins the SDK's sessionDir to a runtime-owned, sessionId-keyed path.
  const { factory, inputs } = makeRecordingFactory();
  const driver = new PiCodingAgentDriver({ createSession: factory });
  const storageDir = await mkdtemp(join(tmpdir(), "pi-coding-agent-driverdir-"));

  // Turn 1: cwd = /tmp/worktree-A
  await driver.run(
    { sessionId: "stable-uuid", prompt: "p1", cwd: "/tmp/worktree-A",
      sessionStorageDir: join(storageDir, "sessions", "stable-uuid") },
    () => {},
  ).done;

  // Turn 2: SAME runtime sessionId, DIFFERENT cwd (simulating worktree drift)
  await driver.run(
    { sessionId: "stable-uuid", prompt: "p2", cwd: "/tmp/worktree-B",
      sessionStorageDir: join(storageDir, "sessions", "stable-uuid"),
      resumeSessionId: "stable-uuid" },
    () => {},
  ).done;

  assert.equal(inputs.length, 2);
  // Both runs see the same dir → SDK's continueRecent will look in the
  // same place where the prior turn wrote, regardless of cwd drift.
  assert.equal(inputs[0]?.driverSessionDir, inputs[1]?.driverSessionDir);
  assert.match(inputs[0]?.driverSessionDir ?? "", /stable-uuid\/pi-coding-agent$/);
});

test("resume — driverSessionDir falls back to per-sessionId tmpdir when runtime omits sessionStorageDir", async () => {
  // Direct driver tests don't supply sessionStorageDir; the driver must
  // still pick a stable dir keyed by sessionId so resume works in tests.
  const { factory, inputs } = makeRecordingFactory();
  const driver = new PiCodingAgentDriver({ createSession: factory });
  await driver.run({ sessionId: "no-storage", prompt: "p", cwd: "/tmp" }, () => {}).done;
  await driver.run({ sessionId: "no-storage", prompt: "p", cwd: "/tmp", resumeSessionId: "no-storage" }, () => {}).done;
  assert.equal(inputs[0]?.driverSessionDir, inputs[1]?.driverSessionDir);
  assert.match(inputs[0]?.driverSessionDir ?? "", /no-storage\/pi-coding-agent$/);
});

test("direct driver — delivery ordering preserved for slow handlers", async () => {
  const received: string[] = [];
  const slowHandler = async (e: DriverEventEnvelope) => {
    await new Promise((r) => setTimeout(r, 5));
    if (e.type === "message") received.push(e.payload.type);
  };
  const factory = makeFakeSessionFactory([
    [
      { event: { type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} } },
      { event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } } },
      { event: { type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hi" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } } },
    ],
  ]);
  const driver = new PiCodingAgentDriver({ createSession: factory });
  await driver.run({ sessionId: "s", prompt: "p", cwd: "/tmp" }, slowHandler).done;
  assert.deepEqual(received, ["system", "tool_use", "assistant", "result"]);
});
