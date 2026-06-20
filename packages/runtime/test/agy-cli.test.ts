import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgyCliCommand,
  AgyCliDriver,
} from "../src/drivers/agy-cli.js";
import { ClaudeCodeRuntime } from "../src/runtime.js";
import type { ResultEvent, DriverEventEnvelope } from "../src/types.js";

// ---------------------------------------------------------------------------
// buildAgyCliCommand
// ---------------------------------------------------------------------------

test("buildAgyCliCommand — fresh run maps securityMode safe to --sandbox", () => {
  const args = buildAgyCliCommand({
    prompt: "hello",
    cwd: "/work",
    securityMode: "safe",
  });
  assert.ok(args.includes("--sandbox"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
});

test("buildAgyCliCommand — securityMode yolo maps to --dangerously-skip-permissions", () => {
  const args = buildAgyCliCommand({
    prompt: "hello",
    cwd: "/work",
    securityMode: "yolo",
  });
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("--sandbox"));
});

test("buildAgyCliCommand — forwards resume conversation ID, model, and log-file", () => {
  const args = buildAgyCliCommand({
    prompt: "hello",
    cwd: "/work",
    model: "gemini-3.5-pro",
    resumeSessionId: "session-abc",
    logFile: "/tmp/agy.log",
  });
  assert.deepEqual(args, [
    "-p",
    "--sandbox",
    "--log-file",
    "/tmp/agy.log",
    "--model",
    "gemini-3.5-pro",
    "--conversation",
    "session-abc",
  ]);
});

// ---------------------------------------------------------------------------
// Mocks & Test Helpers
// ---------------------------------------------------------------------------

function makeFakeSpawn(outputLines: string[], exitCode = 0, logContent = "") {
  return function fakeSpawn(_cmd: string, args: string[], _opts: unknown) {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable;
      stderr: Readable;
      stdin: Writable;
      kill: (sig?: string) => void;
    };

    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.kill = () => {};

    // Find the log-file argument and write logContent to it
    const logFileIndex = args.indexOf("--log-file");
    const logFilePath = logFileIndex !== -1 ? args[logFileIndex + 1] : undefined;

    setImmediate(async () => {
      if (logFilePath && logContent) {
        try {
          await writeFile(logFilePath, logContent);
        } catch {
          // ignore
        }
      }

      for (const line of outputLines) {
        stdout.push(line);
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

// ---------------------------------------------------------------------------
// Integration: fake subprocess → ClaudeCodeRuntime
// ---------------------------------------------------------------------------

test("integration — agy driver produces expected RuntimeEvents and extracts conversation ID", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "agy-test-"));
  const logContent = "I0620 13:00:00.000000 12345 server.go:789] Created conversation agy-session-999\n";
  const outputLines = ["Hello from agy!"];

  const spawn = makeFakeSpawn(outputLines, 0, logContent);
  const driver = new AgyCliDriver({ spawn });
  const runtime = new ClaudeCodeRuntime({ storageDir, drivers: { agy: driver } });

  const session = await runtime.start({ prompt: "test", driver: "agy", cwd: "/tmp" });
  await waitForState(runtime, session.sessionId, "idle");

  const status = await runtime.status(session.sessionId);
  assert.equal(status?.driver, "agy");
  assert.equal(status?.driverSessionId, "agy-session-999"); // extracted from logFile

  const transcript = await runtime.readTranscript(session.sessionId);
  const hasMessage = transcript.items.some((item) => item.type === "message" && item.role === "assistant");
  const hasResult = transcript.items.some((item) => item.type === "result");
  
  assert.equal(hasMessage, true, "transcript should have an assistant message event");
  assert.equal(hasResult, true, "transcript should have a result event");
  assert.equal(status?.state, "idle");
});

test("integration — agy driver handles exit code failure", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "agy-test-"));
  const spawn = makeFakeSpawn([], 1); // Exit code 1
  const driver = new AgyCliDriver({ spawn });
  const runtime = new ClaudeCodeRuntime({ storageDir, drivers: { agy: driver } });

  const session = await runtime.start({ prompt: "test", driver: "agy", cwd: "/tmp" });
  await waitForState(runtime, session.sessionId, "failed");

  const status = await runtime.status(session.sessionId);
  assert.equal(status?.state, "failed");
});
