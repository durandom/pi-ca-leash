import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  ClaudePtyDriver,
  buildPtyArgs,
  PTY_ALLOCATOR,
  type PtyProcessLike,
  type PtySpawnFn,
} from "../src/drivers/claude-pty.js";
import type { DriverEventEnvelope } from "../src/types.js";

/** Minimal node-pty stand-in that records writes and lets the test drive I/O. */
class FakePty implements PtyProcessLike {
  readonly pid = 4242;
  readonly writes: string[] = [];
  private dataCb?: (data: string) => void;
  private exitCb?: (event: { exitCode: number; signal?: number }) => void;
  /** Test hook fired on every write (used to simulate claude's reaction). */
  onWrite?: (data: string, self: FakePty) => void | Promise<void>;
  readonly kills: (string | undefined)[] = [];

  write(data: string): void {
    this.writes.push(data);
    void this.onWrite?.(data, this);
  }
  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (event: { exitCode: number; signal?: number }) => void): void {
    this.exitCb = cb;
  }
  kill(signal?: string): void {
    this.kills.push(signal);
    this.exit(0);
  }
  emitData(data: string): void {
    this.dataCb?.(data);
  }
  exit(code: number): void {
    this.exitCb?.({ exitCode: code });
  }
}

interface Harness {
  root: string;
  configDir: string;
  sessionStorageDir: string;
  /** File the driver tails for hook payloads (matches the driver's path). */
  hooksPath: string;
}

async function makeHarness(sessionId: string): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "ci-interactive-"));
  const configDir = join(root, "config");
  const sessionStorageDir = join(root, "session");
  await mkdir(sessionStorageDir, { recursive: true });
  return {
    root,
    configDir,
    sessionStorageDir,
    hooksPath: join(sessionStorageDir, "interactive-hooks.jsonl"),
  };
}

/** Build a Stop hook payload line (turn end + assistant text). */
const stopLine = (text: string) =>
  JSON.stringify({ hook_event_name: "Stop", last_assistant_message: text }) + "\n";
/** Build a PostToolUse hook payload line. */
const toolLine = (name: string, input: unknown, response: unknown) =>
  JSON.stringify({ hook_event_name: "PostToolUse", tool_name: name, tool_input: input, tool_response: response }) + "\n";

const FAST = {
  readyQuietMs: 15,
  readyTimeoutMs: 300,
  startupMinMs: 20,
  submitDelayMs: 3,
  submitRetryDelayMs: 20,
  pollIntervalMs: 8,
  turnTimeoutMs: 2_000,
  quitGraceMs: 20,
  killGraceMs: 20,
};

test("interactive turn: types prompt, emits hook tool + assistant, ends on Stop", async () => {
  const sessionId = "sess-basic";
  const h = await makeHarness(sessionId);
  const fake = new FakePty();

  // Simulate claude: when the submit Enter arrives, the hooks fire — a
  // PostToolUse then a Stop (with the assistant's final message).
  fake.onWrite = async (data) => {
    if (data === "\r") {
      await appendFile(h.hooksPath, toolLine("Read", { file_path: "/x" }, { is_error: false }));
      await appendFile(h.hooksPath, stopLine("hi from TUI"));
    }
    if (data === "/quit\r") fake.exit(0);
  };

  const driver = new ClaudePtyDriver({
    ptySpawn: () => fake,
    configDir: h.configDir,
    ...FAST,
  });

  const events: DriverEventEnvelope[] = [];
  const handle = driver.run(
    { sessionId, prompt: "hello", cwd: h.root, securityMode: "yolo", sessionStorageDir: h.sessionStorageDir },
    (e) => {
      events.push(e);
    },
  );
  const result = await handle.done;

  assert.equal(result.code, 0);
  assert.ok(fake.writes.some((w) => w.includes("\x1b[200~hello\x1b[201~")), "bracketed paste prompt");
  assert.ok(fake.writes.includes("\r"), "submit Enter");
  // tool_use + tool_result from the PostToolUse hook.
  const toolUse = events.find((e) => e.type === "message" && e.payload.type === "tool_use");
  assert.ok(toolUse, "tool_use message emitted from PostToolUse hook");
  // assistant text from the Stop hook's last_assistant_message.
  const assistant = events.find(
    (e) => e.type === "message" && e.payload.type === "assistant",
  );
  assert.ok(assistant, "assistant message emitted from Stop hook");
  await driver.dispose(sessionId);
});

test("interactive turn retries Enter when the prompt remains visible", async () => {
  const sessionId = "sess-submit-retry";
  const h = await makeHarness(sessionId);
  const fake = new FakePty();
  let submitCount = 0;

  fake.onWrite = async (data, self) => {
    if (data.includes("retry me")) {
      self.emitData(data);
    }
    if (data === "\r") {
      submitCount += 1;
      if (submitCount === 2) {
        await appendFile(h.hooksPath, stopLine("submitted after retry"));
      }
    }
    if (data === "/quit\r") fake.exit(0);
  };

  const driver = new ClaudePtyDriver({
    ptySpawn: () => fake,
    configDir: h.configDir,
    ...FAST,
  });

  const handle = driver.run(
    { sessionId, prompt: "retry me", cwd: h.root, securityMode: "yolo", sessionStorageDir: h.sessionStorageDir },
    () => {},
  );
  const result = await handle.done;

  assert.equal(result.code, 0);
  assert.equal(submitCount, 2, "second Enter retries a swallowed submit");
  await driver.dispose(sessionId);
});

test("safe securityMode is refused with a clear error (no pty spawned)", async () => {
  const sessionId = "sess-safe";
  const h = await makeHarness(sessionId);
  let spawned = false;
  const driver = new ClaudePtyDriver({
    ptySpawn: () => {
      spawned = true;
      return new FakePty();
    },
    configDir: h.configDir,
    ...FAST,
  });

  const events: DriverEventEnvelope[] = [];
  const handle = driver.run(
    { sessionId, prompt: "hi", cwd: h.root, securityMode: "safe", sessionStorageDir: h.sessionStorageDir },
    (e) => events.push(e),
  );
  const result = await handle.done;

  assert.equal(result.code, 1);
  assert.equal(spawned, false, "must not spawn a pty in refused safe mode");
  const err = events.find((e) => e.type === "error");
  assert.equal(err?.type === "error" && err.payload.code, "CLAUDE_PTY_SAFE_UNSUPPORTED");
});

test("dispose() types /quit into the live TUI", async () => {
  const sessionId = "sess-quit";
  const h = await makeHarness(sessionId);
  const fake = new FakePty();
  fake.onWrite = async (data) => {
    if (data === "\r") {
      await appendFile(h.hooksPath, stopLine("done"));
    }
    if (data === "/quit\r") {
      fake.exit(0); // claude shuts down on /quit
    }
  };
  const driver = new ClaudePtyDriver({ ptySpawn: () => fake, configDir: h.configDir, ...FAST });

  const handle = driver.run(
    { sessionId, prompt: "x", cwd: h.root, securityMode: "yolo", sessionStorageDir: h.sessionStorageDir },
    () => {},
  );
  await handle.done;
  await driver.dispose(sessionId);

  assert.ok(fake.writes.includes("/quit\r"), "/quit sent on dispose");
});

test("dispose() escalates when /quit does not make the TUI exit", async () => {
  const sessionId = "sess-quit-stuck";
  const h = await makeHarness(sessionId);
  const fake = new FakePty();
  fake.onWrite = async (data) => {
    if (data === "\r") {
      await appendFile(h.hooksPath, stopLine("done"));
    }
    // Reproducer for the CI hang: Claude's Stop hook fired and the turn is
    // complete, but the interactive TUI ignores /quit and keeps the PTY alive.
    if (data === "/quit\r") {
      // no exit
    }
  };
  fake.kill = (signal?: string) => {
    fake.kills.push(signal);
    if (signal === "SIGKILL") fake.exit(0);
  };
  const driver = new ClaudePtyDriver({ ptySpawn: () => fake, configDir: h.configDir, ...FAST });

  const handle = driver.run(
    { sessionId, prompt: "x", cwd: h.root, securityMode: "yolo", sessionStorageDir: h.sessionStorageDir },
    () => {},
  );
  await handle.done;
  await driver.dispose(sessionId);

  assert.ok(fake.writes.includes("/quit\r"), "/quit attempted first");
  assert.deepEqual(fake.kills, ["SIGTERM", "SIGKILL"]);
});

test("kill() sends ESC and resolves the turn as interrupted", async () => {
  const sessionId = "sess-esc";
  const h = await makeHarness(sessionId);
  const fake = new FakePty();
  // Never fire the Stop hook — the turn only ends because we interrupt it.
  fake.onWrite = (data) => {
    if (data === "/quit\r") fake.exit(0);
  };
  const driver = new ClaudePtyDriver({ ptySpawn: () => fake, configDir: h.configDir, ...FAST });

  const handle = driver.run(
    { sessionId, prompt: "long task", cwd: h.root, securityMode: "yolo", sessionStorageDir: h.sessionStorageDir },
    () => {},
  );
  // Let run() reach the poll loop, then interrupt.
  await new Promise((r) => setTimeout(r, 60));
  handle.kill("SIGINT");
  const result = await handle.done;

  assert.equal(result.code, 130);
  assert.equal(result.signal, "SIGINT");
  assert.ok(fake.writes.includes("\x1b"), "ESC sent on kill");
  await driver.dispose(sessionId);
});

test("buildPtyArgs: fresh launch uses --session-id, resume uses --resume", () => {
  const fresh = buildPtyArgs({ claudeSessionId: "uuid-1", settingsPath: "/s.json", model: "opus" });
  assert.deepEqual(fresh.slice(0, 4), ["--session-id", "uuid-1", "--settings", "/s.json"]);
  assert.ok(fresh.includes("--dangerously-skip-permissions"));
  assert.ok(!fresh.includes("--resume"));

  const resumed = buildPtyArgs({ claudeSessionId: "uuid-1", settingsPath: "/s.json", resume: true });
  assert.deepEqual(resumed.slice(0, 4), ["--resume", "uuid-1", "--settings", "/s.json"]);
  assert.ok(!resumed.includes("--session-id"));
});

test("respawn after the persistent process dies relaunches with --resume", async () => {
  const sessionId = "sess-respawn";
  const h = await makeHarness(sessionId);
  const spawnArgs: string[][] = [];
  const fakes: FakePty[] = [];
  const ptySpawn: PtySpawnFn = (_file, args) => {
    spawnArgs.push(args);
    const fake = new FakePty();
    fake.onWrite = async (data) => {
      if (data === "\r") await appendFile(h.hooksPath, stopLine("ok"));
      if (data === "/quit\r") fake.exit(0);
    };
    fakes.push(fake);
    return fake;
  };
  const driver = new ClaudePtyDriver({ ptySpawn, configDir: h.configDir, ...FAST });

  // Turn 1 — fresh start (no resumeSessionId).
  await driver
    .run(
      { sessionId, prompt: "one", cwd: h.root, securityMode: "yolo", sessionStorageDir: h.sessionStorageDir },
      () => {},
    )
    .done;
  // The persistent process dies between turns.
  fakes[0]!.exit(0);

  // Turn 2 — runtime passes resumeSessionId on every send(); the dead process
  // forces a respawn, which must reload context via --resume.
  await driver
    .run(
      {
        sessionId,
        prompt: "two",
        cwd: h.root,
        securityMode: "yolo",
        sessionStorageDir: h.sessionStorageDir,
        resumeSessionId: sessionId,
      },
      () => {},
    )
    .done;

  assert.equal(spawnArgs.length, 2, "two spawns: initial + respawn");
  assert.ok(spawnArgs[0]!.includes("--session-id"), "first launch is fresh");
  assert.ok(spawnArgs[1]!.includes("--resume"), "respawn reloads via --resume");
  await driver.dispose(sessionId);
});

test("disposeAll() tears down every live session", async () => {
  const h1 = await makeHarness("dispose-all-1");
  const h2 = await makeHarness("dispose-all-2");
  const turnFake = (hooksPath: string): FakePty => {
    const f = new FakePty();
    f.onWrite = async (data) => {
      if (data === "\r") await appendFile(hooksPath, stopLine("ok"));
      if (data === "/quit\r") f.exit(0);
    };
    return f;
  };
  const f1 = turnFake(h1.hooksPath);
  const f2 = turnFake(h2.hooksPath);
  const queue = [f1, f2];
  const driver = new ClaudePtyDriver({
    ptySpawn: () => queue.shift()!,
    configDir: h1.configDir,
    ...FAST,
  });

  await driver.run(
    { sessionId: "dispose-all-1", prompt: "a", cwd: h1.root, securityMode: "yolo", sessionStorageDir: h1.sessionStorageDir },
    () => {},
  ).done;
  await driver.run(
    { sessionId: "dispose-all-2", prompt: "b", cwd: h2.root, securityMode: "yolo", sessionStorageDir: h2.sessionStorageDir },
    () => {},
  ).done;

  await driver.disposeAll();

  assert.ok(f1.writes.includes("/quit\r"), "session 1 torn down");
  assert.ok(f2.writes.includes("/quit\r"), "session 2 torn down");
});

// ── real Python allocator: parent-death teardown ───────────────────────────
// These exercise the inline PTY_ALLOCATOR for real (no `claude` needed) to lock
// in the orphan fix: when the host dies, the pipe to the allocator's stdin
// closes, and the allocator must reap its child and exit rather than relay on.
const PY = process.env.PI_PTY_PYTHON ?? "python3";
const PY_AVAILABLE = (() => {
  try {
    return spawnSync(PY, ["--version"]).status === 0;
  } catch {
    return false;
  }
})();

function spawnAllocator(childArgs: string[]) {
  // Mirror the driver's production spawn: detached, piped stdio, size in env.
  return spawn(PY, ["-c", PTY_ALLOCATOR, ...childArgs], {
    env: { ...process.env, PI_PTY_COLS: "80", PI_PTY_ROWS: "24" },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
}

function awaitAllocatorExit(proc: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGKILL");
      } catch {
        // already gone
      }
      reject(new Error(`allocator did not exit within ${timeoutMs}ms — EOF teardown regressed`));
    }, timeoutMs);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

test(
  "allocator reaps its child and exits when stdin closes (host gone)",
  { skip: PY_AVAILABLE ? false : "python3 not available" },
  async () => {
    // Long-lived leaf that dies on the default SIGTERM.
    const proc = spawnAllocator([PY, "-c", "import time; time.sleep(30)"]);
    await new Promise((r) => setTimeout(r, 400)); // let pty.fork + exec settle
    proc.stdin!.end(); // simulate the host dying: our write end closes → EOF
    await awaitAllocatorExit(proc, 4000);
  },
);

test(
  "allocator escalates to SIGKILL when the child ignores SIGTERM",
  { skip: PY_AVAILABLE ? false : "python3 not available" },
  async () => {
    // Leaf ignores SIGTERM, so only the escalation SIGKILL can end it.
    const proc = spawnAllocator([
      PY,
      "-c",
      "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(30)",
    ]);
    await new Promise((r) => setTimeout(r, 500)); // ensure SIG_IGN is installed
    proc.stdin!.end();
    await awaitAllocatorExit(proc, 5000); // ~2s TERM grace + KILL + margin
  },
);

test("a spawn failure surfaces a structured spawn error (does not throw)", async () => {
  const sessionId = "sess-spawnfail";
  const h = await makeHarness(sessionId);
  // Inject a spawner that throws — same catch path as a missing node-pty,
  // without depending on whether the optional native dep is installed (and
  // without ever launching a real claude process).
  const driver = new ClaudePtyDriver({
    ptySpawn: () => {
      throw new Error("spawn claude ENOENT");
    },
    configDir: h.configDir,
    ...FAST,
  });
  const events: DriverEventEnvelope[] = [];
  const handle = driver.run(
    { sessionId, prompt: "hi", cwd: h.root, securityMode: "yolo", sessionStorageDir: h.sessionStorageDir },
    (e) => events.push(e),
  );
  const result = await handle.done;
  assert.equal(result.code, 1);
  const err = events.find((e) => e.type === "error");
  assert.equal(err?.type === "error" && err.payload.code, "CLAUDE_PTY_SPAWN_ERROR");
});
