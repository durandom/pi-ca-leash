import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeCliCommand, ClaudeCliDriver, coerceClaudeCliSessionId } from "../src/drivers/claude-cli.js";
import { ClaudeCodeRuntime } from "../src/runtime.js";
import type { DriverEventEnvelope } from "../src/types.js";

test("buildClaudeCliCommand builds fresh print-mode run", () => {
  const args = buildClaudeCliCommand({
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    prompt: "hello",
    cwd: "/work",
    name: "worker",
    permissionMode: "bypassPermissions",
  });
  assert.deepEqual(args, [
    "-p",
    "--output-format",
    "stream-json",
    "--session-id",
    "550e8400-e29b-41d4-a716-446655440000",
    "--name",
    "worker",
    "--permission-mode",
    "bypassPermissions",
    "hello",
  ]);
});

test("buildClaudeCliCommand builds resumed print-mode run with model and prompt options", () => {
  const args = buildClaudeCliCommand({
    sessionId: "local",
    prompt: "continue",
    cwd: "/work",
    resumeSessionId: "sid-abc",
    model: "claude-sonnet-4-6",
    appendSystemPrompt: "Be brief.",
    tools: ["Bash(git status)", "Read"],
    additionalDirectories: ["/extra"],
  });
  assert.deepEqual(args, [
    "-p",
    "--output-format",
    "stream-json",
    "--resume",
    coerceClaudeCliSessionId("sid-abc"),
    "--model",
    "claude-sonnet-4-6",
    "--append-system-prompt",
    "Be brief.",
    "--allowedTools",
    "Bash(git status)",
    "Read",
    "--add-dir",
    "/extra",
    "continue",
  ]);
});

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

async function waitForState(runtime: ClaudeCodeRuntime, sessionId: string, expected: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const status = await runtime.status(sessionId);
    if (status?.state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for state ${expected}`);
}

test("integration produces RuntimeEvents from Claude stream-json messages", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-cli-test-"));
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-42", model: "claude-sonnet-4-6" }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hello from claude cli" }] } }),
    JSON.stringify({ type: "result", result: "done", is_error: false }),
  ];
  const driver = new ClaudeCliDriver({ spawn: makeFakeSpawn(lines, 0) });
  const runtime = new ClaudeCodeRuntime({ storageDir, drivers: { "claude-cli": driver } });

  const session = await runtime.start({ prompt: "test", driver: "claude-cli", cwd: "/tmp" });
  await waitForState(runtime, session.sessionId, "idle");

  const status = await runtime.status(session.sessionId);
  assert.equal(status?.driver, "claude-cli");
  assert.equal(status?.driverSessionId, "claude-session-42");
  assert.equal(status?.model, "claude-sonnet-4-6");

  const transcript = await runtime.readTranscript(session.sessionId);
  assert.equal(transcript.items.some((item) => item.type === "message"), true);
  assert.equal(transcript.items.some((item) => item.type === "result"), true);
});

test("ClaudeCliDriver defaults permissionMode to bypassPermissions when caller omits it", async () => {
  let capturedArgs: string[] = [];
  const fakeSpawn = function(_cmd: string, args: string[], _opts: unknown) {
    capturedArgs = args;
    const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; kill: () => void };
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => {};
    setImmediate(() => {
      stdout.push(null);
      stderr.push(null);
      child.emit("close", 0, null);
    });
    return child;
  } as unknown as typeof import("node:child_process").spawn;

  const driver = new ClaudeCliDriver({ spawn: fakeSpawn });
  const handle = driver.run({ sessionId: "s1", prompt: "noop", cwd: "/tmp" }, () => {});
  await handle.done;

  const idx = capturedArgs.indexOf("--permission-mode");
  assert.notEqual(idx, -1, "expected --permission-mode to be present by default");
  assert.equal(capturedArgs[idx + 1], "bypassPermissions");
});

test("explicit permissionMode wins over the driver default", () => {
  const args = buildClaudeCliCommand({
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    prompt: "noop",
    cwd: "/tmp",
    permissionMode: "acceptEdits",
  });
  const idx = args.indexOf("--permission-mode");
  assert.equal(args[idx + 1], "acceptEdits");
});

test("non-UUID session id is coerced before being passed to --session-id", () => {
  const args = buildClaudeCliCommand({
    sessionId: "bugfix:e2e-scenario-d-claude-cli",
    prompt: "hi",
    cwd: "/work",
  });
  const idx = args.indexOf("--session-id");
  assert.notEqual(idx, -1);
  const id = args[idx + 1];
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  // Deterministic: same input → same UUID across calls (warm-resume contract).
  assert.equal(id, coerceClaudeCliSessionId("bugfix:e2e-scenario-d-claude-cli"));
  // Passthrough: already-UUID input is unchanged.
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  assert.equal(coerceClaudeCliSessionId(uuid), uuid);
});

test("--resume value is also coerced when given a non-UUID label", () => {
  const args = buildClaudeCliCommand({
    sessionId: "ignored",
    prompt: "go",
    cwd: "/work",
    resumeSessionId: "bugfix:resume-label",
  });
  const idx = args.indexOf("--resume");
  assert.notEqual(idx, -1);
  assert.match(args[idx + 1], /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("stderr-only exit-0 produces an error envelope, not silent stdout", async () => {
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
      stderr.push("Error: Invalid session ID. Must be a valid UUID.\n");
      stderr.push(null);
      child.emit("close", 0, null);
    });
    return child;
  } as unknown as typeof import("node:child_process").spawn;

  const driver = new ClaudeCliDriver({ spawn: fakeSpawn });
  const events: DriverEventEnvelope[] = [];
  const handle = driver.run({ sessionId: "s1", prompt: "p", cwd: "/tmp" }, (event) => {
    events.push(event);
  });
  const result = await handle.done;

  assert.equal(result.code, 0);
  const error = events.find((event) => event.type === "error");
  assert.ok(error, "expected an error envelope on exit-0 + stderr-only");
  if (error?.type === "error") {
    assert.equal(error.payload.code, "CLAUDE_CLI_NO_OUTPUT");
    assert.match(error.payload.message ?? "", /Invalid session ID/);
  }
});

test("non-zero exit surfaces stderr as error envelope", async () => {
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
      stderr.push("boom");
      stderr.push(null);
      child.emit("close", 1, null);
    });
    return child;
  } as unknown as typeof import("node:child_process").spawn;

  const driver = new ClaudeCliDriver({ spawn: fakeSpawn });
  const events: DriverEventEnvelope[] = [];
  const handle = driver.run({ sessionId: "s1", prompt: "fail", cwd: "/tmp" }, (event) => {
    events.push(event);
  });
  const result = await handle.done;

  assert.equal(result.code, 1);
  const error = events.find((event) => event.type === "error");
  assert.equal(error?.type === "error" && error.payload.message?.includes("boom"), true);
});
