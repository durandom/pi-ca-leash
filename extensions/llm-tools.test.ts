import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ClaudeCodeRuntime } from "../packages/runtime/src/internal.ts";
import { PiCaLeashManagedPeerApi, piCaLeashBridgeStorageDir, piCaLeashRuntimeStorageDir } from "../packages/intercom-bridge/src/index.ts";
import { ADVANCED_COMMANDS_ENV } from "./command-visibility.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const extensionModuleUrl = pathToFileURL(join(__dirname, "index.ts")).href;

const TOOL_NAMES = [
  "runtime_models",
  "extension_log",
  "peer_start",
  "peer_list",
  "peer_history",
  "peer_ask",
  "peer_send",
  "peer_interrupt",
  "peer_stop",
];

const ADVANCED_TOOL_NAMES = [
  "subagent_run",
  "subagent_list",
  "subagent_status",
  "team_spawn",
  "team_task",
  "team_message",
  "team_list",
  "team_stop",
];

async function ensurePiTuiStub(): Promise<void> {
  const dir = join(repoRoot, "node_modules", "@mariozechner", "pi-tui");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), `${JSON.stringify({
    name: "@mariozechner/pi-tui",
    type: "module",
    exports: "./index.js",
  }, null, 2)}\n`, "utf8");
  await writeFile(join(dir, "index.js"), [
    "export class Box { constructor(...args) { this.args = args; this.children = []; } addChild(child) { this.children.push(child); } }",
    "export class Text { constructor(text) { this.text = text; } }",
    "export function truncateToWidth(text, width, suffix = '…') {",
    "  const value = String(text);",
    "  return value.length <= width ? value : value.slice(0, Math.max(0, width - suffix.length)) + suffix;",
    "}",
    "export function visibleWidth(text) { return String(text).length; }",
    "",
  ].join("\n"), "utf8");
}

async function createCodexStub(delayMs = 0): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-ca-leash-codex-stub-"));
  const executable = join(dir, "codex");
  await writeFile(executable, [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "const resume = args[1] === 'resume';",
    "const prompt = args.at(-1) ?? '';",
    "const sessionId = resume ? args.at(-2) : `thread-${Math.random().toString(16).slice(2)}`;",
    "",
    "function buildReply(text) {",
    "  if (text.includes('[intercom kind=ask from=team-board]') && text.includes('Ship it')) {",
    "    return 'DONE: shipped';",
    "  }",
    "  if (text.includes('[intercom kind=ask from=team-board]')) {",
    "    return `teammate:${text}`;",
    "  }",
    "  if (text.includes('[intercom kind=ask from=team-chat]')) {",
    "    return `teammate:${text}`;",
    "  }",
    "  if (text.includes('[intercom kind=ask from=pi-main-agent]')) {",
    "    return `peer:${text}`;",
    "  }",
    "  return `assistant:${text}`;",
    "}",
    "",
    `const delayMs = ${delayMs};`,
    "const reply = buildReply(prompt);",
    "if (delayMs > 0) {",
    "  await new Promise((resolve) => setTimeout(resolve, delayMs));",
    "}",
    "console.log(JSON.stringify({ type: 'thread.started', thread_id: sessionId }));",
    "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'assistant_message', text: reply } }));",
    "console.log(JSON.stringify({ type: 'turn.completed', summary: `done:${reply}`, usage: { input_tokens: 1, output_tokens: 1 } }));",
    "",
  ].join("\n"), "utf8");
  await chmod(executable, 0o755);
  return executable;
}

interface FakeTool {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<any>;
}

async function loadExtensionHarness(defaultDriver: "claude-sdk" | "codex-cli", options: { codexDelayMs?: number; advanced?: boolean } = {}) {
  await ensurePiTuiStub();
  const codexExecutable = await createCodexStub(options.codexDelayMs ?? 0);
  const tempCwd = await mkdtemp(join(tmpdir(), "pi-ca-leash-extension-tools-"));
  const previousCwd = process.cwd();
  const previousDefaultDriver = process.env.PI_CLAUDE_RUNTIME_DRIVER;
  const previousCodexExecutable = process.env.CODEX_CLI_EXECUTABLE;
  const previousAdvanced = process.env[ADVANCED_COMMANDS_ENV];

  process.env.PI_CLAUDE_RUNTIME_DRIVER = defaultDriver;
  process.env.CODEX_CLI_EXECUTABLE = codexExecutable;
  process.env[ADVANCED_COMMANDS_ENV] = options.advanced ? "1" : "0";
  process.chdir(tempCwd);

  const tools = new Map<string, FakeTool>();
  const lifecycle = new Map<string, (...args: any[]) => any>();
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const userMessages: Array<{ message: unknown; options: unknown }> = [];
  const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
  const ctx = {
    ui: {
      setStatus() {},
      setWidget() {},
      notify(message: string, type?: "info" | "warning" | "error") { notifications.push({ message, type }); },
    },
  };

  const pi = {
    registerTool(tool: FakeTool) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    on(event: string, handler: (...args: any[]) => any) {
      lifecycle.set(event, handler);
    },
    sendMessage(message: unknown, options: unknown) {
      sentMessages.push({ message, options });
    },
    sendUserMessage(message: unknown, options: unknown) {
      userMessages.push({ message, options });
    },
  };

  const module = await import(extensionModuleUrl);
  await module.default(pi as never);

  return {
    tools,
    cwd: tempCwd,
    sentMessages,
    userMessages,
    notifications,
    async execute(name: string, params: unknown) {
      const tool = tools.get(name);
      assert.ok(tool, `Missing tool ${name}`);
      return tool.execute(`tool-${name}`, params, undefined, undefined, ctx);
    },
    async close() {
      await lifecycle.get("session_shutdown")?.();
      process.chdir(previousCwd);
      if (previousDefaultDriver == null) {
        delete process.env.PI_CLAUDE_RUNTIME_DRIVER;
      } else {
        process.env.PI_CLAUDE_RUNTIME_DRIVER = previousDefaultDriver;
      }
      if (previousCodexExecutable == null) {
        delete process.env.CODEX_CLI_EXECUTABLE;
      } else {
        process.env.CODEX_CLI_EXECUTABLE = previousCodexExecutable;
      }
      if (previousAdvanced == null) {
        delete process.env[ADVANCED_COMMANDS_ENV];
      } else {
        process.env[ADVANCED_COMMANDS_ENV] = previousAdvanced;
      }
    },
  };
}

test("extension registers expected LLM-callable tools", async () => {
  const harness = await loadExtensionHarness("codex-cli");
  try {
    assert.deepEqual([...harness.tools.keys()].sort(), [...TOOL_NAMES].sort());
  } finally {
    await harness.close();
  }
});

test("peer tools keep long one-time init guidance out of repeated tool prompts", async () => {
  const harness = await loadExtensionHarness("codex-cli");
  try {
    const peerStart = harness.tools.get("peer_start");
    assert.ok(peerStart, "Expected peer_start tool");
    const guidelines = peerStart.promptGuidelines?.join("\n") ?? "";
    assert.match(guidelines, /Use `peer_start` when you want a reusable long-lived peer/);
    assert.doesNotMatch(guidelines, /orchestrator in the driver's seat/);
    assert.doesNotMatch(guidelines, /multiple specialized peers at the same time/);

    const extensionLog = harness.tools.get("extension_log");
    assert.ok(extensionLog, "Expected extension_log tool");
    assert.doesNotMatch(extensionLog.promptGuidelines?.join("\n") ?? "", /orchestrator in the driver's seat/);
  } finally {
    await harness.close();
  }
});

test("advanced backend LLM tools are hidden unless advanced commands are enabled", async () => {
  const defaultHarness = await loadExtensionHarness("codex-cli");
  try {
    for (const name of ADVANCED_TOOL_NAMES) {
      assert.equal(defaultHarness.tools.has(name), false);
    }
  } finally {
    await defaultHarness.close();
  }

  const advancedHarness = await loadExtensionHarness("codex-cli", { advanced: true });
  try {
    assert.deepEqual([...advancedHarness.tools.keys()].sort(), [...TOOL_NAMES, ...ADVANCED_TOOL_NAMES].sort());
  } finally {
    await advancedHarness.close();
  }
});

test("runtime_models exposes driver-specific Lanista catalog", async () => {
  const harness = await loadExtensionHarness("codex-cli");
  try {
    const listed = await harness.execute("runtime_models", { driver: "codex-cli" });
    const text = String(listed.content?.[0]?.text ?? "");
    assert.match(text, /codex-cli models/);
    assert.match(text, /default gpt-5\.5/);
    assert.match(text, /best for/);
    assert.match(text, /context window=input token capacity/);
    assert.match(text, /gpt-5\.4-mini/);
    assert.doesNotMatch(text, /gpt-5\.1-codex-max/);

    const verbose = await harness.execute("runtime_models", { driver: "codex-cli", verbose: true });
    const verboseText = String(verbose.content?.[0]?.text ?? "");
    assert.match(verboseText, /max output/);
    assert.match(verboseText, /gpt-5\.1-codex-max/);
    assert.equal(listed.details.catalogs[0].driver, "codex-cli");
  } finally {
    await harness.close();
  }
});

test("extension_log appends structured local feedback", async () => {
  const harness = await loadExtensionHarness("codex-cli");
  try {
    const result = await harness.execute("extension_log", {
      category: "ux",
      severity: "high",
      summary: "Agent guide mixed operator controls into delegation policy.",
      observed: "The guide mentioned dashboard and list surfaces.",
      expected: "Agent-facing guidance should focus on delegation behavior.",
      suggestedFix: "Keep operator commands in help and agent policy in the init guide.",
      relatedTool: "peer_init",
      files: ["extensions/prompts/peer-init.md"],
    });

    const text = String(result.content?.[0]?.text ?? "");
    assert.match(text, /\.pi-ca-leash\/log\.md/);
    const log = await readFile(join(harness.cwd, ".pi-ca-leash", "log.md"), "utf8");
    assert.match(log, /## .* - ux - high/);
    assert.match(log, /Summary: Agent guide mixed operator controls/);
    assert.match(log, /Observed:\nThe guide mentioned dashboard and list surfaces\./);
    assert.match(log, /- tool: peer_init/);
    assert.match(log, /- file: extensions\/prompts\/peer-init\.md/);
  } finally {
    await harness.close();
  }
});

test("peer_start returns and displays no-babysitting guidance", async () => {
  const harness = await loadExtensionHarness("codex-cli", { codexDelayMs: 150 });
  try {
    const started = await harness.execute("peer_start", { prompt: "Wait briefly, then reply done." });
    const toolText = String(started.content?.[0]?.text ?? "");
    assert.match(toolText, /How to work with this peer:/);
    assert.match(toolText, /Do not poll it with peer_list, peer_history, or repeated peer_ask status checks\./);
    assert.equal(started.details.guidance.includes("Do not poll"), true);

    const visibleStart = harness.notifications.find((entry) => entry.message.includes("Peer started:"));
    assert.ok(visibleStart, "peer_start should emit operator guidance notification");
    assert.match(visibleStart.message, /Do not poll it with peer_list/);
  } finally {
    await harness.close();
  }
});

test("peer_start resolves model aliases before runtime launch", async () => {
  const harness = await loadExtensionHarness("codex-cli", { codexDelayMs: 150 });
  try {
    const started = await harness.execute("peer_start", { prompt: "Use a fast model.", model: "mini" });
    assert.equal(started.details.requestedModel, "mini");
    assert.equal(started.details.model, "gpt-5.4-mini");
    assert.match(started.details.modelNote, /model alias mini -> model gpt-5\.4-mini/);
  } finally {
    await harness.close();
  }
});

test("peer_ask returns and displays the outgoing prompt", async () => {
  const harness = await loadExtensionHarness("codex-cli");
  try {
    const started = await harness.execute("peer_start", { prompt: "You are a brief worker." });
    const peerName = started.details.peerName;
    let listed = await harness.execute("peer_list", {});
    for (let i = 0; i < 60 && ["busy", "starting"].includes(listed.details.peers[0]?.state); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      listed = await harness.execute("peer_list", {});
    }
    assert.equal(["busy", "starting"].includes(listed.details.peers[0]?.state), false, "peer should become idle before peer_ask");

    const outgoing = "Reply with exactly: peer-visible-prompt";

    const before = harness.sentMessages.length;
    const noticeBefore = harness.notifications.length;
    const asked = await harness.execute("peer_ask", { name: peerName, message: outgoing });
    const toolText = String(asked.content?.[0]?.text ?? "");
    assert.match(toolText, /Outgoing prompt shown only in operator notification\./);
    assert.match(toolText, /Peer-authored message:\n```text/);
    assert.doesNotMatch(toolText, /sent to peer\n```text/);
    assert.equal(asked.details.message, outgoing);

    const messages = harness.sentMessages.slice(before);
    assert.equal(messages.length, 0);
    const visibleAsk = harness.notifications.slice(noticeBefore).find((entry) => entry.message.includes(`Sent to peer: ${peerName}`));
    assert.ok(visibleAsk, "peer_ask should emit an outgoing prompt notification");
    assert.match(visibleAsk.message, /Reply with exactly: peer-visible-prompt/);
  } finally {
    await harness.close();
  }
});

test("peer_interrupt returns explicit delivery status", async () => {
  const harness = await loadExtensionHarness("codex-cli", { codexDelayMs: 500 });
  try {
    const started = await harness.execute("peer_start", { prompt: "Wait briefly, then reply done." });
    const interrupted = await harness.execute("peer_interrupt", { name: started.details.peerName });
    const toolText = String(interrupted.content?.[0]?.text ?? "");

    assert.match(toolText, /Peer interrupt requested:/);
    assert.match(toolText, /signal delivered yes/);
    assert.match(toolText, /reason signalled/);
    assert.match(toolText, /resulting state/);
    assert.match(toolText, /follow-up send/);
    assert.equal(interrupted.details.interruptDelivered, true);
    assert.equal(interrupted.details.interruptReason, "signalled");
    assert.equal(interrupted.details.signal, "SIGINT");
    assert.equal(["busy", "interrupted"].includes(interrupted.details.peerState), true);
    assert.equal(typeof interrupted.details.canSendImmediately, "boolean");
  } finally {
    await harness.close();
  }
});

test("peer tools honor codex default driver through extension execute handlers", async () => {
  const harness = await loadExtensionHarness("codex-cli", { codexDelayMs: 150 });
  try {
    const began = Date.now();
    const started = await harness.execute("peer_start", { prompt: "Review auth flow and reply briefly." });
    assert.ok(Date.now() - began < 140, "peer_start tool should not wait for peer idle");
    assert.equal(started.details.driver, "codex-cli");
    assert.equal(started.details.cwd, process.cwd());

    let listed = await harness.execute("peer_list", {});
    assert.equal(listed.details.peers.length, 1);
    assert.equal(listed.details.peers[0].driver, "codex-cli");

    for (let i = 0; i < 60 && ["busy", "starting"].includes(listed.details.peers[0]?.state); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      listed = await harness.execute("peer_list", {});
    }
    assert.equal(["busy", "starting"].includes(listed.details.peers[0]?.state), false, "peer should become idle before peer_ask");

    const history = await harness.execute("peer_history", { name: started.details.peerName });
    assert.equal(history.details.driver, "codex-cli");

    const asked = await harness.execute("peer_ask", {
      name: started.details.peerName,
      message: "Reply with exactly: peer-ok",
    });
    assert.equal(asked.details.driver, "codex-cli");
    assert.match(asked.details.reply, /^peer:/);

    const stopped = await harness.execute("peer_stop", { name: started.details.peerName });
    assert.equal(stopped.details.driver, "codex-cli");
    assert.equal(stopped.details.state, "stopped");
  } finally {
    await harness.close();
  }
});

test("peer_list discovers managed peers created through shared pi-ca-leash API without restart", async () => {
  const harness = await loadExtensionHarness("codex-cli");
  try {
    await harness.execute("peer_list", {});

    const runtime = new ClaudeCodeRuntime({
      storageDir: piCaLeashRuntimeStorageDir(harness.cwd),
      defaultDriver: "codex-cli",
    });
    const managed = new PiCaLeashManagedPeerApi({
      cwd: harness.cwd,
      runtime,
      defaultDriver: "codex-cli",
      pollIntervalMs: 5,
      askTimeoutMs: 2_000,
    });

    await managed.launchPeer({
      name: "castra-worker",
      prompt: "You are a brief worker.",
      model: "gpt-5.3-codex",
      metadata: { owner: "castra", persona: "atlas" },
    });

    const listed = await harness.execute("peer_list", {});
    const peer = listed.details.peers.find((entry: any) => entry.name === "castra-worker");
    assert.ok(peer, "expected externally managed peer to appear in peer_list");
    assert.equal(peer.kind, "managed");
    assert.deepEqual(peer.metadata, { owner: "castra", persona: "atlas" });

    await managed.stop("castra-worker");
  } finally {
    await harness.close();
  }
});

test("peer_stop can bulk-stop all peers only with explicit confirmation", async () => {
  const harness = await loadExtensionHarness("codex-cli");
  try {
    await harness.execute("peer_start", { prompt: "Review auth flow and reply briefly." });
    await harness.execute("peer_start", { name: "tester", prompt: "Verify login flow and reply briefly." });

    await assert.rejects(
      harness.execute("peer_stop", { all: true }),
      /confirmAll=true/,
    );

    const stopped = await harness.execute("peer_stop", { all: true, confirmAll: true });
    assert.equal(stopped.details.count, 2);
    assert.equal(stopped.details.stoppedPeers.length, 2);

    const listed = await harness.execute("peer_list", {});
    assert.equal(listed.details.peers.length, 0);
  } finally {
    await harness.close();
  }
});

test("subagent tools honor codex extension default when driver omitted", async () => {
  const harness = await loadExtensionHarness("codex-cli", { advanced: true });
  try {
    const started = await harness.execute("subagent_run", {
      task: "Reply with exactly: subagent-ok",
      model: "o4-mini",
    });
    assert.equal(started.details.driver, "codex-cli");
    assert.equal(started.details.state, "completed");

    const listed = await harness.execute("subagent_list", {});
    assert.equal(listed.details.runs.length, 1);
    assert.equal(listed.details.runs[0].driver, "codex-cli");

    const status = await harness.execute("subagent_status", { runId: started.details.runId.slice(0, 8) });
    assert.equal(status.details.driver, "codex-cli");
    assert.equal(status.details.state, "completed");
    assert.equal(status.details.runId, started.details.runId);
  } finally {
    await harness.close();
  }
});

test("subagent tools thread explicit codex driver even when extension default stays claude", async () => {
  const harness = await loadExtensionHarness("claude-sdk", { advanced: true });
  try {
    const started = await harness.execute("subagent_run", {
      task: "Reply with exactly: subagent-ok",
      driver: "codex-cli",
      model: "o4-mini",
    });
    assert.equal(started.details.driver, "codex-cli");
    assert.equal(started.details.state, "completed");

    const listed = await harness.execute("subagent_list", {});
    assert.equal(listed.details.runs.length, 1);
    assert.equal(listed.details.runs[0].driver, "codex-cli");

    const status = await harness.execute("subagent_status", { runId: started.details.runId });
    assert.equal(status.details.driver, "codex-cli");
    assert.equal(status.details.state, "completed");
  } finally {
    await harness.close();
  }
});

test("team tools honor codex extension default when driver omitted", async () => {
  const harness = await loadExtensionHarness("codex-cli", { advanced: true });
  try {
    const spawned = await harness.execute("team_spawn", {
      name: "worker",
      prompt: "You are teammate. Reply briefly.",
    });
    assert.equal(spawned.details.driver, "codex-cli");

    const task = await harness.execute("team_task", {
      name: "worker",
      title: "Investigate",
      details: "Look at logs",
    });
    assert.equal(task.details.teammate.driver, "codex-cli");
    assert.equal(task.details.task.state, "in_progress");

    const message = await harness.execute("team_message", {
      name: "worker",
      message: "Need update",
    });
    assert.equal(message.details.teammate.driver, "codex-cli");
    assert.match(message.details.reply, /^teammate:/);

    const listed = await harness.execute("team_list", {});
    assert.equal(listed.details.teammates.length, 1);
    assert.equal(listed.details.teammates[0].driver, "codex-cli");

    const stopped = await harness.execute("team_stop", { name: "worker" });
    assert.equal(stopped.details.driver, "codex-cli");
    assert.equal(stopped.details.state, "stopped");
  } finally {
    await harness.close();
  }
});

test("team tools thread and preserve explicit codex driver through extension execute handlers", async () => {
  const harness = await loadExtensionHarness("claude-sdk", { advanced: true });
  try {
    const spawned = await harness.execute("team_spawn", {
      name: "worker",
      prompt: "You are teammate. Reply briefly.",
      driver: "codex-cli",
    });
    assert.equal(spawned.details.driver, "codex-cli");

    const task = await harness.execute("team_task", {
      name: "worker",
      title: "Investigate",
      details: "Look at logs",
    });
    assert.equal(task.details.teammate.driver, "codex-cli");
    assert.equal(task.details.task.state, "in_progress");

    const message = await harness.execute("team_message", {
      name: "worker",
      message: "Need update",
    });
    assert.equal(message.details.teammate.driver, "codex-cli");
    assert.match(message.details.reply, /^teammate:/);

    const listed = await harness.execute("team_list", {});
    assert.equal(listed.details.teammates.length, 1);
    assert.equal(listed.details.teammates[0].driver, "codex-cli");

    const stopped = await harness.execute("team_stop", { name: "worker" });
    assert.equal(stopped.details.driver, "codex-cli");
    assert.equal(stopped.details.state, "stopped");
  } finally {
    await harness.close();
  }
});
