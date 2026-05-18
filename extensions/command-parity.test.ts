import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ClaudeCodeRuntime } from "../packages/runtime/src/internal.ts";
import { PiCaLeashManagedPeerApi, piCaLeashRuntimeStorageDir } from "../packages/intercom-bridge/src/index.ts";
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
  const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
  const statusUpdates: Array<{ name: string; value: unknown }> = [];
  const widgets = new Map<string, unknown>();
  const ctx = {
    ui: {
      setStatus(name: string, value: unknown) { statusUpdates.push({ name, value }); },
      setWidget(name: string, widget: unknown) { widgets.set(name, widget); },
      notify(message: string, type?: "info" | "warning" | "error") { notifications.push({ message, type }); },
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
    notifications,
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

function latestNotification(entries: Array<{ message: string }>): string {
  assert.ok(entries.length > 0, "Expected notifications");
  return entries.at(-1)?.message ?? "";
}

function notificationMatching(entries: Array<{ message: string }>, pattern: RegExp): string {
  const entry = entries.find((item) => pattern.test(item.message));
  assert.ok(entry, `Expected notification matching ${pattern}`);
  return entry.message;
}

test("/peer is the only public slash command by default", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli" });
  try {
    assert.equal(harness.commands.has("peer"), true);
    assert.equal([...harness.commands.keys()].some((name) => name.startsWith("claude-")), false);
    assert.equal(harness.widgets.has("peer-dashboard"), false);
    assert.equal(harness.statusUpdates.length, 0);
    assert.equal(harness.notifications.length, 0);
  } finally {
    await harness.close();
  }
});

test("/peer help stays passive while /peer init activates and shows guide", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli" });
  try {
    const helpBefore = harness.notifications.length;
    const helpMessages = await harness.run("peer", "help");
    assert.equal(helpMessages.length, 0);
    const helpNotice = latestNotification(harness.notifications.slice(helpBefore));
    assert.match(helpNotice, /\/peer init/);
    assert.match(helpNotice, /pi-ca-leash v\d+\.\d+\.\d+/);
    assert.match(helpNotice, /\/peer about/);
    assert.equal(harness.widgets.has("peer-dashboard"), false);

    const aboutBefore = harness.notifications.length;
    const aboutMessages = await harness.run("peer", "about");
    assert.equal(aboutMessages.length, 0);
    const aboutNotice = latestNotification(harness.notifications.slice(aboutBefore));
    assert.match(aboutNotice, /version \d+\.\d+\.\d+/);
    assert.match(aboutNotice, /default driver codex-cli/);
    assert.equal(harness.widgets.has("peer-dashboard"), false);

    const initMessages = await harness.run("peer", "init");
    assert.match(String(initMessages.at(0)?.message?.details?.title ?? ""), /Agent orchestration guide/);
    assert.equal(initMessages.at(0)?.message?.details?.surface, "agent");
    assert.equal(initMessages.length, 1);

    const userHelp = notificationMatching(harness.notifications, /Peer mode is active/);
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
    assert.equal(harness.widgets.has("peer-init-help"), false);
  } finally {
    await harness.close();
  }
});

test("first actionable /peer command activates and shows guide once", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli" });
  try {
    const noticeBefore = harness.notifications.length;
    const firstMessages = await harness.run("peer", "models codex-cli");
    assert.match(String(firstMessages.at(0)?.message?.details?.title ?? ""), /Agent orchestration guide/);
    assert.equal(firstMessages.at(0)?.message?.details?.surface, "agent");
    assert.equal(firstMessages.length, 1);
    const firstNotices = harness.notifications.slice(noticeBefore);
    assert.match(notificationMatching(firstNotices, /Peer mode is active/), /\/peer help/);
    assert.match(messageBody(firstMessages, /Agent orchestration guide/), /How to work with pi-ca-leash:/);
    assert.match(notificationMatching(firstNotices, /Runtime models/), /codex-cli models/);
    assert.equal(harness.widgets.has("peer-dashboard"), true);

    const nextNoticeBefore = harness.notifications.length;
    const nextMessages = await harness.run("peer", "list");
    assert.equal(nextMessages.length, 0);
    const nextText = harness.notifications.slice(nextNoticeBefore).map((entry) => entry.message).join("\n");
    assert.doesNotMatch(nextText, /How to work with pi-ca-leash:/);
    assert.doesNotMatch(nextText, /Common commands:/);
  } finally {
    await harness.close();
  }
});

test("/peer dashboard hide and show clear and restore the widget", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli" });
  try {
    await harness.run("peer", "init");
    assert.notEqual(harness.widgets.get("peer-dashboard"), undefined);

    const hideBefore = harness.notifications.length;
    await harness.run("peer", "dashboard hide");
    assert.equal(harness.widgets.get("peer-dashboard"), undefined);
    assert.match(notificationMatching(harness.notifications.slice(hideBefore), /Peers widget hidden/), /dashboard show/);

    await harness.run("peer", "list");
    assert.equal(harness.widgets.get("peer-dashboard"), undefined);

    const showBefore = harness.notifications.length;
    await harness.run("peer", "show");
    assert.notEqual(harness.widgets.get("peer-dashboard"), undefined);
    assert.match(notificationMatching(harness.notifications.slice(showBefore), /Peers widget restored/), /0 peers/);
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

test("dashboard shows minimal managed-owner badge and advanced dashboard shows full managed metadata", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli" });
  try {
    const runtime = new ClaudeCodeRuntime({
      storageDir: piCaLeashRuntimeStorageDir(process.cwd()),
      defaultDriver: "codex-cli",
    });
    const managed = new PiCaLeashManagedPeerApi({
      cwd: process.cwd(),
      runtime,
      defaultDriver: "codex-cli",
      pollIntervalMs: 5,
      askTimeoutMs: 2_000,
    });

    await managed.launchPeer({
      name: "castra-worker",
      prompt: "You are a brief worker.",
      model: "gpt-5.3-codex",
      metadata: { owner: "castra", persona: "atlas", cycleId: "cycle-1" },
    });

    const noticeBefore = harness.notifications.length;
    await harness.run("peer", "dashboard");
    const dashboardText = notificationMatching(harness.notifications.slice(noticeBefore), /Peer dashboard/);
    assert.match(dashboardText, /castra-worker \[managed:castra\]/);
    assert.doesNotMatch(dashboardText, /\bpersona\b/);
    assert.doesNotMatch(dashboardText, /\bcycle\b/);

    const advancedBefore = harness.notifications.length;
    await harness.run("peer", "dashboard advanced");
    const advancedText = notificationMatching(harness.notifications.slice(advancedBefore), /Peer dashboard · advanced/);
    assert.match(advancedText, /\bkind\b/);
    assert.match(advancedText, /\bowner\b/);
    assert.match(advancedText, /\bpersona\b/);
    assert.match(advancedText, /\bcycle\b/);
    assert.match(advancedText, /castra-worker/);
    assert.match(advancedText, /managed/);
    assert.match(advancedText, /castra/);
    assert.match(advancedText, /atlas/);
    assert.match(advancedText, /cycle-1/);

    await managed.stop("castra-worker");
  } finally {
    await harness.close();
  }
});

test("/peer commands stay renderless in --no-session smoke mode", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli", noSession: true });
  try {
    const noticeBefore = harness.notifications.length;
    const messages = await harness.run("peer", "models codex-cli");
    assert.equal(messages.length, 1);
    assert.equal(messages.at(0)?.message?.details?.surface, "agent");
    assert.match(notificationMatching(harness.notifications.slice(noticeBefore), /Runtime models/), /codex-cli models/);
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

    const renderer = harness.renderers.get("peer-command-result")!;
    const operatorBox = renderer({
      customType: "peer-command-result",
      content: "operator only",
      details: { level: "info", title: "Peer dashboard", surface: "custom", timestamp: Date.now() },
    }, { expanded: false }, {
      fg: (_color: string, text: string) => text,
      bg: (color: string, text: string) => `${color}:${text}`,
    });
    const renderedText = String(operatorBox.children?.[0]?.text ?? "");
    assert.match(renderedText, /^\[peer\]/);
    assert.doesNotMatch(renderedText, /\[cca\]|pi-claude-code-agent/);
    assert.equal(operatorBox.args?.[2]?.("body"), "toolPendingBg:body");

    const initMessages = await harness.run("peer", "init");
    const guideMessage = initMessages.find((entry) => String(entry.message?.details?.title ?? "") === "Agent orchestration guide")?.message;
    assert.equal(guideMessage?.details?.surface, "agent");
    const guideBox = renderer(guideMessage, { expanded: false }, {
      fg: (_color: string, text: string) => text,
      bg: (color: string, text: string) => `${color}:${text}`,
    });
    assert.match(String(guideBox.children?.[0]?.text ?? ""), /^\[peer\/agent\]/);
    assert.equal(guideBox.args?.[2]?.("body"), "toolPendingBg:body");

    const startMessages = await harness.run("peer", "start reviewer | Review auth flow and reply briefly.");
    assert.equal(startMessages.length, 0);
    assert.match(latestNotification(harness.notifications), /Peer started: reviewer/);

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
    assert.equal(startMessages.length, 1);
    assert.equal(startMessages.at(0)?.message?.details?.surface, "agent");
    assert.match(latestNotification(defaultHarness.notifications), /driver codex-cli/);

    const listMessages = await defaultHarness.run("peer", "list");
    assert.equal(listMessages.length, 0);
    assert.match(latestNotification(defaultHarness.notifications), /codex-cli/);
  } finally {
    await defaultHarness.close();
  }

  const overrideHarness = await loadCommandHarness({ defaultDriver: "claude-sdk" });
  try {
    const startMessages = await overrideHarness.run("peer", "start" + " " + "reviewer | Review auth flow and reply briefly. | codex-cli | gpt-5.4-mini");
    assert.equal(startMessages.length, 1);
    assert.equal(startMessages.at(0)?.message?.details?.surface, "agent");
    assert.match(latestNotification(overrideHarness.notifications), /driver codex-cli/);
    assert.match(latestNotification(overrideHarness.notifications), /gpt-5\.4-mini/);

    const listMessages = await overrideHarness.run("peer", "list");
    assert.equal(listMessages.length, 0);
    assert.match(latestNotification(overrideHarness.notifications), /codex-cli/);
  } finally {
    await overrideHarness.close();
  }
});

test("/peer models lists bundled runtime model catalog", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli" });
  try {
    const allNoticeBefore = harness.notifications.length;
    const allMessages = await harness.run("peer", "models");
    assert.equal(allMessages.length, 1);
    const allText = notificationMatching(harness.notifications.slice(allNoticeBefore), /Runtime models/);
    assert.match(allText, /claude-sdk models/);
    assert.match(allText, /codex-cli models/);

    const codexNoticeBefore = harness.notifications.length;
    const codexMessages = await harness.run("peer", "models codex-cli");
    assert.equal(codexMessages.length, 0);
    const codexText = notificationMatching(harness.notifications.slice(codexNoticeBefore), /Runtime models/);
    assert.match(codexText, /default gpt-5\.5/);
    assert.match(codexText, /gpt-5\.4-mini/);
    assert.doesNotMatch(codexText, /claude-opus-4-7/);
  } finally {
    await harness.close();
  }
});

test("legacy advanced subagent commands honor codex default and explicit driver forms", async () => {
  const defaultHarness = await loadCommandHarness({ defaultDriver: "codex-cli", advanced: true, legacy: true });
  try {
    const runMessages = await defaultHarness.run("claude-subagent-run", "Reply with exactly: subagent-ok");
    assert.equal(runMessages.length, 0);
    assert.match(latestNotification(defaultHarness.notifications), /driver codex-cli/);

    const listMessages = await defaultHarness.run("claude-subagent-list", "");
    assert.equal(listMessages.length, 0);
    assert.match(latestNotification(defaultHarness.notifications), /codex-cli/);
  } finally {
    await defaultHarness.close();
  }

  const overrideHarness = await loadCommandHarness({ defaultDriver: "claude-sdk", advanced: true, legacy: true });
  try {
    const runMessages = await overrideHarness.run("claude-subagent-run", "codex-cli | Reply with exactly: subagent-ok");
    assert.equal(runMessages.length, 0);
    assert.match(latestNotification(overrideHarness.notifications), /driver codex-cli/);

    const listMessages = await overrideHarness.run("claude-subagent-list", "");
    assert.equal(listMessages.length, 0);
    assert.match(latestNotification(overrideHarness.notifications), /codex-cli/);
  } finally {
    await overrideHarness.close();
  }
});

test("legacy advanced team commands honor codex default and explicit driver forms", async () => {
  const defaultHarness = await loadCommandHarness({ defaultDriver: "codex-cli", advanced: true, legacy: true });
  try {
    const spawnMessages = await defaultHarness.run("claude-team-spawn", "worker | You are teammate. Reply briefly.");
    assert.equal(spawnMessages.length, 0);
    assert.match(latestNotification(defaultHarness.notifications), /driver codex-cli/);

    const listMessages = await defaultHarness.run("claude-team-list", "");
    assert.equal(listMessages.length, 0);
    assert.match(latestNotification(defaultHarness.notifications), /codex-cli/);
  } finally {
    await defaultHarness.close();
  }

  const overrideHarness = await loadCommandHarness({ defaultDriver: "claude-sdk", advanced: true, legacy: true });
  try {
    const spawnMessages = await overrideHarness.run("claude-team-spawn", "worker | You are teammate. Reply briefly. | codex-cli");
    assert.equal(spawnMessages.length, 0);
    assert.match(latestNotification(overrideHarness.notifications), /driver codex-cli/);

    const listMessages = await overrideHarness.run("claude-team-list", "");
    assert.equal(listMessages.length, 0);
    assert.match(latestNotification(overrideHarness.notifications), /codex-cli/);
  } finally {
    await overrideHarness.close();
  }
});

test("/peer dispatcher covers ask, send, history, interrupt, and stop", async () => {
  const harness = await loadCommandHarness({ defaultDriver: "codex-cli" });
  try {
    await harness.run("peer", "start worker | You are a brief worker.");

    let listMessages = await harness.run("peer", "list");
    let listText = latestNotification(harness.notifications);
    for (let i = 0; i < 60 && /\b(busy|starting)\b/.test(listText); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      listMessages = await harness.run("peer", "list");
      assert.equal(listMessages.length, 0);
      listText = latestNotification(harness.notifications);
    }

    const askMessages = await harness.run("peer", "ask worker | Reply with exactly: peer-ok");
    assert.equal(askMessages.length, 0);
    assert.match(latestNotification(harness.notifications), /Peer reply: worker/);

    const historyMessages = await harness.run("peer", "history worker 0 20");
    assert.equal(historyMessages.length, 0);
    assert.match(latestNotification(harness.notifications), /cursor .* of /);

    const sendMessages = await harness.run("peer", "send worker | Keep working and report back.");
    assert.equal(sendMessages.length, 0);
    assert.match(latestNotification(harness.notifications), /delivery delivered_and_running/);

    const interruptMessages = await harness.run("peer", "interrupt worker");
    assert.equal(interruptMessages.length, 0);
    assert.match(latestNotification(harness.notifications), /Peer interrupted: worker/);

    const stopMessages = await harness.run("peer", "stop worker");
    assert.equal(stopMessages.length, 0);
    assert.match(latestNotification(harness.notifications), /Peer stopped: worker/);
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
    assert.equal(usageMessages.length, 0);
    assert.match(latestNotification(harness.notifications), /\/peer stop --all --confirm/);

    const stopMessages = await harness.run("peer", "stop --all --confirm");
    assert.equal(stopMessages.length, 0);
    assert.match(latestNotification(harness.notifications), /reviewer|tester/);

    const listMessages = await harness.run("peer", "list");
    assert.equal(listMessages.length, 0);
    assert.match(latestNotification(harness.notifications), /No peers yet\./);
  } finally {
    await harness.close();
  }
});
