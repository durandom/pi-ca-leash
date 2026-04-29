import { resolve } from "node:path";
import { ClaudeRuntimeIntercomBridge, PiIntercomTransport } from "@pi-claude-code-agent/intercom-bridge";
import { ClaudeCodeRuntime } from "@pi-claude-code-agent/runtime";
import { ClaudeCodeSubagentBackend } from "@pi-claude-code-agent/subagents-backend";
import { ClaudeCodeTeamsBackend } from "@pi-claude-code-agent/teams-backend";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth, type AutocompleteItem } from "@mariozechner/pi-tui";
import {
  acknowledgeAttention,
  createAttentionLedger,
  createDashboardState,
  describeAttentionState,
  detectConnectivityTransition,
  hasAttentionNote,
  listAttentionViews,
  recordDashboardEvent,
  recordDashboardRefresh,
  reconcileAttentionLedger,
  shouldRebindTransport,
  snoozeAttention,
  type AttentionLedger,
  type AttentionView,
  type DashboardState,
} from "./support.js";

const BACKGROUND_POLL_INTERVAL_MS = 5_000;
const DEFAULT_SNOOZE_MINUTES = 15;

interface DashboardSnapshot {
  sessions: number;
  peers: number;
  peerBusy: number;
  peerIssues: number;
  intercomLive: boolean;
  intercomBoundPeers: number;
  intercomConnectedPeers: number;
  runs: number;
  runActive: number;
  runAttention: number;
  runIssues: number;
  teammates: number;
  teammateBusy: number;
  teammateIssues: number;
  tasks: number;
  openTasks: number;
  taskIssues: number;
  lastEvent: string;
  lastEventAt: number;
  lastRefreshedAt: number;
}

interface DashboardData {
  snapshot: DashboardSnapshot;
  sessions: Awaited<ReturnType<ClaudeCodeRuntime["list"]>>;
  peers: Awaited<ReturnType<ClaudeRuntimeIntercomBridge["listPeers"]>>;
  runs: Awaited<ReturnType<ClaudeCodeSubagentBackend["listRuns"]>>;
  teammates: Awaited<ReturnType<ClaudeCodeTeamsBackend["listTeammates"]>>;
  tasks: Awaited<ReturnType<ClaudeCodeTeamsBackend["listTasks"]>>;
  attention: AttentionView[];
}

type CommandMessageLevel = "info" | "success" | "warning" | "error";

interface CommandMessageDetails {
  level: CommandMessageLevel;
  title: string;
  command?: string;
  timestamp: number;
}

let dashboardContextRef: ExtensionContext | ExtensionCommandContext | undefined;

export default async function claudeCodeAgentExtension(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const rootDir = resolve(cwd, ".pi-claude-code-agent");
  const runtime = new ClaudeCodeRuntime({
    storageDir: resolve(rootDir, "runtime"),
  });
  const bridge = new ClaudeRuntimeIntercomBridge({
    runtime,
    storageDir: resolve(rootDir, "bridge"),
  });
  const subagents = new ClaudeCodeSubagentBackend({
    runtime,
    storageDir: resolve(rootDir, "subagents"),
  });
  const teams = new ClaudeCodeTeamsBackend({
    storageDir: resolve(rootDir, "teams"),
    bridge,
  });

  let intercomTransport: PiIntercomTransport | undefined;
  let intercomReachable: boolean | undefined;
  let backgroundMonitorTimer: NodeJS.Timeout | undefined;
  let attentionLedger: AttentionLedger = createAttentionLedger();

  const extensionVersion = "dev-reload-6";
  const startupSummary = `pi-claude-code-agent ${extensionVersion} loaded`;
  const dashboardState: DashboardState = createDashboardState(startupSummary);

  await bridge.restorePeers();
  await teams.listTeammates();

  async function bindIntercomTransport(): Promise<void> {
    intercomTransport = new PiIntercomTransport();
    await bridge.setTransport(intercomTransport);
  }

  async function unbindIntercomTransport(): Promise<void> {
    await bridge.setTransport(undefined);
    intercomTransport = undefined;
  }

  async function ensureIntercomTransportHealthy(announce: boolean): Promise<boolean> {
    const reachable = await PiIntercomTransport.canConnect().catch(() => false);
    const transition = detectConnectivityTransition(intercomReachable, reachable);
    intercomReachable = reachable;

    if (!reachable) {
      if (intercomTransport) {
        await unbindIntercomTransport();
      }
      if (announce && transition === "disconnected") {
        recordDashboardEvent(dashboardState, "Intercom broker disconnected");
        sendCommandMessage(pi, {
          level: "warning",
          title: "Intercom disconnected",
          body: "Broker unreachable. Claude peers stay local until broker connectivity returns.",
        });
      }
      return false;
    }

    const transportStatus = await bridge.transportStatus();
    const needsRebind = intercomTransport ? shouldRebindTransport(transportStatus) : false;
    if (!intercomTransport || needsRebind) {
      if (intercomTransport) {
        await unbindIntercomTransport();
      }
      await bindIntercomTransport();
      if (announce && (transition === "connected" || needsRebind)) {
        recordDashboardEvent(dashboardState, needsRebind ? "Intercom transport rebound" : "Intercom broker reconnected");
        sendCommandMessage(pi, {
          level: "success",
          title: needsRebind ? "Intercom transport rebound" : "Intercom reconnected",
          body: needsRebind
            ? "Broker reachable again. Existing Claude peers were rebound to live intercom transport."
            : "Broker reachable again. Claude peers are back on live intercom transport.",
        });
      }
    }

    return true;
  }

  async function syncAttentionLedger() {
    const runs = await subagents.listRuns();
    const next = reconcileAttentionLedger(attentionLedger, runs, Date.now());
    attentionLedger = next.ledger;
    return next;
  }

  async function refreshVisibleDashboard(lastEvent?: string): Promise<void> {
    if (!dashboardContextRef) {
      return;
    }
    await refreshDashboard(dashboardContextRef, runtime, bridge, subagents, teams, dashboardState, attentionLedger, lastEvent);
  }

  async function pollBackground(): Promise<void> {
    await ensureIntercomTransportHealthy(true);
    const attention = await syncAttentionLedger();

    for (const run of attention.notify) {
      recordDashboardEvent(dashboardState, `Attention ${shortId(run.runId)} · ${run.agentName}`);
      sendCommandMessage(pi, {
        level: "warning",
        title: `Run needs attention: ${shortId(run.runId)}`,
        body: [run.agentName, run.note].filter(Boolean).join("\n\n"),
      });
    }

    await refreshVisibleDashboard();
  }

  function startBackgroundMonitor(): void {
    if (backgroundMonitorTimer) {
      return;
    }
    backgroundMonitorTimer = setInterval(() => {
      void pollBackground();
    }, BACKGROUND_POLL_INTERVAL_MS);
    backgroundMonitorTimer.unref?.();
  }

  startBackgroundMonitor();
  await ensureIntercomTransportHealthy(false);
  const peerNameCache = new Set((await bridge.listPeers()).map((peer) => peer.name));

  pi.registerMessageRenderer("claude-command-result", (message, { expanded }, theme) => {
    const details = (message.details ?? {}) as Partial<CommandMessageDetails>;
    const level = details.level ?? "info";
    const title = details.title ?? "Claude command result";
    const body = typeof message.content === "string" ? message.content.trim() : String(message.content ?? "").trim();
    const color = levelColor(level);

    let text = `${theme.fg("accent", "[cca]")} ${theme.fg(color, title)}`;
    if (body) {
      text += `\n${body}`;
    }

    if (expanded) {
      const meta = [
        details.command ? `/${details.command}` : undefined,
        details.timestamp ? new Date(details.timestamp).toLocaleTimeString() : undefined,
      ].filter(Boolean).join("  ");
      if (meta) {
        text += `\n${theme.fg("dim", meta)}`;
      }
    }

    const box = new Box(1, 0, (value) => theme.bg("customMessageBg", value));
    box.addChild(new Text(text, 0, 0));
    return box;
  });

  pi.on("session_start", async (event, ctx) => {
    await ensureIntercomTransportHealthy(false);
    await syncAttentionLedger();
    startBackgroundMonitor();
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `${startupSummary} (${event.reason})`);
    ctx.ui.notify(`${startupSummary} (${event.reason})`, "info");
  });

  pi.on("session_shutdown", async () => {
    dashboardContextRef = undefined;
    if (backgroundMonitorTimer) {
      clearInterval(backgroundMonitorTimer);
      backgroundMonitorTimer = undefined;
    }
    await bridge.close();
    intercomTransport = undefined;
    intercomReachable = undefined;
    attentionLedger = createAttentionLedger();
  });

  registerClaudeCommand(pi, "claude-dev-ping", "Proof that pi-claude-code-agent reloaded successfully", async (_args, ctx) => {
    const sessions = await runtime.list();
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Ping ok · s=${sessions.length}`);
    sendCommandMessage(pi, {
      level: "success",
      command: "claude-dev-ping",
      title: "Ping ok",
      body: `sessions ${sessions.length}`,
    });
  });

  registerClaudeCommand(pi, "claude-dashboard", "Show Claude dashboard diagnostics", async (_args, ctx) => {
    await syncAttentionLedger();
    const initial = await collectDashboardData(runtime, bridge, subagents, teams, dashboardState, attentionLedger);
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Dashboard · s=${initial.snapshot.sessions} p=${initial.snapshot.peers} r=${initial.snapshot.runs}`);
    const data = await collectDashboardData(runtime, bridge, subagents, teams, dashboardState, attentionLedger);
    const severity = getDashboardSeverity(data.snapshot);
    sendCommandMessage(pi, {
      level: severity === "error" ? "error" : severity === "warning" ? "warning" : "info",
      command: "claude-dashboard",
      title: "Claude dashboard",
      body: formatDashboardReport(data),
    });
  });

  registerClaudeCommand(pi, "claude-peer-start", "Start named Claude peer. Args: <name> | <prompt>", async (args, ctx) => {
    const [name, prompt] = splitArgs(args, 2);
    if (!name || !prompt || hasPlaceholderToken(name, prompt)) {
      showUsage(pi, "claude-peer-start", [
        "/claude-peer-start <name> | <prompt>",
        "Example: /claude-peer-start worker1 | You are a brief worker. Reply briefly.",
      ].join("\n"));
      return;
    }

    await ensureIntercomTransportHealthy(false);
    const peer = await bridge.launchPeer({
      name,
      prompt,
      cwd,
      permissionMode: "bypassPermissions",
    });
    peerNameCache.add(peer.name);
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peer + ${peer.name}`);
    sendCommandMessage(pi, {
      level: "success",
      command: "claude-peer-start",
      title: `Peer started: ${peer.name}`,
      body: `state ${peer.state}\nsession ${peer.sessionId}`,
    });
  });

  registerClaudeCommand(pi, "claude-peer-list", "List known Claude peers", async (_args, ctx) => {
    const peers = await bridge.listPeers();
    syncNameCache(peerNameCache, peers.map((peer) => peer.name));
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peers · ${peers.length}`);
    sendCommandMessage(pi, {
      level: peers.some((peer) => isProblemState(peer.state)) ? "warning" : "info",
      command: "claude-peer-list",
      title: `Peers (${peers.length})`,
      body: formatPeerList(peers),
    });
  });

  registerClaudeCommand(
    pi,
    "claude-peer-ask",
    "Ask named Claude peer. Args: <name> | <message>",
    async (args, ctx) => {
      const [name, message] = splitArgs(args, 2);
      if (!name || !message || hasPlaceholderToken(name, message)) {
        showUsage(pi, "claude-peer-ask", [
          "/claude-peer-ask <name> | <message>",
          "Example: /claude-peer-ask worker1 | Reply with exactly: peer-ok",
        ].join("\n"));
        return;
      }

      const result = await bridge.ask(name, {
        from: "pi-user",
        text: message,
      });
      peerNameCache.add(name);
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peer ← ${name}`);
      sendCommandMessage(pi, {
        level: result.runState === "failed" ? "error" : result.runState === "interrupted" ? "warning" : "success",
        command: "claude-peer-ask",
        title: `Peer reply: ${name}`,
        body: truncate(result.reply, 1200) || "<empty reply>",
      });
    },
    (prefix) => completePeerName(prefix, peerNameCache, true),
  );

  registerClaudeCommand(
    pi,
    "claude-peer-stop",
    "Stop named Claude peer. Args: <name>",
    async (args, ctx) => {
      const name = args.trim();
      if (!name || hasPlaceholderToken(name)) {
        showUsage(pi, "claude-peer-stop", [
          "/claude-peer-stop <name>",
          "Example: /claude-peer-stop worker1",
        ].join("\n"));
        return;
      }

      const peer = await bridge.stop(name);
      peerNameCache.delete(name);
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peer - ${peer.name}`);
      sendCommandMessage(pi, {
        level: "warning",
        command: "claude-peer-stop",
        title: `Peer stopped: ${peer.name}`,
        body: `state ${peer.state}`,
      });
    },
    (prefix) => completePeerName(prefix, peerNameCache, false),
  );

  registerClaudeCommand(pi, "claude-subagent-run", "Run Claude subagent job. Args: <task>", async (args, ctx) => {
    const task = args.trim();
    if (!task) {
      showUsage(pi, "claude-subagent-run", "/claude-subagent-run <task>");
      return;
    }

    const run = await subagents.startRun({
      agent: {
        name: "claude-subagent",
        runner: "claude-code-agent",
        prompt: "You are delegated worker. Be concise and execution-focused.",
        cwd,
      },
      task,
    });
    await syncAttentionLedger();
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Run ${shortId(run.runId)} ${run.state}`);
    sendCommandMessage(pi, {
      level: runStateLevel(run.state),
      command: "claude-subagent-run",
      title: `Run ${run.state}: ${shortId(run.runId)}`,
      body: [
        `agent ${run.agentName}`,
        `state ${run.state}`,
        run.result?.summary ? `summary\n${truncate(run.result.summary, 1200)}` : undefined,
      ].filter(Boolean).join("\n\n"),
    });
  });

  registerClaudeCommand(pi, "claude-subagent-list", "List Claude subagent runs", async (_args, ctx) => {
    const runs = await subagents.listRuns();
    const attentionViews = listAttentionViews(attentionLedger, runs, Date.now());
    const attentionByRunId = new Map(attentionViews.map((view) => [view.run.runId, describeAttentionState(view, Date.now())]));
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Runs · ${runs.length}`);
    sendCommandMessage(pi, {
      level: runs.some((run) => ["failed", "interrupted"].includes(run.state) || hasAttentionNote(run.note)) ? "warning" : "info",
      command: "claude-subagent-list",
      title: `Runs (${runs.length})`,
      body: runs.length > 0
        ? runs.map((run) => {
          const attention = attentionByRunId.get(run.runId);
          return `${shortId(run.runId)}  ${run.state}${attention ? `  [${attention}]` : ""}  ${run.agentName}`;
        }).join("\n")
        : "No runs found.",
    });
  });

  registerClaudeCommand(pi, "claude-subagent-status", "Show Claude subagent run status. Args: <runId>", async (args, ctx) => {
    const runId = args.trim();
    if (!runId) {
      showUsage(pi, "claude-subagent-status", "/claude-subagent-status <runId>");
      return;
    }

    const run = await subagents.statusRun(runId);
    if (!run) {
      sendCommandMessage(pi, {
        level: "error",
        command: "claude-subagent-status",
        title: `Unknown run: ${runId}`,
      });
      return;
    }

    await syncAttentionLedger();
    const attentionView = listAttentionViews(attentionLedger, [run], Date.now())[0];
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Run ${shortId(run.runId)} ${run.state}`);
    sendCommandMessage(pi, {
      level: runStateLevel(run.state),
      command: "claude-subagent-status",
      title: `Run ${shortId(run.runId)} · ${run.state}`,
      body: [
        `agent ${run.agentName}`,
        attentionView ? `attention ${describeAttentionState(attentionView, Date.now())}` : undefined,
        run.note ? `note\n${run.note}` : undefined,
        run.result?.summary ? `summary\n${truncate(run.result.summary, 1200)}` : undefined,
      ].filter(Boolean).join("\n\n"),
    });
  });

  registerClaudeCommand(pi, "claude-attention-list", "List runs that currently need attention", async (_args, ctx) => {
    const attention = await syncAttentionLedger();
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Attention · ${attention.active.length}`);
    sendCommandMessage(pi, {
      level: attention.active.length > 0 ? "warning" : "info",
      command: "claude-attention-list",
      title: `Attention (${attention.active.length})`,
      body: formatAttentionReport(attention.active),
    });
  });

  registerClaudeCommand(pi, "claude-attention-ack", "Acknowledge noisy attention for a run. Args: <runId-prefix>", async (args, ctx) => {
    const token = args.trim();
    if (!token) {
      showUsage(pi, "claude-attention-ack", "/claude-attention-ack <runId-prefix>");
      return;
    }

    const attention = await syncAttentionLedger();
    const view = resolveAttentionRun(token, attention.active);
    attentionLedger = acknowledgeAttention(attentionLedger, view.run.runId);
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Attention ack ${shortId(view.run.runId)}`);
    sendCommandMessage(pi, {
      level: "success",
      command: "claude-attention-ack",
      title: `Acknowledged: ${shortId(view.run.runId)}`,
      body: [view.run.agentName, view.run.note].filter(Boolean).join("\n\n"),
    });
  });

  registerClaudeCommand(pi, "claude-attention-snooze", "Snooze noisy attention for a run. Args: <runId-prefix> [minutes]", async (args, ctx) => {
    const [token, minutesToken] = args.trim().split(/\s+/, 2).filter(Boolean);
    if (!token) {
      showUsage(pi, "claude-attention-snooze", "/claude-attention-snooze <runId-prefix> [minutes]");
      return;
    }

    const minutes = minutesToken ? Number(minutesToken) : DEFAULT_SNOOZE_MINUTES;
    if (!Number.isFinite(minutes) || minutes <= 0) {
      showUsage(pi, "claude-attention-snooze", "/claude-attention-snooze <runId-prefix> [minutes]");
      return;
    }

    const attention = await syncAttentionLedger();
    const view = resolveAttentionRun(token, attention.active);
    const snoozedUntil = Date.now() + minutes * 60_000;
    attentionLedger = snoozeAttention(attentionLedger, view.run.runId, snoozedUntil);
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Attention snoozed ${shortId(view.run.runId)}`);
    sendCommandMessage(pi, {
      level: "success",
      command: "claude-attention-snooze",
      title: `Snoozed: ${shortId(view.run.runId)}`,
      body: `${view.run.agentName}\n\nuntil ${new Date(snoozedUntil).toLocaleTimeString()}`,
    });
  });

  registerClaudeCommand(pi, "claude-team-spawn", "Spawn Claude teammate. Args: <name> | <prompt>", async (args, ctx) => {
    const [name, prompt] = splitArgs(args, 2);
    if (!name || !prompt) {
      showUsage(pi, "claude-team-spawn", "/claude-team-spawn <name> | <prompt>");
      return;
    }

    await ensureIntercomTransportHealthy(false);
    const teammate = await teams.spawnTeammate({
      name,
      prompt,
      cwd,
    });
    peerNameCache.add(teammate.name);
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Team + ${teammate.name}`);
    sendCommandMessage(pi, {
      level: "success",
      command: "claude-team-spawn",
      title: `Teammate spawned: ${teammate.name}`,
      body: `state ${teammate.state}\nsession ${teammate.sessionId ?? "-"}`,
    });
  });

  registerClaudeCommand(pi, "claude-team-task", "Assign task to Claude teammate. Args: <name> | <title> | <details>", async (args, ctx) => {
    const [name, title, details] = splitArgs(args, 3);
    if (!name || !title || !details) {
      showUsage(pi, "claude-team-task", "/claude-team-task <name> | <title> | <details>");
      return;
    }

    const task = await teams.assignTask({
      assignee: name,
      title,
      details,
    });
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Task ${shortId(task.taskId)} ${task.state}`);
    sendCommandMessage(pi, {
      level: task.state === "blocked" ? "warning" : "success",
      command: "claude-team-task",
      title: `Task ${task.state}: ${shortId(task.taskId)}`,
      body: [
        `${task.assignee} · ${task.title}`,
        task.lastReply ? `reply\n${truncate(task.lastReply, 1200)}` : undefined,
      ].filter(Boolean).join("\n\n"),
    });
  });

  registerClaudeCommand(pi, "claude-team-message", "Message Claude teammate. Args: <name> | <message>", async (args, ctx) => {
    const [name, message] = splitArgs(args, 2);
    if (!name || !message) {
      showUsage(pi, "claude-team-message", "/claude-team-message <name> | <message>");
      return;
    }

    const result = await teams.sendMessage(name, message);
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Team ← ${result.teammate.name}`);
    sendCommandMessage(pi, {
      level: "success",
      command: "claude-team-message",
      title: `Teammate reply: ${result.teammate.name}`,
      body: truncate(result.reply, 1200) || "<empty reply>",
    });
  });

  registerClaudeCommand(pi, "claude-team-list", "List Claude teammates and tasks", async (_args, ctx) => {
    const teammates = await teams.listTeammates();
    const tasks = await teams.listTasks();
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Team/Todo · ${teammates.length}/${tasks.length}`);
    sendCommandMessage(pi, {
      level: teammates.some((teammate) => isProblemState(teammate.state)) || tasks.some((task) => ["blocked", "cancelled"].includes(task.state)) ? "warning" : "info",
      command: "claude-team-list",
      title: `Teammates ${teammates.length} · Tasks ${tasks.length}`,
      body: [
        "Teammates",
        teammates.length > 0 ? teammates.map((teammate) => `${teammate.name}  ${teammate.state}`).join("\n") : "No teammates.",
        "",
        "Tasks",
        tasks.length > 0 ? tasks.map((task) => `${shortId(task.taskId)}  ${task.state}  ${task.assignee}  ${task.title}`).join("\n") : "No tasks.",
      ].join("\n"),
    });
  });

  registerClaudeCommand(pi, "claude-team-stop", "Stop Claude teammate. Args: <name>", async (args, ctx) => {
    const name = args.trim();
    if (!name) {
      showUsage(pi, "claude-team-stop", "/claude-team-stop <name>");
      return;
    }

    const teammate = await teams.stopTeammate(name);
    peerNameCache.delete(name);
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Team - ${teammate.name}`);
    sendCommandMessage(pi, {
      level: "warning",
      command: "claude-team-stop",
      title: `Teammate stopped: ${teammate.name}`,
      body: `state ${teammate.state}`,
    });
  });

  registerClaudeCommand(pi, "claude-runtime-list", "List raw Claude runtime sessions", async (_args, ctx) => {
    const sessions = await runtime.list();
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Runtime · ${sessions.length}`);
    sendCommandMessage(pi, {
      level: sessions.some((session) => ["failed", "interrupted"].includes(session.state)) ? "warning" : "info",
      command: "claude-runtime-list",
      title: `Runtime sessions (${sessions.length})`,
      body: sessions.length > 0
        ? sessions.map((session) => `${shortId(session.sessionId)}  ${session.state}  ${session.name ?? "-"}`).join("\n")
        : "No runtime sessions.",
    });
  });
}

function registerClaudeCommand(
  pi: ExtensionAPI,
  name: string,
  description: string,
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
  getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null,
): void {
  pi.registerCommand(name, {
    description,
    getArgumentCompletions,
    handler: async (args, ctx) => {
      try {
        await handler(args, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendCommandMessage(pi, {
          level: "error",
          command: name,
          title: `/${name} failed`,
          body: message,
        });
        ctx.ui.notify(message, "error");
      }
    },
  });
}

function sendCommandMessage(
  pi: ExtensionAPI,
  input: { level: CommandMessageLevel; title: string; body?: string; command?: string },
): void {
  pi.sendMessage(
    {
      customType: "claude-command-result",
      content: input.body ?? "",
      display: true,
      details: {
        level: input.level,
        title: input.title,
        command: input.command,
        timestamp: Date.now(),
      } satisfies CommandMessageDetails,
    },
    { triggerTurn: false },
  );
}

function showUsage(pi: ExtensionAPI, command: string, usage: string): void {
  sendCommandMessage(pi, {
    level: "warning",
    command,
    title: `Usage: /${command}`,
    body: usage,
  });
}

async function refreshDashboard(
  ctx: ExtensionContext | ExtensionCommandContext,
  runtime: ClaudeCodeRuntime,
  bridge: ClaudeRuntimeIntercomBridge,
  subagents: ClaudeCodeSubagentBackend,
  teams: ClaudeCodeTeamsBackend,
  state: DashboardState,
  attentionLedger: AttentionLedger,
  lastEvent?: string,
): Promise<void> {
  dashboardContextRef = ctx;
  if (lastEvent) {
    recordDashboardEvent(state, lastEvent);
  } else {
    recordDashboardRefresh(state);
  }

  const { snapshot } = await collectDashboardData(runtime, bridge, subagents, teams, state, attentionLedger);

  ctx.ui.setStatus(
    "pi-claude-code-agent",
    `cca ic:${snapshot.intercomLive ? "on" : "off"} s:${snapshot.sessions} p:${snapshot.peers} r:${snapshot.runs} a:${snapshot.runAttention} tm:${snapshot.teammates} tk:${snapshot.tasks}`,
  );
  ctx.ui.setWidget("claude-dashboard", createDashboardWidget(snapshot));
}

function createDashboardWidget(snapshot: DashboardSnapshot) {
  return (_tui: unknown, theme: { fg: (color: string, text: string) => string }) => ({
    invalidate() {},
    render(width: number): string[] {
      const severity = getDashboardSeverity(snapshot);
      const title = theme.fg("accent", "Claude Code Agent");
      const health = severity === "error"
        ? theme.fg("error", "● issues")
        : severity === "warning"
          ? theme.fg("warning", "● active")
          : theme.fg("success", "● healthy");

      const line1 = joinLeftRight(title, health, width);
      const line2 = truncateToWidth([
        metric(theme, "ic", snapshot.intercomConnectedPeers, snapshot.intercomLive ? "success" : "warning"),
        metric(theme, "s", snapshot.sessions),
        metric(theme, "p", snapshot.peers, snapshot.peerIssues > 0 ? "error" : snapshot.peerBusy > 0 ? "warning" : "text"),
        metric(theme, "r", snapshot.runs, snapshot.runIssues > 0 ? "error" : snapshot.runAttention > 0 || snapshot.runActive > 0 ? "warning" : "text"),
        metric(theme, "tm", snapshot.teammates, snapshot.teammateIssues > 0 ? "error" : snapshot.teammateBusy > 0 ? "warning" : "text"),
        metric(theme, "tk", snapshot.tasks, snapshot.taskIssues > 0 ? "warning" : snapshot.openTasks > 0 ? "accent" : "text"),
      ].join("   "), width);
      const line3 = truncateToWidth([
        metric(theme, "busy", snapshot.peerBusy + snapshot.runActive + snapshot.teammateBusy, snapshot.peerBusy + snapshot.runActive + snapshot.teammateBusy > 0 ? "warning" : "success"),
        metric(theme, "attn", snapshot.runAttention, snapshot.runAttention > 0 ? "warning" : "success"),
        metric(theme, "issues", snapshot.peerIssues + snapshot.runIssues + snapshot.teammateIssues + snapshot.taskIssues, snapshot.peerIssues + snapshot.runIssues + snapshot.teammateIssues + snapshot.taskIssues > 0 ? "error" : "success"),
        metric(theme, "open", snapshot.openTasks, snapshot.openTasks > 0 ? "accent" : "text"),
      ].join("   "), width);
      const line4 = truncateToWidth(
        `${theme.fg("dim", `ref ${formatTime(snapshot.lastRefreshedAt)}`)}  ${theme.fg("muted", `evt ${formatTime(snapshot.lastEventAt)}`)}  ${theme.fg(classifyEventColor(snapshot.lastEvent), snapshot.lastEvent)}`,
        width,
      );

      return [line1, line2, line3, line4];
    },
  });
}

async function collectDashboardData(
  runtime: ClaudeCodeRuntime,
  bridge: ClaudeRuntimeIntercomBridge,
  subagents: ClaudeCodeSubagentBackend,
  teams: ClaudeCodeTeamsBackend,
  state: DashboardState,
  attentionLedger: AttentionLedger,
): Promise<DashboardData> {
  const [sessions, peers, runs, teammates, tasks, transportStatus] = await Promise.all([
    runtime.list(),
    bridge.listPeers(),
    subagents.listRuns(),
    teams.listTeammates(),
    teams.listTasks(),
    bridge.transportStatus(),
  ]);
  const attention = listAttentionViews(attentionLedger, runs, Date.now());

  return {
    snapshot: {
      sessions: sessions.length,
      peers: peers.length,
      peerBusy: peers.filter((peer) => ["busy", "starting"].includes(peer.state)).length,
      peerIssues: peers.filter((peer) => isProblemState(peer.state)).length,
      intercomLive: bridge.hasTransport(),
      intercomBoundPeers: transportStatus?.boundPeers ?? 0,
      intercomConnectedPeers: transportStatus?.connectedPeers ?? 0,
      runs: runs.length,
      runActive: runs.filter((run) => ["queued", "starting", "running"].includes(run.state)).length,
      runAttention: attention.length,
      runIssues: runs.filter((run) => ["failed", "interrupted"].includes(run.state)).length,
      teammates: teammates.length,
      teammateBusy: teammates.filter((teammate) => ["starting", "busy"].includes(teammate.state)).length,
      teammateIssues: teammates.filter((teammate) => isProblemState(teammate.state)).length,
      tasks: tasks.length,
      openTasks: tasks.filter((task) => !["done", "cancelled"].includes(task.state)).length,
      taskIssues: tasks.filter((task) => ["blocked", "cancelled"].includes(task.state)).length,
      lastEvent: state.lastEvent,
      lastEventAt: state.lastEventAt,
      lastRefreshedAt: state.lastRefreshedAt,
    },
    sessions,
    peers,
    runs,
    teammates,
    tasks,
    attention,
  };
}

function completePeerName(prefix: string, names: Set<string>, appendPipe: boolean): AutocompleteItem[] | null {
  if (prefix.includes("|")) {
    return null;
  }

  const trimmed = prefix.trim();
  const items = [...names]
    .sort((a, b) => a.localeCompare(b))
    .filter((name) => trimmed.length === 0 || name.startsWith(trimmed))
    .map((name) => ({
      value: appendPipe ? `${name} | ` : name,
      label: appendPipe ? `${name} | <message>` : name,
    }));

  return items.length > 0 ? items : null;
}

function hasPlaceholderToken(...values: Array<string | undefined>): boolean {
  return values.some((value) => Boolean(value && /^<[^>]+>$/.test(value.trim())));
}

function syncNameCache(cache: Set<string>, names: string[]): void {
  cache.clear();
  for (const name of names) {
    cache.add(name);
  }
}

function splitArgs(args: string, expected: number): string[] {
  const parts = args.split("|").map((part) => part.trim()).filter(Boolean);
  return parts.slice(0, expected);
}

function truncate(value: string, max = 240): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function shortId(value: string, size = 8): string {
  return value.length > size ? value.slice(0, size) : value;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function metric(
  theme: { fg: (color: string, text: string) => string },
  label: string,
  value: number,
  valueColor: string = "text",
): string {
  return `${theme.fg("muted", label)} ${theme.fg(valueColor, String(value))}`;
}

function joinLeftRight(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "");
}

function getDashboardSeverity(snapshot: DashboardSnapshot): "ok" | "warning" | "error" {
  if (snapshot.peerIssues + snapshot.runIssues + snapshot.teammateIssues + snapshot.taskIssues > 0) {
    return "error";
  }
  if (snapshot.runAttention > 0 || snapshot.peerBusy + snapshot.runActive + snapshot.teammateBusy + snapshot.openTasks > 0) {
    return "warning";
  }
  return "ok";
}

function formatPeerList(peers: Awaited<ReturnType<ClaudeRuntimeIntercomBridge["listPeers"]>>): string {
  if (peers.length === 0) {
    return "No peers registered.";
  }

  return formatTable(
    ["name", "state", "model", "session"],
    peers.map((peer) => [peer.name, peer.state, peer.model ?? "-", shortId(peer.sessionId, 12)]),
  );
}

function formatDashboardReport(data: DashboardData): string {
  const now = Date.now();
  const { snapshot, peers, runs, teammates, tasks, sessions, attention } = data;
  const attentionByRunId = new Map(attention.map((view) => [view.run.runId, describeAttentionState(view, now)]));
  const sections = [
    `health   ${getDashboardSeverity(snapshot)}`,
    `updated  ${formatTime(snapshot.lastRefreshedAt)}`,
    `event    ${formatTime(snapshot.lastEventAt)}  ${snapshot.lastEvent}`,
    `intercom ${snapshot.intercomLive ? `live (${snapshot.intercomConnectedPeers}/${snapshot.intercomBoundPeers})` : "off"}`,
    "",
    formatTable(
      ["kind", "total", "active", "attn", "issues"],
      [
        ["sessions", String(snapshot.sessions), "-", "-", countWhere(sessions, (session) => ["failed", "interrupted"].includes(session.state))],
        ["peers", String(snapshot.peers), String(snapshot.peerBusy), "-", String(snapshot.peerIssues)],
        ["runs", String(snapshot.runs), String(snapshot.runActive), String(snapshot.runAttention), String(snapshot.runIssues)],
        ["teammates", String(snapshot.teammates), String(snapshot.teammateBusy), "-", String(snapshot.teammateIssues)],
        ["tasks", String(snapshot.tasks), String(snapshot.openTasks), "-", String(snapshot.taskIssues)],
      ],
    ),
  ];

  if (peers.length > 0) {
    sections.push("", "Peers", formatPeerList(peers));
  }
  if (runs.length > 0) {
    sections.push(
      "",
      "Runs",
      formatTable(
        ["run", "state", "agent"],
        runs.slice(0, 8).map((run) => {
          const attentionState = attentionByRunId.get(run.runId);
          return [shortId(run.runId, 12), attentionState ? `${run.state} [${attentionState}]` : run.state, run.agentName];
        }),
      ),
    );
  }
  if (attention.length > 0) {
    sections.push(
      "",
      "Attention",
      formatTable(
        ["run", "agent", "alert", "note"],
        attention.slice(0, 8).map((view) => [
          shortId(view.run.runId, 12),
          view.run.agentName,
          describeAttentionState(view, now),
          truncate(view.run.note ?? "", 72),
        ]),
      ),
    );
  }
  if (teammates.length > 0) {
    sections.push(
      "",
      "Teammates",
      formatTable(
        ["name", "state", "session"],
        teammates.map((teammate) => [teammate.name, teammate.state, shortId(teammate.sessionId ?? "-", 12)]),
      ),
    );
  }
  if (tasks.length > 0) {
    sections.push(
      "",
      "Tasks",
      formatTable(
        ["task", "state", "assignee", "title"],
        tasks.slice(0, 8).map((task) => [shortId(task.taskId, 12), task.state, task.assignee, task.title]),
      ),
    );
  }

  return sections.join("\n");
}

function formatAttentionReport(attention: AttentionView[]): string {
  if (attention.length === 0) {
    return "No active attention runs.";
  }
  const now = Date.now();
  return formatTable(
    ["run", "state", "agent", "note"],
    attention.map((view) => [
      shortId(view.run.runId, 12),
      describeAttentionState(view, now),
      view.run.agentName,
      truncate(view.run.note ?? "", 72),
    ]),
  );
}

function formatTable(headers: string[], rows: string[][]): string {
  const matrix = [headers, ...rows].map((row) => row.map((cell) => cell ?? ""));
  const widths = headers.map((_, index) => Math.max(...matrix.map((row) => row[index]?.length ?? 0)));
  const formatRow = (row: string[]) => row.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  return [formatRow(headers), separator, ...rows.map(formatRow)].join("\n");
}

function countWhere<T>(items: T[], predicate: (item: T) => boolean): string {
  return String(items.filter(predicate).length);
}

function classifyEventColor(lastEvent: string): string {
  const text = lastEvent.toLowerCase();
  if (text.includes("failed") || text.includes("error") || text.includes("unknown") || text.includes("issues")) {
    return "error";
  }
  if (text.includes("attention") || text.includes("interrupted") || text.includes("stopped") || text.includes("usage") || text.includes("disconnect") || text.includes("-") || text.includes("·")) {
    return "warning";
  }
  if (text.includes("ping ok") || text.includes("connected") || text.includes("rebound") || text.includes("+") || text.includes("←") || text.includes("reply")) {
    return "success";
  }
  return "text";
}

function levelColor(level: CommandMessageLevel): string {
  switch (level) {
    case "success":
      return "success";
    case "warning":
      return "warning";
    case "error":
      return "error";
    default:
      return "text";
  }
}

function runStateLevel(state: string): CommandMessageLevel {
  if (["completed", "idle"].includes(state)) {
    return "success";
  }
  if (["failed"].includes(state)) {
    return "error";
  }
  if (["interrupted", "stopped", "queued", "starting", "running"].includes(state)) {
    return "warning";
  }
  return "info";
}

function isProblemState(state: string): boolean {
  return ["errored", "disconnected", "interrupted", "failed"].includes(state);
}

function resolveAttentionRun(token: string, attention: AttentionView[]): AttentionView {
  const matches = attention.filter((view) => view.run.runId.startsWith(token));
  if (matches.length === 1) {
    return matches[0]!;
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous run id prefix ${token}`);
  }
  throw new Error(`No active attention run matches ${token}`);
}
