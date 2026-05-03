import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ADVANCED_COMMANDS_ENV, LEGACY_COMMANDS_ENV } from "./command-visibility.ts";

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
  const dir = await mkdtemp(join(tmpdir(), "pi-ca-leash-codex-command-stub-"));
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

async function loadCommandHarness(options: { defaultDriver: "claude-sdk" | "codex-cli"; advanced?: boolean; legacy?: boolean; codexDelayMs?: number; noSession?: boolean }) {
  await ensurePiTuiStub();
  const codexExecutable = await createCodexStub(options.codexDelayMs ?? 0);
  const tempCwd = await mkdtemp(join(tmpdir(), "pi-ca-leash-extension-commands-"));
  const previousCwd = process.cwd();
  const previousDefaultDriver = process.env.PI_CLAUDE_RUNTIME_DRIVER;
  const previousCodexExecutable = process.env.CODEX_CLI_EXECUTABLE;
  const previousAdvanced = process.env[ADVANCED_COMMANDS_ENV];
  const previousLegacy = process.env[LEGACY_COMMANDS_ENV];
  const previousArgv = [...process.argv];

  process.env.PI_CLAUDE_RUNTIME_DRIVER = options.defaultDriver;
  process.env.CODEX_CLI_EXECUTABLE = codexExecutable;
  process.env[ADVANCED_COMMANDS_ENV] = options.advanced ? "1" : "0";
  process.env[LEGACY_COMMANDS_ENV] = options.legacy ? "1" : "0";
  if (options.noSession && !process.argv.includes("--no-session")) {
    process.argv.push("--no-session");
  }
  process.chdir(tempCwd);

  const commands = new Map<string, FakeCommand>();
  const renderers = new Map<string, (...args: any[]) => any>();
  const lifecycle = new Map<string, (...args: any[]) => any>();
  const sentMessages: Array<{ message: any; options: unknown }> = [];
  const statusUpdates: Array<{ name: string; value: unknown }> = [];
  const widgets = new Map<string, unknown>();
  const ctx = {
    ui: {
      setStatus(name: string, value: unknown) { statusUpdates.push({ name, value }); },
      setWidget(name: string, widget: unknown) { widgets.set(name, widget); },
      notify() {},
    },
  };

  const pi = {
    registerTool() {},
    registerCommand(name: string, config: FakeCommand) {
      commands.set(name, config);
    },
    registerMessageRenderer(name: string, renderer: (...args: any[]) => any) {
      renderers.set(name, renderer);
    },
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
    renderers,
    sentMessages,
    statusUpdates,
    widgets,
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
      if (previousLegacy == null) delete process.env[LEGACY_COMMANDS_ENV];
      else process.env[LEGACY_COMMANDS_ENV] = previousLegacy;
      process.argv.splice(0, process.argv.length, ...previousArgv);
    },
  };
}

function latestBody(entries: Array<{ message: any }>): string {
  assert.ok(entries.length > 0, "Expected command messages");
  return String(entries.at(-1)?.message?.content ?? "");
}

function messageBody(entries: Array<{ message: any }>, title: RegExp): string {
  const entry = entries.find((item) => title.test(String(item.message?.details?.title ?? "")));
  assert.ok(entry, `Expected message titled ${title}`);
  return String(entry.message?.content ?? "");
}

test("/peer is the only public slash command by default", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli" });
  try {
    assert.equal(harness.commands.has("peer"), true);
    assert.equal([...harness.commands.keys()].some((name) => name.startsWith("claude-")), false);
    assert.equal(harness.widgets.has("peer-dashboard"), false);
    assert.equal(harness.statusUpdates.length, 0);
  } finally {
    await harness.close();
  }
});

test("/peer help stays passive while /peer init activates and shows guide", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli" });
  try {
    const helpMessages = await harness.run("peer", "help");
    assert.match(latestBody(helpMessages), /\/peer init/);
    assert.match(latestBody(helpMessages), /pi-ca-leash v\d+\.\d+\.\d+/);
    assert.match(latestBody(helpMessages), /\/peer about/);
    assert.equal(harness.widgets.has("peer-dashboard"), false);

    const aboutMessages = await harness.run("peer", "about");
    assert.match(latestBody(aboutMessages), /version \d+\.\d+\.\d+/);
    assert.match(latestBody(aboutMessages), /default driver codex-cli/);
    assert.equal(harness.widgets.has("peer-dashboard"), false);

    const initMessages = await harness.run("peer", "init");
    assert.match(String(initMessages.at(0)?.message?.details?.title ?? ""), /Agent orchestration guide/);
    assert.equal(initMessages.at(0)?.message?.details?.surface, "agent");
    assert.match(String(initMessages.at(1)?.message?.details?.title ?? ""), /Peer mode active/);
    assert.equal(initMessages.at(1)?.message?.details?.surface, "custom");

    const userHelp = messageBody(initMessages, /Peer mode active/);
    assert.match(userHelp, /Common commands:/);
    assert.match(userHelp, /\/peer start <prompt>/);
    assert.match(userHelp, /\/peer help/);

    const agentGuide = messageBody(initMessages, /Agent orchestration guide/);
    assert.match(agentGuide, /How to work with pi-ca-leash:/);
    assert.match(agentGuide, /orchestrator in the driver's seat/);
    assert.match(agentGuide, /multiple specialized peers at the same time/);
    assert.match(agentGuide, /Use `peer_history` like a human scrolling back/);
    assert.match(agentGuide, /extension_log/);
    assert.equal(harness.widgets.has("peer-dashboard"), true);
  } finally {
    await harness.close();
  }
});

test("first actionable /peer command activates and shows guide once", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli" });
  try {
    const firstMessages = await harness.run("peer", "models codex-cli");
    assert.match(String(firstMessages.at(0)?.message?.details?.title ?? ""), /Agent orchestration guide/);
    assert.equal(firstMessages.at(0)?.message?.details?.surface, "agent");
    assert.match(String(firstMessages.at(1)?.message?.details?.title ?? ""), /Peer mode active/);
    assert.equal(firstMessages.at(1)?.message?.details?.surface, "custom");
    assert.match(messageBody(firstMessages, /Peer mode active/), /\/peer help/);
    assert.match(messageBody(firstMessages, /Agent orchestration guide/), /How to work with pi-ca-leash:/);
    assert.match(latestBody(firstMessages), /codex-cli models/);
    assert.equal(harness.widgets.has("peer-dashboard"), true);

    const nextMessages = await harness.run("peer", "list");
    const nextText = nextMessages.map((entry) => String(entry.message.content ?? "")).join("\n");
    assert.doesNotMatch(nextText, /How to work with pi-ca-leash:/);
    assert.doesNotMatch(nextText, /Common commands:/);
  } finally {
    await harness.close();
  }
});

test("compact peer widget renders summary and column labels", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli", codexDelayMs: 150 });
  try {
    await harness.run("peer", "start reviewer | Review auth flow and reply briefly.");
    const widget = harness.widgets.get("peer-dashboard") as ((tui: unknown, theme: { fg: (color: string, text: string) => string }) => { render(width: number): string[] }) | undefined;
    assert.ok(widget, "Expected peer dashboard widget");

    const rendered = widget(undefined, { fg: (_color: string, text: string) => text });
    const lines = rendered.render(88);
    assert.match(lines[0] ?? "", /Peers 1 peer/);
    assert.match(lines[0] ?? "", /● (active|idle|warning)/);
    assert.match(lines.join("\n"), /peer\s+state\s+(driver\s+)?(model\s+)?updated\s+activity/);
    assert.match(lines.join("\n"), /reviewer/);

    const narrowLines = rendered.render(40);
    assert.match(narrowLines.join("\n"), /peer\s+state\s+(updated\s+)?activity/);
    assert.doesNotMatch(narrowLines.join("\n"), /\b(driver|model)\b/);
  } finally {
    await harness.close();
  }
});

test("compact peer widget adapts widths and hides redundant driver column", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli", codexDelayMs: 150 });
  try {
    await harness.run("peer", "start opsx-sonnet-reviewer | Review auth flow briefly. | codex-cli | claude-sonnet-4-6");
    await harness.run("peer", "start opsx-haiku-reviewer | Summarize docs briefly. | codex-cli | claude-haiku-4-5");

    const widget = harness.widgets.get("peer-dashboard") as ((tui: unknown, theme: { fg: (color: string, text: string) => string }) => { render(width: number): string[] }) | undefined;
    assert.ok(widget, "Expected peer dashboard widget");

    const rendered = widget(undefined, { fg: (_color: string, text: string) => text });
    const lines = rendered.render(78).join("\n");
    assert.doesNotMatch(lines, /\bdriver\b/);
    assert.match(lines, /peer\s+state\s+model\s+updated\s+activity/);
    assert.match(lines, /opsx-sonnet-reviewer/);
    assert.match(lines, /opsx-haiku-reviewer/);
    assert.match(lines, /\d{2}:\d{2}/);
  } finally {
    await harness.close();
  }
});

test("/peer commands stay renderless in --no-session smoke mode", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli", noSession: true });
  try {
    const messages = await harness.run("peer", "models codex-cli");
    assert.match(latestBody(messages), /codex-cli models/);
    assert.equal(harness.widgets.has("peer-dashboard"), false);
    assert.equal(harness.statusUpdates.length, 0);
  } finally {
    await harness.close();
  }
});

test("legacy env flag restores old claude slash commands", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli", legacy: true });
  try {
    assert.equal(harness.commands.has("peer"), true);
    assert.equal(harness.commands.has("claude-dashboard"), true);
    assert.equal(harness.commands.has("claude-peer-start"), true);
    assert.equal(harness.commands.has("claude-peer-stop-all"), true);
    assert.equal(harness.commands.has("claude-subagent-run"), false);
  } finally {
    await harness.close();
  }
});

test("legacy plus advanced env restores old internal claude commands", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli", legacy: true, advanced: true });
  try {
    assert.equal(harness.commands.has("claude-subagent-run"), true);
    assert.equal(harness.commands.has("claude-team-spawn"), true);
    assert.equal(harness.commands.has("claude-runtime-list"), true);
  } finally {
    await harness.close();
  }
});

test("renderer, status, and widget use peer/pi-ca-leash branding", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli" });
  try {
    assert.equal(harness.renderers.has("peer-command-result"), true);
    assert.equal(harness.renderers.has("claude-command-result"), false);

    const messages = await harness.run("peer", "list");
    assert.equal(String(messages.at(-1)?.message?.customType), "peer-command-result");
    assert.equal(messages.at(-1)?.message?.details?.surface, "custom");

    const renderer = harness.renderers.get("peer-command-result")!;
    const listBox = renderer(messages.at(-1)?.message, { expanded: false }, {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
    });
    const renderedText = String(listBox.children?.[0]?.text ?? "");
    assert.match(renderedText, /^\[peer\]/);
    assert.doesNotMatch(renderedText, /\[cca\]|pi-claude-code-agent/);

    const initMessages = await harness.run("peer", "init");
    const guideMessage = initMessages.find((entry) => String(entry.message?.details?.title ?? "") === "Agent orchestration guide")?.message;
    assert.equal(guideMessage?.details?.surface, "agent");
    const guideBox = renderer(guideMessage, { expanded: false }, {
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
    });
    assert.match(String(guideBox.children?.[0]?.text ?? ""), /^\[peer\/agent\]/);

    const startMessages = await harness.run("peer", "start reviewer | Review auth flow and reply briefly.");
    assert.equal(startMessages.at(-1)?.message?.details?.surface, "tool");

    assert.equal(harness.statusUpdates.at(-1)?.name, "pi-ca-leash");
    assert.equal(harness.widgets.has("peer-dashboard"), true);
    assert.equal(harness.widgets.has("claude-dashboard"), false);
  } finally {
    await harness.close();
  }
});

test("/peer start honors codex default and explicit driver forms", async () => {
  const defaultHarness = await loadCommandHarness({ defaultDriver: "codex-cli", codexDelayMs: 150 });
  try {
    const started = Date.now();
    const startMessages = await defaultHarness.run("peer", "start" + " " + "Review auth flow and reply briefly.");
    assert.ok(Date.now() - started < 140, "/peer start should not wait for peer idle");
    assert.match(latestBody(startMessages), /driver codex-cli/);

    const listMessages = await defaultHarness.run("peer", "list");
    assert.match(latestBody(listMessages), /codex-cli/);
  } finally {
    await defaultHarness.close();
  }

  const overrideHarness = await loadCommandHarness({ defaultDriver: "claude-sdk" });
  try {
    const startMessages = await overrideHarness.run("peer", "start" + " " + "reviewer | Review auth flow and reply briefly. | codex-cli | gpt-5.4-mini");
    assert.match(latestBody(startMessages), /driver codex-cli/);
    assert.match(latestBody(startMessages), /gpt-5\.4-mini/);

    const listMessages = await overrideHarness.run("peer", "list");
    assert.match(latestBody(listMessages), /codex-cli/);
  } finally {
    await overrideHarness.close();
  }
});

test("/peer models lists bundled runtime model catalog", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli" });
  try {
    const allMessages = await harness.run("peer", "models");
    assert.match(latestBody(allMessages), /claude-sdk models/);
    assert.match(latestBody(allMessages), /codex-cli models/);

    const codexMessages = await harness.run("peer", "models codex-cli");
    assert.match(latestBody(codexMessages), /default gpt-5\.5/);
    assert.match(latestBody(codexMessages), /gpt-5\.4-mini/);
    assert.doesNotMatch(latestBody(codexMessages), /claude-opus-4-7/);
  } finally {
    await harness.close();
  }
});

test("legacy advanced subagent commands honor codex default and explicit driver forms", async () => {
  const defaultHarness = await loadCommandHarness({ defaultDriver: "codex-cli", advanced: true, legacy: true });
  try {
    const runMessages = await defaultHarness.run("claude-subagent-run", "Reply with exactly: subagent-ok");
    assert.match(latestBody(runMessages), /driver codex-cli/);

    const listMessages = await defaultHarness.run("claude-subagent-list", "");
    assert.match(latestBody(listMessages), /codex-cli/);
  } finally {
    await defaultHarness.close();
  }

  const overrideHarness = await loadCommandHarness({ defaultDriver: "claude-sdk", advanced: true, legacy: true });
  try {
    const runMessages = await overrideHarness.run("claude-subagent-run", "codex-cli | Reply with exactly: subagent-ok");
    assert.match(latestBody(runMessages), /driver codex-cli/);

    const listMessages = await overrideHarness.run("claude-subagent-list", "");
    assert.match(latestBody(listMessages), /codex-cli/);
  } finally {
    await overrideHarness.close();
  }
});

test("legacy advanced team commands honor codex default and explicit driver forms", async () => {
  const defaultHarness = await loadCommandHarness({ defaultDriver: "codex-cli", advanced: true, legacy: true });
  try {
    const spawnMessages = await defaultHarness.run("claude-team-spawn", "worker | You are teammate. Reply briefly.");
    assert.match(latestBody(spawnMessages), /driver codex-cli/);

    const listMessages = await defaultHarness.run("claude-team-list", "");
    assert.match(latestBody(listMessages), /codex-cli/);
  } finally {
    await defaultHarness.close();
  }

  const overrideHarness = await loadCommandHarness({ defaultDriver: "claude-sdk", advanced: true, legacy: true });
  try {
    const spawnMessages = await overrideHarness.run("claude-team-spawn", "worker | You are teammate. Reply briefly. | codex-cli");
    assert.match(latestBody(spawnMessages), /driver codex-cli/);

    const listMessages = await overrideHarness.run("claude-team-list", "");
    assert.match(latestBody(listMessages), /codex-cli/);
  } finally {
    await overrideHarness.close();
  }
});

test("/peer dispatcher covers ask, send, history, interrupt, and stop", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli" });
  try {
    await harness.run("peer", "start worker | You are a brief worker.");

    let listMessages = await harness.run("peer", "list");
    for (let i = 0; i < 60 && /\b(busy|starting)\b/.test(latestBody(listMessages)); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      listMessages = await harness.run("peer", "list");
    }

    const askMessages = await harness.run("peer", "ask worker | Reply with exactly: peer-ok");
    assert.match(String(askMessages.at(-1)?.message?.details?.title ?? ""), /Peer reply: worker/);

    const historyMessages = await harness.run("peer", "history worker 0 20");
    assert.match(latestBody(historyMessages), /cursor .* of /);

    const sendMessages = await harness.run("peer", "send worker | Keep working and report back.");
    assert.match(latestBody(sendMessages), /delivery delivered_and_running/);

    const interruptMessages = await harness.run("peer", "interrupt worker");
    assert.match(String(interruptMessages.at(-1)?.message?.details?.title ?? ""), /Peer interrupted: worker/);

    const stopMessages = await harness.run("peer", "stop worker");
    assert.match(String(stopMessages.at(-1)?.message?.details?.title ?? ""), /Peer stopped: worker/);
  } finally {
    await harness.close();
  }
});

test("/peer stop --all requires confirmation and clears peer list", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli" });
  try {
    await harness.run("peer", "start" + " " + "Review auth flow and reply briefly.");
    await harness.run("peer", "start" + " " + "tester | Verify login flow | codex-cli");

    const usageMessages = await harness.run("peer", "stop --all");
    assert.match(latestBody(usageMessages), /\/peer stop --all --confirm/);

    const stopMessages = await harness.run("peer", "stop --all --confirm");
    assert.match(latestBody(stopMessages), /reviewer|tester/);

    const listMessages = await harness.run("peer", "list");
    assert.match(latestBody(listMessages), /No peers yet\./);
  } finally {
    await harness.close();
  }
});
