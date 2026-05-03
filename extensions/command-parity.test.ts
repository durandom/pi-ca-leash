import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ADVANCED_COMMANDS_ENV } from "./command-visibility.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const extensionModuleUrl = pathToFileURL(join(__dirname, "index.ts")).href;

async function ensurePiTuiStub(): Promise<void> {
  const dir = join(repoRoot, "node_modules", "@mariozechner", "pi-tui");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), `${JSON.stringify({
    name: "@mariozechner/pi-tui",
    type: "module",
    exports: "./index.js",
  }, null, 2)}\n`, "utf8");
  await writeFile(join(dir, "index.js"), [
    "export class Box { constructor() {} addChild() {} }",
    "export class Text { constructor() {} }",
    "export function truncateToWidth(text, width, suffix = '…') {",
    "  const value = String(text);",
    "  return value.length <= width ? value : value.slice(0, Math.max(0, width - suffix.length)) + suffix;",
    "}",
    "export function visibleWidth(text) { return String(text).length; }",
    "",
  ].join("\n"), "utf8");
}

async function createCodexStub(delayMs = 0): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cca-codex-command-stub-"));
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
    "  if (text.includes('[intercom kind=ask from=pi-user]')) {",
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

interface FakeCommand {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

async function loadCommandHarness(options: { defaultDriver: "claude-sdk" | "codex-cli"; advanced?: boolean; codexDelayMs?: number }) {
  await ensurePiTuiStub();
  const codexExecutable = await createCodexStub(options.codexDelayMs ?? 0);
  const tempCwd = await mkdtemp(join(tmpdir(), "cca-extension-commands-"));
  const previousCwd = process.cwd();
  const previousDefaultDriver = process.env.PI_CLAUDE_RUNTIME_DRIVER;
  const previousCodexExecutable = process.env.CODEX_CLI_EXECUTABLE;
  const previousAdvanced = process.env[ADVANCED_COMMANDS_ENV];

  process.env.PI_CLAUDE_RUNTIME_DRIVER = options.defaultDriver;
  process.env.CODEX_CLI_EXECUTABLE = codexExecutable;
  process.env[ADVANCED_COMMANDS_ENV] = options.advanced ? "1" : "0";
  process.chdir(tempCwd);

  const commands = new Map<string, FakeCommand>();
  const lifecycle = new Map<string, (...args: any[]) => any>();
  const sentMessages: Array<{ message: any; options: unknown }> = [];
  const ctx = {
    ui: {
      setStatus() {},
      setWidget() {},
      notify() {},
    },
  };

  const pi = {
    registerTool() {},
    registerCommand(name: string, config: FakeCommand) {
      commands.set(name, config);
    },
    registerMessageRenderer() {},
    on(event: string, handler: (...args: any[]) => any) {
      lifecycle.set(event, handler);
    },
    sendMessage(message: any, options: unknown) {
      sentMessages.push({ message, options });
    },
    sendUserMessage() {},
  };

  const module = await import(extensionModuleUrl);
  await module.default(pi as never);

  return {
    commands,
    sentMessages,
    async run(name: string, args: string) {
      const command = commands.get(name);
      assert.ok(command, `Missing command ${name}`);
      const before = sentMessages.length;
      await command.handler(args, ctx);
      return sentMessages.slice(before);
    },
    async close() {
      await lifecycle.get("session_shutdown")?.();
      process.chdir(previousCwd);
      if (previousDefaultDriver == null) delete process.env.PI_CLAUDE_RUNTIME_DRIVER;
      else process.env.PI_CLAUDE_RUNTIME_DRIVER = previousDefaultDriver;
      if (previousCodexExecutable == null) delete process.env.CODEX_CLI_EXECUTABLE;
      else process.env.CODEX_CLI_EXECUTABLE = previousCodexExecutable;
      if (previousAdvanced == null) delete process.env[ADVANCED_COMMANDS_ENV];
      else process.env[ADVANCED_COMMANDS_ENV] = previousAdvanced;
    },
  };
}

function latestBody(entries: Array<{ message: any }>): string {
  assert.ok(entries.length > 0, "Expected command messages");
  return String(entries.at(-1)?.message?.content ?? "");
}

test("claude-peer-start honors codex default and explicit driver forms", async () => {
  const defaultHarness = await loadCommandHarness({ defaultDriver: "codex-cli", codexDelayMs: 150 });
  try {
    const started = Date.now();
    const startMessages = await defaultHarness.run("claude-peer-start", "Review auth flow and reply briefly.");
    assert.ok(Date.now() - started < 140, "claude-peer-start should not wait for peer idle");
    assert.match(latestBody(startMessages), /driver codex-cli/);

    const listMessages = await defaultHarness.run("claude-peer-list", "");
    assert.match(latestBody(listMessages), /codex-cli/);
  } finally {
    await defaultHarness.close();
  }

  const overrideHarness = await loadCommandHarness({ defaultDriver: "claude-sdk" });
  try {
    const startMessages = await overrideHarness.run("claude-peer-start", "reviewer | Review auth flow and reply briefly. | codex-cli");
    assert.match(latestBody(startMessages), /driver codex-cli/);

    const listMessages = await overrideHarness.run("claude-peer-list", "");
    assert.match(latestBody(listMessages), /codex-cli/);
  } finally {
    await overrideHarness.close();
  }
});

test("advanced subagent commands honor codex default and explicit driver forms", async () => {
  const defaultHarness = await loadCommandHarness({ defaultDriver: "codex-cli", advanced: true });
  try {
    const runMessages = await defaultHarness.run("claude-subagent-run", "Reply with exactly: subagent-ok");
    assert.match(latestBody(runMessages), /driver codex-cli/);

    const listMessages = await defaultHarness.run("claude-subagent-list", "");
    assert.match(latestBody(listMessages), /codex-cli/);
  } finally {
    await defaultHarness.close();
  }

  const overrideHarness = await loadCommandHarness({ defaultDriver: "claude-sdk", advanced: true });
  try {
    const runMessages = await overrideHarness.run("claude-subagent-run", "codex-cli | Reply with exactly: subagent-ok");
    assert.match(latestBody(runMessages), /driver codex-cli/);

    const listMessages = await overrideHarness.run("claude-subagent-list", "");
    assert.match(latestBody(listMessages), /codex-cli/);
  } finally {
    await overrideHarness.close();
  }
});

test("advanced team commands honor codex default and explicit driver forms", async () => {
  const defaultHarness = await loadCommandHarness({ defaultDriver: "codex-cli", advanced: true });
  try {
    const spawnMessages = await defaultHarness.run("claude-team-spawn", "worker | You are teammate. Reply briefly.");
    assert.match(latestBody(spawnMessages), /driver codex-cli/);

    const listMessages = await defaultHarness.run("claude-team-list", "");
    assert.match(latestBody(listMessages), /codex-cli/);
  } finally {
    await defaultHarness.close();
  }

  const overrideHarness = await loadCommandHarness({ defaultDriver: "claude-sdk", advanced: true });
  try {
    const spawnMessages = await overrideHarness.run("claude-team-spawn", "worker | You are teammate. Reply briefly. | codex-cli");
    assert.match(latestBody(spawnMessages), /driver codex-cli/);

    const listMessages = await overrideHarness.run("claude-team-list", "");
    assert.match(latestBody(listMessages), /codex-cli/);
  } finally {
    await overrideHarness.close();
  }
});

test("claude-peer-stop-all requires confirmation and clears crowded peer list", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli" });
  try {
    await harness.run("claude-peer-start", "Review auth flow and reply briefly.");
    await harness.run("claude-peer-start", "tester | Verify login flow | codex-cli");

    const usageMessages = await harness.run("claude-peer-stop-all", "");
    assert.match(latestBody(usageMessages), /\/claude-peer-stop-all --yes/);

    const stopMessages = await harness.run("claude-peer-stop-all", "--yes");
    assert.match(latestBody(stopMessages), /reviewer|tester/);

    const listMessages = await harness.run("claude-peer-list", "");
    assert.match(latestBody(listMessages), /No peers yet\./);
  } finally {
    await harness.close();
  }
});
