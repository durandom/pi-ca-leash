import { appendFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { ClaudeRuntimeIntercomBridge, extractReplyText, type BridgePeer, PiIntercomTransport } from "@pi-claude-code-agent/intercom-bridge";
import { ClaudeCodeRuntime, type RuntimeEvent, type RuntimeMessageBlock } from "@pi-claude-code-agent/runtime";
import { ClaudeCodeSubagentBackend } from "@pi-claude-code-agent/subagents-backend";
import { ClaudeCodeTeamsBackend } from "@pi-claude-code-agent/teams-backend";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Box, Text, truncateToWidth, visibleWidth, type AutocompleteItem } from "@mariozechner/pi-tui";
import { readAttentionLedger, serializeAttentionLedger, writeAttentionLedger } from "./persistence.js";
import { ADVANCED_COMMANDS_ENV, LEGACY_COMMANDS_ENV, advancedCommandsEnabled, legacyCommandsEnabled } from "./command-visibility.js";
import { derivePeerName } from "./peer-naming.js";
import {
  createPeerRelaySnapshot,
  formatPeerCompletionTurn,
  formatQuotedTextBlock,
  shouldForceRelayPeerCompletion,
  shouldRelayPeerCompletion,
  type PeerRelaySnapshot,
} from "./peer-relay.js";
import { formatPeerHistoryPage } from "./peer-history.js";
import { buildPeerActivityRow, getPeerFirstHealth, isPeerVisibleInWidget, type PeerActivityRow } from "./peer-ux.js";
import { parseRuntimeDriverName, resolveExtensionRuntimeDriverConfig } from "./runtime-driver.js";
import { modelCatalogsForDriver, resolveRuntimeModelSelection, type RuntimeDriverModelCatalog } from "./model-catalog.js";
import { describePromptSize } from "./runtime-safety.js";
import {
  PEER_ASK_TOOL_PROMPT,
  PEER_BRIDGE_APPEND_SYSTEM_PROMPT,
  EXTENSION_LOG_TOOL_PROMPT,
  PEER_HISTORY_TOOL_PROMPT,
  PEER_INIT_GUIDE,
  PEER_INIT_USER_HELP,
  PEER_INTERRUPT_TOOL_PROMPT,
  PEER_LIST_TOOL_PROMPT,
  PEER_NO_BABYSITTING_GUIDANCE,
  PEER_SEND_TOOL_PROMPT,
  PEER_START_TOOL_PROMPT,
  PEER_STOP_TOOL_PROMPT,
  RUNTIME_MODELS_TOOL_PROMPT,
  SUBAGENT_LIST_TOOL_PROMPT,
  SUBAGENT_RUN_TOOL_PROMPT,
  SUBAGENT_STATUS_TOOL_PROMPT,
  TEAM_LIST_TOOL_PROMPT,
  TEAM_MESSAGE_TOOL_PROMPT,
  TEAM_SPAWN_TOOL_PROMPT,
  TEAM_STOP_TOOL_PROMPT,
  TEAM_TASK_TOOL_PROMPT,
} from "./prompts.js";
import { parseSubagentRunToolInput, parseTeamSpawnToolInput } from "./tool-inputs.js";
import { parsePeerStartCommandInput, parseSubagentRunCommandInput, parseTeamSpawnCommandInput } from "./command-drivers.js";
import { buildSubagentRunRequest, buildTeamSpawnRequest } from "./backend-tool-actions.js";
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
  computeWidgetSignature,
  shouldRebindTransport,
  shouldSkipBackgroundRefresh,
  snoozeAttention,
  type AttentionLedger,
  type AttentionView,
  type DashboardState,
} from "./support.js";

const EXTENSION_NAME = "pi-ca-leash";
const extensionRequire = createRequire(import.meta.url);
const EXTENSION_PACKAGE_PATH = extensionRequire.resolve("../package.json");
const EXTENSION_PACKAGE_ROOT = dirname(EXTENSION_PACKAGE_PATH);
const EXTENSION_VERSION = String((extensionRequire("../package.json") as { version?: string }).version ?? "0.0.0");
const STATE_DIR_NAME = ".pi-ca-leash";
const BACKGROUND_POLL_INTERVAL_MS = 5_000;
const BACKGROUND_REFRESH_MIN_INTERVAL_MS = 3_000;
const DEFAULT_SNOOZE_MINUTES = 15;

interface DashboardSnapshot {
  sessions: number;
  peers: number;
  peerBusy: number;
  peerIssues: number;
  peerRows: PeerActivityRow[];
  intercomLive: boolean;
  intercomBoundPeers: number;
  intercomConnectedPeers: number;
  transportDegraded: boolean;
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
type CommandMessageSurface = "custom" | "tool" | "agent";

interface CommandMessageDetails {
  level: CommandMessageLevel;
  title: string;
  command?: string;
  timestamp: number;
  surface?: CommandMessageSurface;
}

interface ExtensionLogEntryInput {
  category: "ux" | "agent-guidance" | "tooling" | "runtime" | "model-selection" | "docs" | "bug" | "other";
  severity: "low" | "medium" | "high";
  summary: string;
  observed?: string;
  expected?: string;
  reproduction?: string;
  suggestedFix?: string;
  relatedCommand?: string;
  relatedTool?: string;
  files: string[];
}

let dashboardContextRef: ExtensionContext | ExtensionCommandContext | undefined;
let operatorContextRef: ExtensionContext | ExtensionCommandContext | undefined;
let lastWidgetSignature: string | undefined;

export default async function piCaLeashExtension(pi: ExtensionAPI) {
  const cwd = process.cwd();
  const rootDir = resolve(cwd, STATE_DIR_NAME);
  const attentionLedgerPath = resolve(rootDir, "extension", "attention-ledger.json");
  const runtimeDriverConfig = resolveExtensionRuntimeDriverConfig();
  const runtime = new ClaudeCodeRuntime({
    storageDir: resolve(rootDir, "runtime"),
    defaultDriver: runtimeDriverConfig.defaultDriver,
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
  let attentionLedger: AttentionLedger = await readAttentionLedger(attentionLedgerPath);
  let persistedAttentionLedger = serializeAttentionLedger(attentionLedger);
  const peerRelaySnapshots = new Map<string, PeerRelaySnapshot>();
  const suppressNextPeerRelay = new Set<string>();
  let peerModeActive = false;
  let peerGuideShown = false;
  let runtimeDriverFallbackShown = false;

  const showAdvancedCommands = advancedCommandsEnabled();
  const showLegacyCommands = legacyCommandsEnabled();
  const noSessionMode = process.argv.includes("--no-session");
  const startupSummary = `${EXTENSION_NAME} v${EXTENSION_VERSION} loaded · default driver ${runtimeDriverConfig.defaultDriver}`;
  const dashboardState: DashboardState = createDashboardState(startupSummary);

  await bridge.restorePeers();
  await teams.listTeammates();

  async function startPeerWithoutWaiting(input: {
    name: string;
    prompt: string;
    driver?: "claude-sdk" | "codex-cli";
    cwd?: string;
    model?: string;
    permissionMode?: "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";
  }): Promise<BridgePeer> {
    if (await bridge.status(input.name)) {
      throw new Error(`Peer name ${input.name} already registered`);
    }
    const status = await runtime.start({
      prompt: input.prompt,
      driver: input.driver,
      cwd: input.cwd,
      model: input.model,
      name: input.name,
      appendSystemPrompt: PEER_BRIDGE_APPEND_SYSTEM_PROMPT,
      permissionMode: input.permissionMode,
    });
    return bridge.attachPeer({ name: input.name, sessionId: status.sessionId });
  }

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
          body: "Broker unreachable. Peers stay local until broker connectivity returns.",
          surface: "custom",
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
            ? "Broker reachable again. Existing peers were rebound to live intercom transport."
            : "Broker reachable again. Peers are back on live intercom transport.",
          surface: "custom",
        });
      }
    }

    return true;
  }

  async function persistAttentionLedger(): Promise<void> {
    const nextSerialized = serializeAttentionLedger(attentionLedger);
    if (nextSerialized === persistedAttentionLedger) {
      return;
    }
    await writeAttentionLedger(attentionLedgerPath, attentionLedger);
    persistedAttentionLedger = nextSerialized;
  }

  async function syncAttentionLedger() {
    const runs = await subagents.listRuns();
    const next = reconcileAttentionLedger(attentionLedger, runs, Date.now());
    attentionLedger = next.ledger;
    await persistAttentionLedger();
    return next;
  }

  async function refreshVisibleDashboard(lastEvent?: string): Promise<void> {
    if (!peerModeActive) {
      return;
    }
    if (!dashboardContextRef) {
      return;
    }
    if (!lastEvent && shouldSkipBackgroundRefresh(dashboardState, Date.now(), BACKGROUND_REFRESH_MIN_INTERVAL_MS)) {
      return;
    }
    await refreshDashboard(dashboardContextRef, runtime, bridge, subagents, teams, dashboardState, attentionLedger, lastEvent);
  }

  async function buildPeerRelayInput(peer: BridgePeer): Promise<{ snapshot: PeerRelaySnapshot; row: PeerActivityRow; message?: string }> {
    const events = await runtime.tail(peer.sessionId, 20).catch(() => []);
    const row = buildPeerActivityRow(peer, events);
    const lastMessage = truncate(extractLatestVisibleReplyText(events).trim(), 4_000);
    const fallback = row.activity !== "idle" ? row.activity : undefined;
    const messageText = lastMessage || fallback;
    const snapshot = createPeerRelaySnapshot({
      sessionId: peer.sessionId,
      state: row.state,
      updatedAt: row.lastUpdateAt,
      messageText,
    });
    return {
      snapshot,
      row,
      message: messageText,
    };
  }

  function extractLatestVisibleReplyText(events: RuntimeEvent[]): string {
    const latestAssistantMessage = [...events]
      .reverse()
      .find((event): event is Extract<RuntimeEvent, { type: "message" }> => event.type === "message" && event.role === "assistant"
        && event.message.blocks.some((block) => Boolean(blockToVisibleText(block)?.trim())));

    if (latestAssistantMessage) {
      return latestAssistantMessage.message.blocks
        .map(blockToVisibleText)
        .filter((value): value is string => Boolean(value && value.trim()))
        .join("\n\n")
        .trim();
    }

    const result = [...events]
      .reverse()
      .find((event): event is Extract<RuntimeEvent, { type: "result" }> => event.type === "result");
    return result?.summary ?? "";
  }

  function blockToVisibleText(block: RuntimeMessageBlock): string | undefined {
    if (block.type === "thinking") {
      return undefined;
    }
    return typeof block.text === "string" ? block.text : undefined;
  }

  async function resolvePeerHistoryTarget(name: string): Promise<{
    name: string;
    sessionId: string;
    state: string;
    model?: string;
    driver?: string;
    cwd: string;
    source: "active" | "runtime";
  } | undefined> {
    const active = await bridge.status(name);
    if (active) {
      return {
        name: active.name,
        sessionId: active.sessionId,
        state: active.state,
        model: active.model,
        driver: active.driver,
        cwd: active.cwd,
        source: "active",
      };
    }

    const historical = (await runtime.list()).find((session) => session.name === name);
    if (!historical) {
      return undefined;
    }

    return {
      name,
      sessionId: historical.sessionId,
      state: historical.state,
      model: historical.model,
      driver: historical.driver,
      cwd: historical.cwd,
      source: "runtime",
    };
  }

  async function seedPeerRelaySnapshots(): Promise<void> {
    const peers = await bridge.listPeers();
    for (const peer of peers) {
      const { snapshot } = await buildPeerRelayInput(peer);
      peerRelaySnapshots.set(peer.name, snapshot);
    }
  }

  async function syncPeerRelaySnapshot(peer: BridgePeer): Promise<{ row: PeerActivityRow; message?: string }> {
    const { snapshot, row, message } = await buildPeerRelayInput(peer);
    peerRelaySnapshots.set(peer.name, snapshot);
    suppressNextPeerRelay.delete(peer.name);
    return { row, message };
  }

  async function relayPeerCompletionToMain(peer: BridgePeer, options: { force?: boolean; reply?: string } = {}): Promise<boolean> {
    if (["stopped", "disconnected"].includes(peer.state)) {
      suppressNextPeerRelay.delete(peer.name);
      return false;
    }
    const previous = peerRelaySnapshots.get(peer.name);
    const { snapshot, row, message } = await buildPeerRelayInput(peer);
    const shouldRelay = options.force
      ? shouldForceRelayPeerCompletion(previous, snapshot)
      : shouldRelayPeerCompletion(previous, snapshot);

    peerRelaySnapshots.set(peer.name, snapshot);
    if (!shouldRelay) {
      return false;
    }
    if (!options.force && suppressNextPeerRelay.delete(peer.name)) {
      return false;
    }

    const text = truncate((options.reply ?? message ?? "").trim(), 4_000);
    if (!text) {
      return false;
    }

    pi.sendUserMessage(formatPeerCompletionTurn({
      peerName: peer.name,
      state: row.state,
      sessionId: peer.sessionId,
      message: text,
    }), { deliverAs: "followUp" });
    return true;
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
        surface: "custom",
      });
    }

    const peers = await bridge.listPeers();
    for (const peer of peers) {
      await relayPeerCompletionToMain(peer);
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

  const peerNameCache = new Set((await bridge.listPeers()).map((peer) => peer.name));

  async function activatePeerMode(ctx: ExtensionContext | ExtensionCommandContext, options: { command?: string; showGuide?: boolean; forceGuide?: boolean; reason?: string } = {}): Promise<void> {
    if (!peerModeActive) {
      if (!noSessionMode) {
        await ensureIntercomTransportHealthy(false);
      }
      await syncAttentionLedger();
      await seedPeerRelaySnapshots();
      if (!noSessionMode) {
        startBackgroundMonitor();
      }
      peerModeActive = true;
      dashboardContextRef = ctx;
      if (options.reason) {
        recordDashboardEvent(dashboardState, options.reason);
      }
    }
    if (options.showGuide && (options.forceGuide || !peerGuideShown)) {
      peerGuideShown = true;
      sendCommandMessage(pi, {
        level: "info",
        command: options.command,
        title: "Agent orchestration guide",
        body: PEER_INIT_GUIDE,
        surface: "agent",
      });
      showPeerInitUserHelp(ctx);
    }
    if (runtimeDriverConfig.note && !runtimeDriverFallbackShown) {
      runtimeDriverFallbackShown = true;
      sendCommandMessage(pi, {
        level: "warning",
        command: options.command,
        title: "Runtime driver config fallback",
        body: runtimeDriverConfig.note,
        surface: "custom",
      });
    }
  }

  pi.registerMessageRenderer("peer-command-result", (message, { expanded }, theme) => {
    const details = (message.details ?? {}) as Partial<CommandMessageDetails>;
    const level = details.level ?? "info";
    const surface = details.surface ?? "tool";
    const title = details.title ?? "Peer command result";
    const body = typeof message.content === "string" ? message.content.trim() : String(message.content ?? "").trim();
    const color = levelColor(level);
    const label = surface === "agent" ? "[peer/agent]" : "[peer]";

    let text = `${theme.fg("toolTitle", label)} ${theme.fg(color, title)}`;
    if (body) {
      text += `\n${theme.fg("toolOutput", body)}`;
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

    const box = new Box(1, 0, (value) => theme.bg(commandMessageBg(surface, level), value));
    box.addChild(new Text(text, 0, 0));
    return box;
  });

  pi.registerTool({
    name: "runtime_models",
    label: "Runtime Models",
    description: "List recommended runtime models, or the full bundled Lanista-derived model catalog in verbose mode.",
    promptSnippet: RUNTIME_MODELS_TOOL_PROMPT.snippet,
    promptGuidelines: RUNTIME_MODELS_TOOL_PROMPT.guidelines,
    parameters: {
      type: "object",
      properties: {
        driver: { type: "string", enum: ["claude-sdk", "codex-cli"], description: "Optional runtime driver to filter the model catalog." },
        verbose: { type: "boolean", description: "When true, include every model from the bundled catalog instead of the short recommended list." },
      },
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      const input = params as { driver?: unknown; verbose?: unknown };
      const driver = input.driver == null ? undefined : parseRuntimeDriverName(input.driver);
      if (input.driver != null && !driver) {
        throw new Error("driver must be claude-sdk or codex-cli");
      }
      const verbose = input.verbose === true;
      const catalogs = modelCatalogsForDriver(driver);
      return {
        content: [{
          type: "text",
          text: formatModelCatalogReport(catalogs, { verbose }),
        }],
        details: { catalogs },
      };
    },
  });

  pi.registerTool({
    name: "extension_log",
    label: "Extension Log",
    description: "Append structured pi-ca-leash extension feedback to .pi-ca-leash/log.md.",
    promptSnippet: EXTENSION_LOG_TOOL_PROMPT.snippet,
    promptGuidelines: EXTENSION_LOG_TOOL_PROMPT.guidelines,
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["ux", "agent-guidance", "tooling", "runtime", "model-selection", "docs", "bug", "other"],
          description: "Feedback category.",
        },
        severity: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "Optional severity. Defaults to medium.",
        },
        summary: { type: "string", description: "Concise actionable summary of the problem or rough edge." },
        observed: { type: "string", description: "What happened or felt rough." },
        expected: { type: "string", description: "What should have happened or felt smoother." },
        reproduction: { type: "string", description: "Minimal reproduction or triggering interaction, if known." },
        suggestedFix: { type: "string", description: "Optional implementation or UX suggestion." },
        relatedCommand: { type: "string", description: "Related slash command or interaction surface, if any." },
        relatedTool: { type: "string", description: "Related LLM-callable tool, if any." },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Relevant local files, if any.",
        },
      },
      required: ["summary"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params) {
      const input = parseExtensionLogInput(params);
      const logPath = resolve(rootDir, "log.md");
      await mkdir(dirname(logPath), { recursive: true });
      await appendFile(logPath, formatExtensionLogEntry(input), "utf8");
      return {
        content: [{
          type: "text",
          text: `Logged extension feedback to ${join(STATE_DIR_NAME, "log.md")}.`,
        }],
        details: { path: logPath, entry: input },
      };
    },
  });

  pi.registerTool({
    name: "peer_start",
    label: "Start Peer",
    description: "Start a long-lived runtime-backed peer from a prompt, optionally with an explicit name, driver, model, and working directory.",
    promptSnippet: PEER_START_TOOL_PROMPT.snippet,
    promptGuidelines: PEER_START_TOOL_PROMPT.guidelines,
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Task or role prompt for the peer." },
        name: { type: "string", description: "Optional explicit peer name." },
        driver: { type: "string", enum: ["claude-sdk", "codex-cli"], description: "Optional runtime driver for this peer. Defaults to the extension startup driver." },
        model: { type: "string", description: "Optional model to use for this peer session." },
        cwd: { type: "string", description: "Optional working directory for the peer. Relative paths resolve from the current pi working directory." },
      },
      required: ["prompt"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await activatePeerMode(ctx, { command: "peer_start", reason: "Peer mode activated" });
      const input = params as { prompt?: unknown; name?: unknown; driver?: unknown; model?: unknown; cwd?: unknown };
      const prompt = String(input.prompt ?? "").trim();
      const explicitName = typeof input.name === "string" ? input.name.trim() : "";
      const driver = input.driver == null ? undefined : parseRuntimeDriverName(input.driver);
      const model = typeof input.model === "string" ? input.model.trim() || undefined : undefined;
      const peerCwd = typeof input.cwd === "string" ? input.cwd.trim() || undefined : undefined;
      if (!prompt) {
        throw new Error("prompt required");
      }
      if (input.driver != null && !driver) {
        throw new Error("driver must be claude-sdk or codex-cli");
      }
      const effectiveDriver = driver ?? runtimeDriverConfig.defaultDriver;
      const modelSelection = resolveRuntimeModelSelection(effectiveDriver, model);
      const modelNote = modelSelection.note;
      const promptSizeNote = describePromptSize("peer prompt", prompt);

      const existingNames = new Set((await bridge.listPeers()).map((peer) => peer.name));
      const name = explicitName || derivePeerName(prompt, existingNames);
      if (!noSessionMode) {
        await ensureIntercomTransportHealthy(false);
      }
      const peer = await startPeerWithoutWaiting({
        name,
        prompt,
        driver,
        cwd: peerCwd ?? cwd,
        model: modelSelection.runtimeModel,
        permissionMode: "bypassPermissions",
      });
      peerNameCache.add(peer.name);
      const { row, message } = await syncPeerRelaySnapshot(peer);
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peer started: ${peer.name}`);
      sendCommandMessage(pi, {
        level: "success",
        command: "peer_start",
        title: `Peer started: ${peer.name}`,
        body: [
          !explicitName ? `auto-name ${peer.name}` : undefined,
          `state ${row.state}`,
          `driver ${peer.driver ?? "claude-sdk"}`,
          modelNote,
          promptSizeNote,
          `session ${peer.sessionId}`,
          "",
          PEER_NO_BABYSITTING_GUIDANCE,
        ].filter((line) => line !== undefined).join("\n"),
      });
      return {
        content: [{
          type: "text",
          text: [
            `Peer started: ${peer.name}`,
            PEER_NO_BABYSITTING_GUIDANCE,
            !explicitName ? `auto-name ${peer.name}` : undefined,
            `state ${row.state}`,
            `driver ${peer.driver ?? "claude-sdk"}`,
            `model ${peer.model ?? "-"}`,
            modelNote,
            promptSizeNote,
            `cwd ${peer.cwd}`,
            `session ${peer.sessionId}`,
            message ? `latest peer message\n${formatQuotedTextBlock(message)}` : undefined,
          ].filter(Boolean).join("\n\n"),
        }],
        details: { peerName: peer.name, state: row.state, sessionId: peer.sessionId, driver: peer.driver, model: peer.model, requestedModel: model, modelNote, promptSizeNote, cwd: peer.cwd, guidance: PEER_NO_BABYSITTING_GUIDANCE },
      };
    },
  });

  pi.registerTool({
    name: "peer_list",
    label: "List Peers",
    description: "List known runtime-backed peers with their current state and latest activity summary.",
    promptSnippet: PEER_LIST_TOOL_PROMPT.snippet,
    promptGuidelines: PEER_LIST_TOOL_PROMPT.guidelines,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      await activatePeerMode(ctx, { command: "peer_list", reason: "Peer mode activated" });
      const data = await collectDashboardData(runtime, bridge, subagents, teams, dashboardState, attentionLedger);
      syncNameCache(peerNameCache, data.peers.map((peer) => peer.name));
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peers · ${data.peers.length}`, data);
      return {
        content: [{
          type: "text",
          text: formatPeerList(data.snapshot.peerRows),
        }],
        details: {
          peers: data.snapshot.peerRows.map((row) => {
            const peer = data.peers.find((entry) => entry.sessionId === row.sessionId);
            return {
              name: row.name,
              state: row.state,
              activity: row.activity,
              sessionId: row.sessionId,
              driver: peer?.driver,
              model: peer?.model,
              cwd: peer?.cwd,
            };
          }),
        },
      };
    },
  });

  pi.registerTool({
    name: "peer_history",
    label: "Peer History",
    description: "Scroll through a peer transcript so the main agent can inspect prior visible messages and tool activity.",
    promptSnippet: PEER_HISTORY_TOOL_PROMPT.snippet,
    promptGuidelines: PEER_HISTORY_TOOL_PROMPT.guidelines,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Peer name." },
        cursor: { type: "number", description: "Zero-based visible history cursor. Omit to start from the latest page." },
        limit: { type: "number", description: "Maximum visible history entries to return (default 20, max 200)." },
      },
      required: ["name"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await activatePeerMode(ctx, { command: "peer_history", reason: "Peer mode activated" });
      const input = params as { name?: unknown; cursor?: unknown; limit?: unknown };
      const name = String(input.name ?? "").trim();
      const cursor = input.cursor == null ? undefined : Number(input.cursor);
      const limit = input.limit == null ? undefined : Number(input.limit);
      if (!name) {
        throw new Error("name required");
      }
      if (cursor != null && (!Number.isFinite(cursor) || cursor < 0)) {
        throw new Error("cursor must be a non-negative number");
      }
      if (limit != null && (!Number.isFinite(limit) || limit <= 0)) {
        throw new Error("limit must be a positive number");
      }

      const target = await resolvePeerHistoryTarget(name);
      if (!target) {
        throw new Error(`Unknown peer ${name}`);
      }

      const transcript = await runtime.readTranscript(target.sessionId);
      const page = formatPeerHistoryPage(transcript.items, {
        cursor: cursor == null ? undefined : Math.trunc(cursor),
        limit: limit == null ? undefined : Math.trunc(limit),
      });
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peer history: ${name}`);
      return {
        content: [{
          type: "text",
          text: [
            `Peer history: ${name}`,
            `state ${target.state}`,
            `driver ${target.driver ?? "-"}`,
            `model ${target.model ?? "-"}`,
            `cwd ${target.cwd}`,
            `session ${target.sessionId}`,
            `cursor ${page.startCursor}..${page.endCursor} of ${page.total}`,
            `previousCursor ${page.previousCursor ?? "-"}`,
            `nextCursor ${page.nextCursor ?? "-"}`,
            `source ${target.source}`,
            `history\n${formatQuotedTextBlock(page.text)}`,
          ].join("\n\n"),
        }],
        details: {
          peerName: name,
          state: target.state,
          sessionId: target.sessionId,
          driver: target.driver,
          model: target.model,
          cwd: target.cwd,
          source: target.source,
          cursor: page.startCursor,
          endCursor: page.endCursor,
          total: page.total,
          previousCursor: page.previousCursor,
          nextCursor: page.nextCursor,
        },
      };
    },
  });

  pi.registerTool({
    name: "peer_ask",
    label: "Ask Peer",
    description: "Send a message to an existing peer and wait for its visible reply. Optionally switch the peer to a different model.",
    promptSnippet: PEER_ASK_TOOL_PROMPT.snippet,
    promptGuidelines: PEER_ASK_TOOL_PROMPT.guidelines,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Peer name." },
        message: { type: "string", description: "Message to send to the peer." },
        model: { type: "string", description: "Optional model override. When set, the peer keeps using that model for later turns." },
      },
      required: ["name", "message"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await activatePeerMode(ctx, { command: "peer_ask", reason: "Peer mode activated" });
      const input = params as { name?: unknown; message?: unknown; model?: unknown };
      const name = String(input.name ?? "").trim();
      const message = String(input.message ?? "").trim();
      const model = typeof input.model === "string" ? input.model.trim() || undefined : undefined;
      if (!name || !message) {
        throw new Error("name and message required");
      }
      const currentPeer = await bridge.status(name).catch(() => undefined);
      const effectiveDriver = currentPeer?.driver ?? runtimeDriverConfig.defaultDriver;
      const modelSelection = model ? resolveRuntimeModelSelection(effectiveDriver, model) : undefined;
      const modelNote = modelSelection?.note;
      const promptSizeNote = describePromptSize("peer message", message);

      sendCommandMessage(pi, {
        level: "info",
        command: "peer_ask",
        title: `Sent to peer: ${name}`,
        body: [modelNote, promptSizeNote, formatQuotedTextBlock(truncate(message, 4_000))].filter(Boolean).join("\n\n"),
      });

      suppressNextPeerRelay.delete(name);
      const result = await bridge.ask(name, {
        from: "pi-main-agent",
        text: message,
        model: modelSelection?.runtimeModel,
      });
      peerNameCache.add(name);
      const { row } = await syncPeerRelaySnapshot(result.peer);
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peer replied: ${name}`);
      const deliveredAndRunning = result.deliveryState === "delivered_and_running";
      const visibleReply = result.reply.trim() || (deliveredAndRunning ? "<peer still running; wait for automated update>" : "<empty reply>");
      return {
        content: [{
          type: "text",
          text: [
            deliveredAndRunning ? `Peer message delivered: ${name}` : `Peer reply: ${name}`,
            "sent prompt shown in an operator notification",
            deliveredAndRunning ? "delivery delivered_and_running" : undefined,
            deliveredAndRunning ? "do not poll; wait for automated peer update" : undefined,
            `state ${row.state}`,
            `driver ${result.peer.driver ?? "claude-sdk"}`,
            `model ${result.peer.model ?? "-"}`,
            modelNote,
            promptSizeNote,
            `quoted peer message\n${formatQuotedTextBlock(visibleReply)}`,
          ].filter(Boolean).join("\n\n"),
        }],
        details: { peerName: name, state: row.state, sessionId: result.peer.sessionId, driver: result.peer.driver, model: result.peer.model, requestedModel: model, modelNote, promptSizeNote, cwd: result.peer.cwd, message, reply: result.reply, deliveryState: result.deliveryState },
      };
    },
  });

  pi.registerTool({
    name: "peer_send",
    label: "Send to Peer",
    description: "Send a fire-and-forget message to an idle peer. The peer completion will arrive later as an automated follow-up.",
    promptSnippet: PEER_SEND_TOOL_PROMPT.snippet,
    promptGuidelines: PEER_SEND_TOOL_PROMPT.guidelines,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Peer name." },
        message: { type: "string", description: "Message to send to the peer." },
        model: { type: "string", description: "Optional model override. When set, the peer keeps using that model for later turns." },
      },
      required: ["name", "message"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await activatePeerMode(ctx, { command: "peer_send", reason: "Peer mode activated" });
      const input = params as { name?: unknown; message?: unknown; model?: unknown };
      const name = String(input.name ?? "").trim();
      const message = String(input.message ?? "").trim();
      const model = typeof input.model === "string" ? input.model.trim() || undefined : undefined;
      if (!name || !message) {
        throw new Error("name and message required");
      }
      const currentPeer = await bridge.status(name).catch(() => undefined);
      const effectiveDriver = currentPeer?.driver ?? runtimeDriverConfig.defaultDriver;
      const modelSelection = model ? resolveRuntimeModelSelection(effectiveDriver, model) : undefined;
      const modelNote = modelSelection?.note;
      const promptSizeNote = describePromptSize("peer message", message);

      sendCommandMessage(pi, {
        level: "info",
        command: "peer_send",
        title: `Sent to peer: ${name}`,
        body: [modelNote, promptSizeNote, formatQuotedTextBlock(truncate(message, 4_000))].filter(Boolean).join("\n\n"),
      });

      suppressNextPeerRelay.delete(name);
      const peer = await bridge.send(name, {
        from: "pi-main-agent",
        text: message,
        model: modelSelection?.runtimeModel,
      }, { waitForIdle: false });
      peerNameCache.add(name);
      const { row } = await syncPeerRelaySnapshot(peer);
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peer message sent: ${name}`);
      return {
        content: [{
          type: "text",
          text: [
            `Peer message sent: ${name}`,
            "delivery delivered_and_running",
            "do not poll; wait for automated peer update",
            `state ${row.state}`,
            `driver ${peer.driver ?? "claude-sdk"}`,
            `model ${peer.model ?? "-"}`,
            modelNote,
            promptSizeNote,
          ].filter(Boolean).join("\n\n"),
        }],
        details: { peerName: name, state: row.state, sessionId: peer.sessionId, driver: peer.driver, model: peer.model, requestedModel: model, modelNote, promptSizeNote, cwd: peer.cwd, message, deliveryState: "delivered_and_running" },
      };
    },
  });

  pi.registerTool({
    name: "peer_interrupt",
    label: "Interrupt Peer",
    description: "Gracefully interrupt a running peer without forgetting its registry entry.",
    promptSnippet: PEER_INTERRUPT_TOOL_PROMPT.snippet,
    promptGuidelines: PEER_INTERRUPT_TOOL_PROMPT.guidelines,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Peer name." },
      },
      required: ["name"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await activatePeerMode(ctx, { command: "peer_interrupt", reason: "Peer mode activated" });
      const input = params as { name?: unknown };
      const name = String(input.name ?? "").trim();
      if (!name) {
        throw new Error("name required");
      }

      const peer = await bridge.interrupt(name);
      peerNameCache.add(name);
      const { row } = await syncPeerRelaySnapshot(peer);
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peer interrupted: ${name}`);
      sendCommandMessage(pi, {
        level: "warning",
        command: "peer_interrupt",
        title: `Peer interrupted: ${name}`,
        body: [`state ${row.state}`, `session ${peer.sessionId}`].join("\n"),
      });
      return {
        content: [{
          type: "text",
          text: [`Peer interrupted: ${name}`, `state ${row.state}`, `session ${peer.sessionId}`].join("\n\n"),
        }],
        details: { peerName: name, state: row.state, sessionId: peer.sessionId, driver: peer.driver, model: peer.model, cwd: peer.cwd },
      };
    },
  });

  pi.registerTool({
    name: "peer_stop",
    label: "Stop Peer",
    description: "Stop a named peer, or stop all peers when explicitly confirmed.",
    promptSnippet: PEER_STOP_TOOL_PROMPT.snippet,
    promptGuidelines: PEER_STOP_TOOL_PROMPT.guidelines,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Peer name. Optional when using all=true." },
        all: { type: "boolean", description: "Stop all peers instead of one named peer. Requires confirmAll=true." },
        confirmAll: { type: "boolean", description: "Required safety confirmation when all=true." },
      },
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await activatePeerMode(ctx, { command: "peer_stop", reason: "Peer mode activated" });
      const input = params as { name?: unknown; all?: unknown; confirmAll?: unknown };
      const name = String(input.name ?? "").trim();
      const stopAll = input.all === true;
      const confirmAll = input.confirmAll === true;

      if (stopAll) {
        if (!confirmAll) {
          throw new Error("Stopping all peers requires confirmAll=true");
        }
        const peers = await bridge.listPeers();
        if (peers.length === 0) {
          return {
            content: [{ type: "text", text: "No peers to stop." }],
            details: { stoppedPeers: [], count: 0 },
          };
        }

        const stoppedPeers = [] as Array<{ peerName: string; state: string; sessionId: string; driver?: string; model?: string; cwd: string }>;
        for (const peer of peers) {
          const stopped = await bridge.stop(peer.name);
          peerNameCache.delete(peer.name);
          peerRelaySnapshots.delete(peer.name);
          suppressNextPeerRelay.delete(peer.name);
          stoppedPeers.push({
            peerName: stopped.name,
            state: stopped.state,
            sessionId: stopped.sessionId,
            driver: stopped.driver,
            model: stopped.model,
            cwd: stopped.cwd,
          });
        }
        await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peers stopped: ${stoppedPeers.length}`);
        return {
          content: [{
            type: "text",
            text: [
              `Stopped ${stoppedPeers.length} peer${stoppedPeers.length === 1 ? "" : "s"}.`,
              stoppedPeers.map((peer) => `${peer.peerName}  ${peer.driver ?? runtimeDriverConfig.defaultDriver}  ${peer.state}`).join("\n"),
            ].join("\n\n"),
          }],
          details: { stoppedPeers, count: stoppedPeers.length },
        };
      }

      if (!name) {
        throw new Error("name required unless all=true");
      }

      const peer = await bridge.stop(name);
      peerNameCache.delete(name);
      peerRelaySnapshots.delete(name);
      suppressNextPeerRelay.delete(name);
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peer stopped: ${peer.name}`);
      return {
        content: [{
          type: "text",
          text: [
            `Peer stopped: ${peer.name}`,
            `driver ${peer.driver ?? runtimeDriverConfig.defaultDriver}`,
            `state ${peer.state}`,
            `session ${peer.sessionId}`,
          ].join("\n\n"),
        }],
        details: {
          peerName: peer.name,
          state: peer.state,
          sessionId: peer.sessionId,
          driver: peer.driver,
          model: peer.model,
          cwd: peer.cwd,
        },
      };
    },
  });

  if (showAdvancedCommands) {
    pi.registerTool({
    name: "subagent_run",
    label: "Run Subagent",
    description: "Start a runtime-backed subagent run and return its status or result.",
    promptSnippet: SUBAGENT_RUN_TOOL_PROMPT.snippet,
    promptGuidelines: SUBAGENT_RUN_TOOL_PROMPT.guidelines,
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task for the delegated run." },
        name: { type: "string", description: "Optional agent name for this run." },
        prompt: { type: "string", description: "Optional agent prompt. Defaults to a concise delegated-worker prompt." },
        driver: { type: "string", enum: ["claude-sdk", "codex-cli"], description: "Optional runtime driver for this run." },
        model: { type: "string", description: "Optional model override for this run." },
        cwd: { type: "string", description: "Optional working directory for this run. Relative paths resolve from the current pi working directory." },
        async: { type: "boolean", description: "Launch as background run and return immediately." },
      },
      required: ["task"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await activatePeerMode(ctx, { command: "subagent_run", reason: "Peer mode activated" });
      const input = parseSubagentRunToolInput(params as { task?: unknown; name?: unknown; prompt?: unknown; driver?: unknown; model?: unknown; cwd?: unknown; async?: unknown });
      const effectiveDriver = input.driver ?? runtimeDriverConfig.defaultDriver;
      const modelSelection = resolveRuntimeModelSelection(effectiveDriver, input.model);
      const modelNote = modelSelection.note;
      const promptSizeNote = describePromptSize("subagent task", input.task);

      const run = await subagents.startRun(buildSubagentRunRequest({ ...input, model: modelSelection.runtimeModel }, cwd));
      await syncAttentionLedger();
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Run ${shortId(run.runId)} ${run.state}`);
      return {
        content: [{
          type: "text",
          text: [
            `Run ${run.state}: ${shortId(run.runId)}`,
            `agent ${run.agentName}`,
            `driver ${run.driver ?? runtimeDriverConfig.defaultDriver}`,
            modelNote,
            promptSizeNote,
            `state ${run.state}`,
            `cwd ${run.cwd}`,
            run.sessionId ? `session ${run.sessionId}` : undefined,
            run.result?.summary ? `summary\n${formatQuotedTextBlock(truncate(run.result.summary, 4000))}` : undefined,
          ].filter(Boolean).join("\n\n"),
        }],
        details: {
          runId: run.runId,
          agentName: run.agentName,
          driver: run.driver,
          model: run.model,
          requestedModel: input.model,
          modelNote,
          promptSizeNote,
          state: run.state,
          cwd: run.cwd,
          sessionId: run.sessionId,
          async: input.async,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagent Runs",
    description: "List known local subagent runs with driver and state.",
    promptSnippet: SUBAGENT_LIST_TOOL_PROMPT.snippet,
    promptGuidelines: SUBAGENT_LIST_TOOL_PROMPT.guidelines,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      await activatePeerMode(ctx, { command: "subagent_list", reason: "Peer mode activated" });
      const runs = await subagents.listRuns();
      const attentionViews = listAttentionViews(attentionLedger, runs, Date.now());
      const attentionByRunId = new Map(attentionViews.map((view) => [view.run.runId, describeAttentionState(view, Date.now())]));
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Runs · ${runs.length}`);
      return {
        content: [{
          type: "text",
          text: runs.length > 0
            ? runs.map((run) => {
              const attention = attentionByRunId.get(run.runId);
              return `${shortId(run.runId)}  ${run.state}${attention ? `  [${attention}]` : ""}  ${run.driver ?? "-"}  ${run.agentName}`;
            }).join("\n")
            : "No runs found.",
        }],
        details: {
          runs: runs.map((run) => ({
            runId: run.runId,
            state: run.state,
            driver: run.driver,
            agentName: run.agentName,
            cwd: run.cwd,
            sessionId: run.sessionId,
            note: run.note,
          })),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_status",
    label: "Subagent Status",
    description: "Show status for one local subagent run.",
    promptSnippet: SUBAGENT_STATUS_TOOL_PROMPT.snippet,
    promptGuidelines: SUBAGENT_STATUS_TOOL_PROMPT.guidelines,
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Subagent run id." },
      },
      required: ["runId"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await activatePeerMode(ctx, { command: "subagent_status", reason: "Peer mode activated" });
      const input = params as { runId?: unknown };
      const runId = String(input.runId ?? "").trim();
      if (!runId) {
        throw new Error("runId required");
      }

      const resolvedRunId = resolveSubagentRunId(runId, await subagents.listRuns());
      const run = await subagents.statusRun(resolvedRunId);
      if (!run) {
        throw new Error(`Unknown run ${runId}`);
      }

      await syncAttentionLedger();
      const attentionView = listAttentionViews(attentionLedger, [run], Date.now())[0];
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Run ${shortId(run.runId)} ${run.state}`);
      return {
        content: [{
          type: "text",
          text: [
            `Run ${shortId(run.runId)} · ${run.state}`,
            `agent ${run.agentName}`,
            `driver ${run.driver ?? runtimeDriverConfig.defaultDriver}`,
            `cwd ${run.cwd}`,
            run.sessionId ? `session ${run.sessionId}` : undefined,
            attentionView ? `attention ${describeAttentionState(attentionView, Date.now())}` : undefined,
            run.note ? `note\n${formatQuotedTextBlock(run.note)}` : undefined,
            run.result?.summary ? `summary\n${formatQuotedTextBlock(truncate(run.result.summary, 4000))}` : undefined,
          ].filter(Boolean).join("\n\n"),
        }],
        details: {
          runId: run.runId,
          state: run.state,
          driver: run.driver,
          agentName: run.agentName,
          cwd: run.cwd,
          sessionId: run.sessionId,
          note: run.note,
          summary: run.result?.summary,
        },
      };
    },
  });

  pi.registerTool({
    name: "team_spawn",
    label: "Spawn Teammate",
    description: "Spawn a persistent local teammate backed by the runtime bridge.",
    promptSnippet: TEAM_SPAWN_TOOL_PROMPT.snippet,
    promptGuidelines: TEAM_SPAWN_TOOL_PROMPT.guidelines,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Teammate name." },
        prompt: { type: "string", description: "Teammate bootstrap prompt." },
        driver: { type: "string", enum: ["claude-sdk", "codex-cli"], description: "Optional runtime driver for this teammate." },
        model: { type: "string", description: "Optional model override." },
        cwd: { type: "string", description: "Optional working directory. Relative paths resolve from the current pi working directory." },
      },
      required: ["name", "prompt"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await activatePeerMode(ctx, { command: "team_spawn", reason: "Peer mode activated" });
      const input = parseTeamSpawnToolInput(params as { name?: unknown; prompt?: unknown; driver?: unknown; model?: unknown; cwd?: unknown });
      const effectiveDriver = input.driver ?? runtimeDriverConfig.defaultDriver;
      const modelSelection = resolveRuntimeModelSelection(effectiveDriver, input.model);
      const modelNote = modelSelection.note;
      const promptSizeNote = describePromptSize("teammate prompt", input.prompt);

      if (!noSessionMode) {
        await ensureIntercomTransportHealthy(false);
      }
      const teammate = await teams.spawnTeammate(buildTeamSpawnRequest({ ...input, model: modelSelection.runtimeModel }, cwd));
      suppressNextPeerRelay.add(teammate.name);
      peerNameCache.add(teammate.name);
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Team + ${teammate.name}`);
      return {
        content: [{
          type: "text",
          text: [
            `Teammate spawned: ${teammate.name}`,
            `driver ${teammate.driver ?? runtimeDriverConfig.defaultDriver}`,
            modelNote,
            promptSizeNote,
            `state ${teammate.state}`,
            `cwd ${teammate.cwd}`,
            `session ${teammate.sessionId ?? "-"}`,
          ].filter(Boolean).join("\n\n"),
        }],
        details: { ...teammate, requestedModel: input.model, modelNote, promptSizeNote },
      };
    },
  });

  pi.registerTool({
    name: "team_task",
    label: "Assign Team Task",
    description: "Assign a task to a persistent teammate and wait for the reply.",
    promptSnippet: TEAM_TASK_TOOL_PROMPT.snippet,
    promptGuidelines: TEAM_TASK_TOOL_PROMPT.guidelines,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Teammate name." },
        title: { type: "string", description: "Task title." },
        details: { type: "string", description: "Task details." },
      },
      required: ["name", "title", "details"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await activatePeerMode(ctx, { command: "team_task", reason: "Peer mode activated" });
      const input = params as { name?: unknown; title?: unknown; details?: unknown };
      const name = String(input.name ?? "").trim();
      const title = String(input.title ?? "").trim();
      const details = String(input.details ?? "").trim();
      if (!name || !title || !details) {
        throw new Error("name, title, and details required");
      }

      suppressNextPeerRelay.delete(name);
      const task = await teams.assignTask({ assignee: name, title, details });
      const teammate = await teams.teammateStatus(name);
      const peer = await bridge.status(name);
      if (peer) {
        await syncPeerRelaySnapshot(peer);
      }
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Task ${shortId(task.taskId)} ${task.state}`);
      return {
        content: [{
          type: "text",
          text: [
            `Task ${task.state}: ${shortId(task.taskId)}`,
            `${task.assignee} · ${task.title}`,
            `driver ${teammate?.driver ?? runtimeDriverConfig.defaultDriver}`,
            task.lastReply ? `reply\n${formatQuotedTextBlock(truncate(task.lastReply, 4000))}` : undefined,
          ].filter(Boolean).join("\n\n"),
        }],
        details: { task, teammate },
      };
    },
  });

  pi.registerTool({
    name: "team_message",
    label: "Message Teammate",
    description: "Send a direct message to a persistent teammate and wait for the reply.",
    promptSnippet: TEAM_MESSAGE_TOOL_PROMPT.snippet,
    promptGuidelines: TEAM_MESSAGE_TOOL_PROMPT.guidelines,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Teammate name." },
        message: { type: "string", description: "Direct message to send." },
      },
      required: ["name", "message"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await activatePeerMode(ctx, { command: "team_message", reason: "Peer mode activated" });
      const input = params as { name?: unknown; message?: unknown };
      const name = String(input.name ?? "").trim();
      const message = String(input.message ?? "").trim();
      if (!name || !message) {
        throw new Error("name and message required");
      }

      suppressNextPeerRelay.delete(name);
      const result = await teams.sendMessage(name, message);
      const peer = await bridge.status(name);
      if (peer) {
        await syncPeerRelaySnapshot(peer);
      }
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Team ← ${result.teammate.name}`);
      return {
        content: [{
          type: "text",
          text: [
            `Teammate reply: ${result.teammate.name}`,
            `driver ${result.teammate.driver ?? runtimeDriverConfig.defaultDriver}`,
            `quoted teammate message\n${formatQuotedTextBlock(truncate(result.reply, 4000) || "<empty reply>")}`,
          ].join("\n\n"),
        }],
        details: { teammate: result.teammate, reply: result.reply },
      };
    },
  });

  pi.registerTool({
    name: "team_list",
    label: "List Team State",
    description: "List retained teammates and task records.",
    promptSnippet: TEAM_LIST_TOOL_PROMPT.snippet,
    promptGuidelines: TEAM_LIST_TOOL_PROMPT.guidelines,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      await activatePeerMode(ctx, { command: "team_list", reason: "Peer mode activated" });
      const teammates = await teams.listTeammates();
      const tasks = await teams.listTasks();
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Team/Todo · ${teammates.length}/${tasks.length}`);
      return {
        content: [{
          type: "text",
          text: [
            "Teammates",
            teammates.length > 0 ? teammates.map((teammate) => `${teammate.name}  ${teammate.state}  ${teammate.driver ?? "-"}`).join("\n") : "No teammates.",
            "",
            "Tasks",
            tasks.length > 0 ? tasks.map((task) => `${shortId(task.taskId)}  ${task.state}  ${task.assignee}  ${task.title}`).join("\n") : "No tasks.",
          ].join("\n"),
        }],
        details: { teammates, tasks },
      };
    },
  });

  pi.registerTool({
    name: "team_stop",
    label: "Stop Teammate",
    description: "Stop a persistent teammate.",
    promptSnippet: TEAM_STOP_TOOL_PROMPT.snippet,
    promptGuidelines: TEAM_STOP_TOOL_PROMPT.guidelines,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Teammate name." },
      },
      required: ["name"],
      additionalProperties: false,
    } as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await activatePeerMode(ctx, { command: "team_stop", reason: "Peer mode activated" });
      const input = params as { name?: unknown };
      const name = String(input.name ?? "").trim();
      if (!name) {
        throw new Error("name required");
      }

      suppressNextPeerRelay.delete(name);
      const teammate = await teams.stopTeammate(name);
      peerNameCache.delete(name);
      peerRelaySnapshots.delete(name);
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Team - ${teammate.name}`);
      return {
        content: [{
          type: "text",
          text: [
            `Teammate stopped: ${teammate.name}`,
            `driver ${teammate.driver ?? runtimeDriverConfig.defaultDriver}`,
            `state ${teammate.state}`,
          ].join("\n\n"),
        }],
        details: teammate,
      };
    },
  });
  }

  pi.on("session_start", async (event, ctx) => {
    if (peerModeActive) {
      await activatePeerMode(ctx, { reason: `${startupSummary} (${event.reason})` });
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger);
      ctx.ui.notify(`${startupSummary} (${event.reason})`, "info");
    }
  });

  pi.on("session_shutdown", async () => {
    dashboardContextRef = undefined;
    operatorContextRef = undefined;
    lastWidgetSignature = undefined;
    peerRelaySnapshots.clear();
    suppressNextPeerRelay.clear();
    peerModeActive = false;
    peerGuideShown = false;
    runtimeDriverFallbackShown = false;
    if (backgroundMonitorTimer) {
      clearInterval(backgroundMonitorTimer);
      backgroundMonitorTimer = undefined;
    }
    await bridge.close();
    intercomTransport = undefined;
    intercomReachable = undefined;
    await persistAttentionLedger();
    attentionLedger = createAttentionLedger();
    persistedAttentionLedger = serializeAttentionLedger(attentionLedger);
  });

  async function handleDashboardCommand(args: string, ctx: ExtensionCommandContext, command: string): Promise<void> {
    await activatePeerMode(ctx, { command, reason: "Peer mode activated" });
    const advanced = args.trim().toLowerCase() === "advanced";
    await syncAttentionLedger();
    const data = await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger);
    const health = getPeerFirstHealth(data.snapshot.peerRows, data.snapshot.transportDegraded);
    const advancedDiagnosticsWarning = data.snapshot.runIssues > 0
      || data.snapshot.runAttention > 0
      || data.snapshot.teammateIssues > 0
      || data.snapshot.taskIssues > 0;
    sendCommandMessage(pi, {
      level: health === "warning" || (advanced && advancedDiagnosticsWarning) ? "warning" : "info",
      command,
      title: advanced ? "Peer dashboard · advanced" : "Peer dashboard",
      body: advanced ? formatAdvancedDashboardReport(data) : formatPeerFirstDashboardReport(data),
      surface: "custom",
    });
  }

  async function handlePeerStartCommand(args: string, ctx: ExtensionCommandContext, command: string): Promise<void> {
    const parsed = parsePeerStartCommandInput(args);
    if (!parsed.prompt || hasPlaceholderToken(parsed.name, parsed.prompt)) {
      showUsage(pi, command, [
        `/${command} <prompt>`,
        `/${command} <prompt> | <driver> | <model>`,
        `/${command} <name> | <prompt>`,
        `/${command} <name> | <prompt> | <driver> | <model>`,
        `Example: /${command} Review auth flow and reply briefly.`,
        `Example: /${command} reviewer | You are a brief worker. Reply briefly.`,
      ].join("\n"));
      return;
    }
    await activatePeerMode(ctx, { command, reason: "Peer mode activated" });

    const existingNames = new Set((await bridge.listPeers()).map((peer) => peer.name));
    const name = parsed.name ?? derivePeerName(parsed.prompt, existingNames);
    const effectiveDriver = parsed.driver ?? runtimeDriverConfig.defaultDriver;
    const modelSelection = resolveRuntimeModelSelection(effectiveDriver, parsed.model);
    const modelNote = modelSelection.note;
    const promptSizeNote = describePromptSize("peer prompt", parsed.prompt);

    sendCommandMessage(pi, {
      level: "info",
      command,
      title: `Starting peer: ${name}`,
      body: [
        parsed.autoNamed ? `auto-named from prompt\n\n${truncate(parsed.prompt, 160)}` : "Watch Peers widget for live activity.",
        parsed.driver ? `driver ${parsed.driver}` : undefined,
        modelNote,
        promptSizeNote,
      ].filter(Boolean).join("\n\n"),
    });

    if (!noSessionMode) {
      await ensureIntercomTransportHealthy(false);
    }
    const peer = await startPeerWithoutWaiting({
      name,
      prompt: parsed.prompt,
      driver: parsed.driver,
      model: modelSelection.runtimeModel,
      cwd,
      permissionMode: "bypassPermissions",
    });
    peerNameCache.add(peer.name);
    const { row } = await syncPeerRelaySnapshot(peer);
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peer started: ${peer.name}`);
    sendCommandMessage(pi, {
      level: "success",
      command,
      title: `Peer started: ${peer.name}`,
      body: [
        parsed.autoNamed ? `auto-name ${peer.name}` : undefined,
        `state ${row.state}`,
        `driver ${peer.driver ?? "claude-sdk"}`,
        modelNote,
        promptSizeNote,
        `session ${peer.sessionId}`,
        "",
        PEER_NO_BABYSITTING_GUIDANCE,
      ].filter((line) => line !== undefined).join("\n"),
    });
  }

  async function handlePeerListCommand(ctx: ExtensionCommandContext, command: string): Promise<void> {
    await activatePeerMode(ctx, { command, reason: "Peer mode activated" });
    const data = await collectDashboardData(runtime, bridge, subagents, teams, dashboardState, attentionLedger);
    syncNameCache(peerNameCache, data.peers.map((peer) => peer.name));
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peers · ${data.peers.length}`, data);
    sendCommandMessage(pi, {
      level: data.snapshot.peerRows.some((row) => ["error", "offline", "waiting"].includes(row.state)) ? "warning" : "info",
      command,
      title: `Peers (${data.peers.length})`,
      body: formatPeerList(data.snapshot.peerRows),
      surface: "custom",
    });
  }

  async function handlePeerModelsCommand(args: string, ctx: ExtensionCommandContext, command: string): Promise<void> {
    await activatePeerMode(ctx, { command, reason: "Peer mode activated" });
    const { driver, verbose } = parsePeerModelsArgs(args);
    const catalogs = modelCatalogsForDriver(driver);
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, "Runtime models");
    sendCommandMessage(pi, {
      level: "info",
      command,
      title: driver ? `Runtime models: ${driver}` : "Runtime models",
      body: formatModelCatalogReport(catalogs, { verbose }),
      surface: "custom",
    });
  }

  async function handlePeerAskCommand(args: string, ctx: ExtensionCommandContext, command: string): Promise<void> {
    const [name, message] = splitArgs(args, 2);
    if (!name || !message || hasPlaceholderToken(name, message)) {
      showUsage(pi, command, [
        `/${command} <name> | <message>`,
        `Example: /${command} worker1 | Reply with exactly: peer-ok`,
      ].join("\n"));
      return;
    }
    await activatePeerMode(ctx, { command, reason: "Peer mode activated" });

    sendCommandMessage(pi, {
      level: "info",
      command,
      title: `Sent to peer: ${name}`,
      body: formatQuotedTextBlock(truncate(message, 4_000)),
    });

    suppressNextPeerRelay.delete(name);
    const result = await bridge.ask(name, {
      from: "pi-user",
      text: message,
    });
    peerNameCache.add(name);
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peer replied: ${name}`);
    sendCommandMessage(pi, {
      level: result.runState === "failed" ? "error" : result.runState === "interrupted" ? "warning" : "success",
      command,
      title: `Peer reply: ${name}`,
      body: [`driver ${result.peer.driver ?? "claude-sdk"}`, truncate(result.reply, 1200) || "<empty reply>"].join("\n\n"),
    });
  }

  async function handlePeerSendCommand(args: string, ctx: ExtensionCommandContext, command: string): Promise<void> {
    const [name, message] = splitArgs(args, 2);
    if (!name || !message || hasPlaceholderToken(name, message)) {
      showUsage(pi, command, [
        `/${command} <name> | <message>`,
        `Example: /${command} worker1 | Continue with the next batch and report back when done.`,
      ].join("\n"));
      return;
    }
    await activatePeerMode(ctx, { command, reason: "Peer mode activated" });

    sendCommandMessage(pi, {
      level: "info",
      command,
      title: `Sent to peer: ${name}`,
      body: formatQuotedTextBlock(truncate(message, 4_000)),
    });

    suppressNextPeerRelay.delete(name);
    const peer = await bridge.send(name, {
      from: "pi-user",
      text: message,
    }, { waitForIdle: false });
    peerNameCache.add(name);
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peer message sent: ${name}`);
    sendCommandMessage(pi, {
      level: "success",
      command,
      title: `Peer message delivered: ${name}`,
      body: [
        "delivery delivered_and_running",
        "Do not poll; wait for the automated peer update.",
        `state ${peer.state}`,
        `driver ${peer.driver ?? "claude-sdk"}`,
        `session ${peer.sessionId}`,
      ].join("\n"),
    });
  }

  async function handlePeerHistoryCommand(args: string, ctx: ExtensionCommandContext, command: string): Promise<void> {
    const [name, cursorToken, limitToken] = args.trim().split(/\s+/, 3).filter(Boolean);
    const cursor = cursorToken == null ? undefined : Number(cursorToken);
    const limit = limitToken == null ? undefined : Number(limitToken);
    if (!name || hasPlaceholderToken(name)) {
      showUsage(pi, command, [
        `/${command} <name> [cursor] [limit]`,
        `Example: /${command} worker1`,
        `Example: /${command} worker1 0 20`,
      ].join("\n"));
      return;
    }
    if (cursor != null && (!Number.isFinite(cursor) || cursor < 0)) {
      throw new Error("cursor must be a non-negative number");
    }
    if (limit != null && (!Number.isFinite(limit) || limit <= 0)) {
      throw new Error("limit must be a positive number");
    }
    await activatePeerMode(ctx, { command, reason: "Peer mode activated" });

    const target = await resolvePeerHistoryTarget(name);
    if (!target) {
      throw new Error(`Unknown peer ${name}`);
    }
    const transcript = await runtime.readTranscript(target.sessionId);
    const page = formatPeerHistoryPage(transcript.items, {
      cursor: cursor == null ? undefined : Math.trunc(cursor),
      limit: limit == null ? undefined : Math.trunc(limit),
    });
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peer history: ${name}`);
    sendCommandMessage(pi, {
      level: "info",
      command,
      title: `Peer history: ${name}`,
      body: [
        `state ${target.state}`,
        `driver ${target.driver ?? "-"}`,
        `model ${target.model ?? "-"}`,
        `session ${target.sessionId}`,
        `cursor ${page.startCursor}..${page.endCursor} of ${page.total}`,
        `previousCursor ${page.previousCursor ?? "-"}`,
        `nextCursor ${page.nextCursor ?? "-"}`,
        `history\n${formatQuotedTextBlock(page.text)}`,
      ].join("\n\n"),
      surface: "custom",
    });
  }

  async function handlePeerInterruptCommand(args: string, ctx: ExtensionCommandContext, command: string): Promise<void> {
    const name = args.trim();
    if (!name || hasPlaceholderToken(name)) {
      showUsage(pi, command, [
        `/${command} <name>`,
        `Example: /${command} worker1`,
      ].join("\n"));
      return;
    }
    await activatePeerMode(ctx, { command, reason: "Peer mode activated" });

    const peer = await bridge.interrupt(name);
    suppressNextPeerRelay.delete(name);
    peerNameCache.add(name);
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peer interrupted: ${peer.name}`);
    sendCommandMessage(pi, {
      level: "warning",
      command,
      title: `Peer interrupted: ${peer.name}`,
      body: [`state ${peer.state}`, `session ${peer.sessionId}`].join("\n"),
    });
  }

  async function handlePeerStopCommand(args: string, ctx: ExtensionCommandContext, command: string): Promise<void> {
    await activatePeerMode(ctx, { command, reason: "Peer mode activated" });
    const trimmed = args.trim();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const stopAll = tokens.includes("--all");
    const confirmAll = tokens.includes("--confirm");

    if (stopAll) {
      const peers = await bridge.listPeers();
      if (peers.length === 0) {
        sendCommandMessage(pi, {
          level: "info",
          command,
          title: "No peers to stop",
        });
        return;
      }
      if (!confirmAll) {
        showUsage(pi, command, [
          "This stops all retained peers in this workspace.",
          `Peers: ${peers.map((peer) => peer.name).join(", ")}`,
          `/${command} --all --confirm`,
        ].join("\n"));
        return;
      }

      const stopped: string[] = [];
      for (const peer of peers) {
        await bridge.stop(peer.name);
        peerNameCache.delete(peer.name);
        peerRelaySnapshots.delete(peer.name);
        suppressNextPeerRelay.delete(peer.name);
        stopped.push(peer.name);
      }
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peers stopped: ${stopped.length}`);
      sendCommandMessage(pi, {
        level: "warning",
        command,
        title: `Stopped ${stopped.length} peer${stopped.length === 1 ? "" : "s"}`,
        body: stopped.join("\n"),
      });
      return;
    }

    const name = trimmed;
    if (!name || hasPlaceholderToken(name)) {
      showUsage(pi, command, [
        `/${command} <name>`,
        `/${command} --all --confirm`,
        `Example: /${command} worker1`,
      ].join("\n"));
      return;
    }

    const peer = await bridge.stop(name);
    peerNameCache.delete(name);
    peerRelaySnapshots.delete(name);
    suppressNextPeerRelay.delete(name);
    await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Peer stopped: ${peer.name}`);
    sendCommandMessage(pi, {
      level: "warning",
      command,
      title: `Peer stopped: ${peer.name}`,
      body: `state ${peer.state}`,
    });
  }

  function showPeerUsage(command: string): void {
    sendCommandMessage(pi, {
      level: "info",
      command,
      title: "Peer help",
      body: [
        `${EXTENSION_NAME} v${EXTENSION_VERSION}`,
        "",
        "Concepts",
        "- Peers are long-lived local runtime sessions, not stateless provider calls.",
        "- Start peers for background work, then keep working while the widget and automatic relays surface updates.",
        "- Use ask when you need a reply now; use send for fire-and-forget work.",
        "- Use history to inspect a peer transcript without repeatedly polling for completion.",
        "- The live intercom broker is optional. When it is offline, peers stay local.",
        "",
        "Common flow",
        `1. /${command} init`,
        `2. /${command} models`,
        `3. /${command} start <prompt>`,
        `4. /${command} dashboard`,
        `5. /${command} history <name>`,
        "",
        "Commands",
        `/${command} or /${command} dashboard`,
        `/${command} about`,
        `/${command} init`,
        `/${command} dashboard advanced`,
        `/${command} start <prompt>`,
        `/${command} start <prompt> | <driver> | <model>`,
        `/${command} start <name> | <prompt>`,
        `/${command} start <name> | <prompt> | <driver> | <model>`,
        `/${command} ask <name> | <message>`,
        `/${command} send <name> | <message>`,
        `/${command} list`,
        `/${command} models [claude-sdk|codex-cli] [all|advanced|verbose]`,
        `/${command} history <name> [cursor] [limit]`,
        `/${command} interrupt <name>`,
        `/${command} stop <name>`,
        `/${command} stop --all --confirm`,
        "",
        "Driver/model forms",
        `/${command} start <prompt> | <driver> | <model>`,
        `/${command} start <name> | <prompt> | <driver> | <model>`,
        "drivers: claude-sdk, codex-cli",
        "model aliases: sonnet, opus, haiku, mini, spark; exact ids are shown by /peer models",
        "",
        "Version/environment",
        `/${command} about`,
      ].join("\n"),
      surface: "custom",
    });
  }

  function showPeerAbout(command: string): void {
    sendCommandMessage(pi, {
      level: "info",
      command,
      title: `${EXTENSION_NAME} v${EXTENSION_VERSION}`,
      body: [
        `package ${EXTENSION_NAME}`,
        `version ${EXTENSION_VERSION}`,
        `package root ${EXTENSION_PACKAGE_ROOT}`,
        `state root ${rootDir}`,
        `default driver ${runtimeDriverConfig.defaultDriver}`,
        runtimeDriverConfig.note,
        `no-session ${noSessionMode ? "yes" : "no"}`,
      ].filter(Boolean).join("\n"),
      surface: "custom",
    });
  }

  registerExtensionCommand(pi, "peer", "Peer dashboard and controls. Args: [about|init|dashboard|start|ask|send|list|models|history|interrupt|stop] ...", async (args, ctx) => {
    const trimmed = args.trim();
    if (!trimmed) {
      await activatePeerMode(ctx, { command: "peer", showGuide: true, reason: "Peer mode activated" });
      await handleDashboardCommand("", ctx, "peer");
      return;
    }

    const [subcommandRaw = "", ...restParts] = trimmed.split(/\s+/);
    const subcommand = subcommandRaw.toLowerCase();
    const rest = restParts.join(" ").trim();

    switch (subcommand) {
      case "about":
      case "version":
      case "--version":
      case "-v":
        showPeerAbout("peer about");
        return;
      case "init":
        await activatePeerMode(ctx, { command: "peer init", showGuide: true, forceGuide: true, reason: "Peer mode activated" });
        await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger);
        return;
      case "dashboard":
        await activatePeerMode(ctx, { command: "peer dashboard", showGuide: true, reason: "Peer mode activated" });
        await handleDashboardCommand(rest, ctx, "peer dashboard");
        return;
      case "start":
        await activatePeerMode(ctx, { command: "peer start", showGuide: true, reason: "Peer mode activated" });
        await handlePeerStartCommand(rest, ctx, "peer start");
        return;
      case "ask":
        await activatePeerMode(ctx, { command: "peer ask", showGuide: true, reason: "Peer mode activated" });
        await handlePeerAskCommand(rest, ctx, "peer ask");
        return;
      case "send":
        await activatePeerMode(ctx, { command: "peer send", showGuide: true, reason: "Peer mode activated" });
        await handlePeerSendCommand(rest, ctx, "peer send");
        return;
      case "list":
        await activatePeerMode(ctx, { command: "peer list", showGuide: true, reason: "Peer mode activated" });
        await handlePeerListCommand(ctx, "peer list");
        return;
      case "models":
        await activatePeerMode(ctx, { command: "peer models", showGuide: true, reason: "Peer mode activated" });
        await handlePeerModelsCommand(rest, ctx, "peer models");
        return;
      case "history":
        await activatePeerMode(ctx, { command: "peer history", showGuide: true, reason: "Peer mode activated" });
        await handlePeerHistoryCommand(rest, ctx, "peer history");
        return;
      case "interrupt":
        await activatePeerMode(ctx, { command: "peer interrupt", showGuide: true, reason: "Peer mode activated" });
        await handlePeerInterruptCommand(rest, ctx, "peer interrupt");
        return;
      case "stop":
        await activatePeerMode(ctx, { command: "peer stop", showGuide: true, reason: "Peer mode activated" });
        await handlePeerStopCommand(rest, ctx, "peer stop");
        return;
      case "help":
      case "--help":
      case "-h":
        showPeerUsage("peer");
        return;
      default:
        showPeerUsage("peer");
    }
  }, (prefix) => completePeerCommand(prefix, peerNameCache));

  if (showLegacyCommands && showAdvancedCommands) {
    registerExtensionCommand(pi, "claude-dev-ping", `Legacy advanced: proof that ${EXTENSION_NAME} reloaded successfully (set ${LEGACY_COMMANDS_ENV}=1 and ${ADVANCED_COMMANDS_ENV}=1)`, async (_args, ctx) => {
      const sessions = await runtime.list();
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Ping ok · s=${sessions.length}`);
      sendCommandMessage(pi, {
        level: "success",
        command: "claude-dev-ping",
        title: "Ping ok",
        body: `sessions ${sessions.length}`,
      });
    });
  }

  if (showLegacyCommands) {
    registerExtensionCommand(pi, "claude-dashboard", `Legacy: use /peer dashboard instead (set ${LEGACY_COMMANDS_ENV}=1 to enable)`, (args, ctx) => handleDashboardCommand(args, ctx, "claude-dashboard"));
    registerExtensionCommand(pi, "claude-peer-start", `Legacy: use /peer start instead (set ${LEGACY_COMMANDS_ENV}=1 to enable)`, (args, ctx) => handlePeerStartCommand(args, ctx, "claude-peer-start"));
    registerExtensionCommand(pi, "claude-peer-list", `Legacy: use /peer list instead (set ${LEGACY_COMMANDS_ENV}=1 to enable)`, (_args, ctx) => handlePeerListCommand(ctx, "claude-peer-list"));
    registerExtensionCommand(pi, "claude-peer-ask", `Legacy: use /peer ask instead (set ${LEGACY_COMMANDS_ENV}=1 to enable)`, (args, ctx) => handlePeerAskCommand(args, ctx, "claude-peer-ask"), (prefix) => completePeerName(prefix, peerNameCache, true));
    registerExtensionCommand(pi, "claude-peer-send", `Legacy: use /peer send instead (set ${LEGACY_COMMANDS_ENV}=1 to enable)`, (args, ctx) => handlePeerSendCommand(args, ctx, "claude-peer-send"), (prefix) => completePeerName(prefix, peerNameCache, true));
    registerExtensionCommand(pi, "claude-peer-interrupt", `Legacy: use /peer interrupt instead (set ${LEGACY_COMMANDS_ENV}=1 to enable)`, (args, ctx) => handlePeerInterruptCommand(args, ctx, "claude-peer-interrupt"), (prefix) => completePeerName(prefix, peerNameCache, false));
    registerExtensionCommand(pi, "claude-peer-stop", `Legacy: use /peer stop instead (set ${LEGACY_COMMANDS_ENV}=1 to enable)`, (args, ctx) => handlePeerStopCommand(args, ctx, "claude-peer-stop"), (prefix) => completePeerName(prefix, peerNameCache, false));
    registerExtensionCommand(pi, "claude-peer-stop-all", `Legacy: use /peer stop --all --confirm instead (set ${LEGACY_COMMANDS_ENV}=1 to enable)`, async (args, ctx) => {
      const converted = args.trim() === "--yes" ? "--all --confirm" : "--all";
      await handlePeerStopCommand(converted, ctx, "claude-peer-stop-all");
    });
  }

  if (showLegacyCommands && showAdvancedCommands) {
    registerExtensionCommand(pi, "claude-subagent-run", `Legacy advanced: run Claude subagent job. Args: <task> or <driver> | <task> (set ${LEGACY_COMMANDS_ENV}=1 and ${ADVANCED_COMMANDS_ENV}=1)`, async (args, ctx) => {
      const parsed = parseSubagentRunCommandInput(args);
      if (!parsed.task) {
        showUsage(pi, "claude-subagent-run", [
          "/claude-subagent-run <task>",
          "/claude-subagent-run <driver> | <task>",
          "Example: /claude-subagent-run codex-cli | Reply with exactly: subagent-ok",
        ].join("\n"));
        return;
      }

      const run = await subagents.startRun({
        agent: {
          name: "claude-subagent",
          runner: "claude-code-agent",
          prompt: "You are delegated worker. Be concise and execution-focused.",
          cwd,
        },
        task: parsed.task,
        driver: parsed.driver,
      });
      await syncAttentionLedger();
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Run ${shortId(run.runId)} ${run.state}`);
      sendCommandMessage(pi, {
        level: runStateLevel(run.state),
        command: "claude-subagent-run",
        title: `Run ${run.state}: ${shortId(run.runId)}`,
        body: [
          `agent ${run.agentName}`,
          `driver ${run.driver ?? runtimeDriverConfig.defaultDriver}`,
          `state ${run.state}`,
          run.result?.summary ? `summary\n${truncate(run.result.summary, 1200)}` : undefined,
        ].filter(Boolean).join("\n\n"),
      });
    });

    registerExtensionCommand(pi, "claude-subagent-list", `Advanced: list Claude subagent runs (set ${LEGACY_COMMANDS_ENV}=1 and ${ADVANCED_COMMANDS_ENV}=1)`, async (_args, ctx) => {
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
            return `${shortId(run.runId)}  ${run.state}${attention ? `  [${attention}]` : ""}  ${run.driver ?? "-"}  ${run.agentName}`;
          }).join("\n")
          : "No runs found.",
        surface: "custom",
      });
    });

    registerExtensionCommand(pi, "claude-subagent-status", `Advanced: show Claude subagent run status. Args: <runId> (set ${LEGACY_COMMANDS_ENV}=1 and ${ADVANCED_COMMANDS_ENV}=1)`, async (args, ctx) => {
      const runId = args.trim();
      if (!runId) {
        showUsage(pi, "claude-subagent-status", "/claude-subagent-status <runId>");
        return;
      }

      const resolvedRunId = resolveSubagentRunId(runId, await subagents.listRuns());
      const run = await subagents.statusRun(resolvedRunId);
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
          `driver ${run.driver ?? runtimeDriverConfig.defaultDriver}`,
          attentionView ? `attention ${describeAttentionState(attentionView, Date.now())}` : undefined,
          run.note ? `note\n${run.note}` : undefined,
          run.result?.summary ? `summary\n${truncate(run.result.summary, 1200)}` : undefined,
        ].filter(Boolean).join("\n\n"),
        surface: "custom",
      });
    });

    registerExtensionCommand(pi, "claude-attention-list", `Advanced: list runs that currently need attention (set ${LEGACY_COMMANDS_ENV}=1 and ${ADVANCED_COMMANDS_ENV}=1)`, async (_args, ctx) => {
      const attention = await syncAttentionLedger();
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Attention · ${attention.active.length}`);
      sendCommandMessage(pi, {
        level: attention.active.length > 0 ? "warning" : "info",
        command: "claude-attention-list",
        title: `Attention (${attention.active.length})`,
        body: formatAttentionReport(attention.active),
        surface: "custom",
      });
    });

    registerExtensionCommand(pi, "claude-attention-ack", `Advanced: acknowledge noisy attention for a run. Args: <runId-prefix> (set ${LEGACY_COMMANDS_ENV}=1 and ${ADVANCED_COMMANDS_ENV}=1)`, async (args, ctx) => {
      const token = args.trim();
      if (!token) {
        showUsage(pi, "claude-attention-ack", "/claude-attention-ack <runId-prefix>");
        return;
      }

      const attention = await syncAttentionLedger();
      const view = resolveAttentionRun(token, attention.active);
      attentionLedger = acknowledgeAttention(attentionLedger, view.run.runId);
      await persistAttentionLedger();
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Attention ack ${shortId(view.run.runId)}`);
      sendCommandMessage(pi, {
        level: "success",
        command: "claude-attention-ack",
        title: `Acknowledged: ${shortId(view.run.runId)}`,
        body: [view.run.agentName, view.run.note].filter(Boolean).join("\n\n"),
      });
    });

    registerExtensionCommand(pi, "claude-attention-snooze", `Advanced: snooze noisy attention for a run. Args: <runId-prefix> [minutes] (set ${LEGACY_COMMANDS_ENV}=1 and ${ADVANCED_COMMANDS_ENV}=1)`, async (args, ctx) => {
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
      await persistAttentionLedger();
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Attention snoozed ${shortId(view.run.runId)}`);
      sendCommandMessage(pi, {
        level: "success",
        command: "claude-attention-snooze",
        title: `Snoozed: ${shortId(view.run.runId)}`,
        body: `${view.run.agentName}\n\nuntil ${new Date(snoozedUntil).toLocaleTimeString()}`,
      });
    });

    registerExtensionCommand(pi, "claude-team-spawn", `Advanced: spawn Claude teammate. Args: <name> | <prompt> | [driver] (set ${LEGACY_COMMANDS_ENV}=1 and ${ADVANCED_COMMANDS_ENV}=1)`, async (args, ctx) => {
      const parsed = parseTeamSpawnCommandInput(args);
      if (!parsed.name || !parsed.prompt) {
        showUsage(pi, "claude-team-spawn", [
          "/claude-team-spawn <name> | <prompt>",
          "/claude-team-spawn <name> | <prompt> | <driver>",
          "Example: /claude-team-spawn reviewer | You are teammate. Reply briefly. | codex-cli",
        ].join("\n"));
        return;
      }

      if (!noSessionMode) {
        await ensureIntercomTransportHealthy(false);
      }
      const teammate = await teams.spawnTeammate({
        name: parsed.name,
        prompt: parsed.prompt,
        driver: parsed.driver,
        cwd,
      });
      peerNameCache.add(teammate.name);
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Team + ${teammate.name}`);
      sendCommandMessage(pi, {
        level: "success",
        command: "claude-team-spawn",
        title: `Teammate spawned: ${teammate.name}`,
        body: [`driver ${teammate.driver ?? runtimeDriverConfig.defaultDriver}`, `state ${teammate.state}`, `session ${teammate.sessionId ?? "-"}`].join("\n"),
      });
    });

    registerExtensionCommand(pi, "claude-team-task", `Advanced: assign task to Claude teammate. Args: <name> | <title> | <details> (set ${LEGACY_COMMANDS_ENV}=1 and ${ADVANCED_COMMANDS_ENV}=1)`, async (args, ctx) => {
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

    registerExtensionCommand(pi, "claude-team-message", `Advanced: message Claude teammate. Args: <name> | <message> (set ${LEGACY_COMMANDS_ENV}=1 and ${ADVANCED_COMMANDS_ENV}=1)`, async (args, ctx) => {
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

    registerExtensionCommand(pi, "claude-team-list", `Advanced: list Claude teammates and tasks (set ${LEGACY_COMMANDS_ENV}=1 and ${ADVANCED_COMMANDS_ENV}=1)`, async (_args, ctx) => {
      const teammates = await teams.listTeammates();
      const tasks = await teams.listTasks();
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Team/Todo · ${teammates.length}/${tasks.length}`);
      sendCommandMessage(pi, {
        level: teammates.some((teammate) => isProblemState(teammate.state)) || tasks.some((task) => ["blocked", "cancelled"].includes(task.state)) ? "warning" : "info",
        command: "claude-team-list",
        title: `Teammates ${teammates.length} · Tasks ${tasks.length}`,
        body: [
          "Teammates",
          teammates.length > 0 ? teammates.map((teammate) => `${teammate.name}  ${teammate.state}  ${teammate.driver ?? "-"}`).join("\n") : "No teammates.",
          "",
          "Tasks",
          tasks.length > 0 ? tasks.map((task) => `${shortId(task.taskId)}  ${task.state}  ${task.assignee}  ${task.title}`).join("\n") : "No tasks.",
        ].join("\n"),
        surface: "custom",
      });
    });

    registerExtensionCommand(pi, "claude-team-stop", `Advanced: stop Claude teammate. Args: <name> (set ${LEGACY_COMMANDS_ENV}=1 and ${ADVANCED_COMMANDS_ENV}=1)`, async (args, ctx) => {
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

    registerExtensionCommand(pi, "claude-runtime-list", `Advanced: list raw runtime sessions (set ${LEGACY_COMMANDS_ENV}=1 and ${ADVANCED_COMMANDS_ENV}=1)`, async (_args, ctx) => {
      const sessions = await runtime.list();
      await refreshDashboard(ctx, runtime, bridge, subagents, teams, dashboardState, attentionLedger, `Runtime · ${sessions.length}`);
      sendCommandMessage(pi, {
        level: sessions.some((session) => ["failed", "interrupted"].includes(session.state)) ? "warning" : "info",
        command: "claude-runtime-list",
        title: `Runtime sessions (${sessions.length})`,
        body: sessions.length > 0
          ? sessions.map((session) => `${shortId(session.sessionId)}  ${session.state}  ${session.name ?? "-"}`).join("\n")
          : "No runtime sessions.",
        surface: "custom",
      });
    });
  }
}

function registerExtensionCommand(
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
      const previousOperatorContext = operatorContextRef;
      operatorContextRef = ctx;
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
      } finally {
        operatorContextRef = previousOperatorContext;
      }
    },
  });
}

function sendCommandMessage(
  pi: ExtensionAPI,
  input: { level: CommandMessageLevel; title: string; body?: string; command?: string; surface?: CommandMessageSurface },
): void {
  if (input.surface !== "agent") {
    const ctx = operatorContextRef ?? dashboardContextRef;
    if (ctx) {
      ctx.ui.notify(formatOperatorNotification(input), notifyLevel(input.level));
    }
    return;
  }

  pi.sendMessage(
    {
      customType: "peer-command-result",
      content: input.body ?? "",
      display: true,
      details: {
        level: input.level,
        title: input.title,
        command: input.command,
        timestamp: Date.now(),
        surface: input.surface ?? "tool",
      } satisfies CommandMessageDetails,
    },
    { triggerTurn: false },
  );
}

function formatOperatorNotification(input: { title: string; body?: string; command?: string }): string {
  const parts = [`[peer] ${input.title}`];
  if (input.body?.trim()) {
    parts.push(input.body.trim());
  }
  if (input.command) {
    parts.push(`/${input.command}`);
  }
  return parts.join("\n\n");
}

function notifyLevel(level: CommandMessageLevel): "info" | "warning" | "error" {
  if (level === "error") {
    return "error";
  }
  if (level === "warning") {
    return "warning";
  }
  return "info";
}

function showPeerInitUserHelp(ctx: ExtensionContext | ExtensionCommandContext): void {
  ctx.ui.notify(`[peer] ${PEER_INIT_USER_HELP}`, "warning");
}

function showUsage(pi: ExtensionAPI, command: string, usage: string): void {
  sendCommandMessage(pi, {
    level: "warning",
    command,
    title: `Usage: /${command}`,
    body: usage,
    surface: "custom",
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
  preCollected?: DashboardData,
): Promise<DashboardData> {
  dashboardContextRef = ctx;
  if (lastEvent) {
    recordDashboardEvent(state, lastEvent);
  } else {
    recordDashboardRefresh(state);
  }

  const data = preCollected ?? await collectDashboardData(runtime, bridge, subagents, teams, state, attentionLedger);

  if (!process.argv.includes("--no-session")) {
    ctx.ui.setStatus(EXTENSION_NAME, undefined);
    const newSignature = computeWidgetSignature({
      peerRows: data.snapshot.peerRows.filter(isPeerVisibleInWidget),
      transportDegraded: data.snapshot.transportDegraded,
      lastEvent: data.snapshot.lastEvent,
    });
    if (newSignature !== lastWidgetSignature) {
      lastWidgetSignature = newSignature;
      ctx.ui.setWidget("peer-dashboard", createDashboardWidget(data.snapshot));
    }
  }
  return data;
}

function createDashboardWidget(snapshot: DashboardSnapshot) {
  return (_tui: unknown, theme: { fg: (color: string, text: string) => string }) => ({
    invalidate() {},
    render(width: number): string[] {
      const widgetRows = snapshot.peerRows.filter(isPeerVisibleInWidget);
      const health = getPeerFirstHealth(widgetRows, snapshot.transportDegraded);
      const summary = formatWidgetSummary(widgetRows, snapshot.transportDegraded);
      const title = `${theme.fg("accent", "Peers")} ${theme.fg("dim", summary)}`;
      const badge = health === "warning"
        ? theme.fg("warning", "● warning")
        : health === "active"
          ? theme.fg("success", "● active")
          : theme.fg("muted", "● idle");
      const lines = [joinLeftRight(title, badge, width)];

      if (snapshot.peerRows.length === 0) {
        lines.push(truncateToWidth("no peers yet", width));
        lines.push(truncateToWidth(theme.fg("dim", "hint  /peer start <task or prompt>"), width));
      } else if (widgetRows.length === 0) {
        lines.push(truncateToWidth("no active peers", width));
        lines.push(truncateToWidth(theme.fg("dim", "stopped peers in /peer dashboard"), width));
      } else {
        const rows = sortWidgetRows(widgetRows);
        const layout = createWidgetPeerLayout(widgetRows, width);
        lines.push(...renderWidgetTable(rows, layout, width, theme));
      }

      if (snapshot.transportDegraded) {
        lines.push(truncateToWidth(theme.fg("warning", "broker offline; peers stay local"), width));
      }

      return lines;
    },
  });
}

type WidgetTheme = { fg: (color: string, text: string) => string };

interface WidgetColumn<T> {
  label: string;
  width?: number;
  color?: string | ((row: T) => string);
  value: (row: T) => string;
}

interface SizedWidgetColumn<T> extends WidgetColumn<T> {
  key: string;
  minWidth: number;
  maxWidth: number;
  dropPriority?: number;
}

function createWidgetPeerLayout(rows: PeerActivityRow[], width: number): Array<WidgetColumn<PeerActivityRow>> {
  const distinctDrivers = new Set(rows.map((row) => row.driver).filter(Boolean)).size;
  const minActivityWidth = width >= 96 ? 28 : width >= 72 ? 20 : 12;
  const columns: Array<SizedWidgetColumn<PeerActivityRow> | undefined> = [
    { key: "peer", label: "peer", minWidth: 8, maxWidth: 24, value: (row) => row.name },
    { key: "state", label: "state", minWidth: 5, maxWidth: 9, color: widgetStateColor, value: (row) => row.state },
    distinctDrivers > 1
      ? { key: "driver", label: "driver", minWidth: 6, maxWidth: 6, dropPriority: 0, color: "dim", value: (row) => row.driver ? compactDriver(row.driver) : "-" }
      : undefined,
    rows.some((row) => row.model)
      ? { key: "model", label: "model", minWidth: 7, maxWidth: 16, dropPriority: 2, color: "dim", value: (row) => row.model ? compactModel(row.model) : "-" }
      : undefined,
    rows.some(hasPeerContextUsage)
      ? { key: "ctx", label: "ctx", minWidth: 4, maxWidth: 6, dropPriority: 1, color: contextUsageColor, value: formatWidgetContextUsage }
      : undefined,
    { key: "updated", label: "updated", minWidth: 7, maxWidth: 7, dropPriority: 3, color: "dim", value: (row) => formatWidgetUpdateTime(row.lastUpdateAt) },
  ];

  let visible = columns.filter((column): column is SizedWidgetColumn<PeerActivityRow> => Boolean(column));
  while (visible.some((column) => column.dropPriority != null) && widgetTableMinWidth(visible, minActivityWidth) > width) {
    const dropPriority = Math.min(...visible.filter((column) => column.dropPriority != null).map((column) => column.dropPriority ?? 0));
    const index = visible.findIndex((column) => column.dropPriority === dropPriority);
    if (index < 0) {
      break;
    }
    visible = visible.filter((_, currentIndex) => currentIndex !== index);
  }

  const widths = new Map<string, number>(visible.map((column) => [column.key, column.minWidth]));
  const gapWidth = widgetTableGapWidth(visible.length + 1);
  const reservedActivityWidth = widgetTableMinWidth(visible, minActivityWidth) <= width ? minActivityWidth : 1;
  let extraWidth = Math.max(0, width - gapWidth - reservedActivityWidth - sumWidgetColumnWidths(widths));

  for (const key of ["peer", "model", "state", "driver", "ctx", "updated"]) {
    const column = visible.find((item) => item.key === key);
    if (!column || extraWidth <= 0) {
      continue;
    }
    const desiredWidth = measureWidgetColumnWidth(column, rows);
    const currentWidth = widths.get(column.key) ?? column.minWidth;
    const nextWidth = Math.min(column.maxWidth, desiredWidth);
    const growth = Math.min(extraWidth, Math.max(0, nextWidth - currentWidth));
    if (growth > 0) {
      widths.set(column.key, currentWidth + growth);
      extraWidth -= growth;
    }
  }

  const activityWidth = Math.max(1, width - gapWidth - sumWidgetColumnWidths(widths));
  return [
    ...visible.map((column) => ({
      label: column.label,
      width: widths.get(column.key) ?? column.minWidth,
      color: column.color,
      value: column.value,
    })),
    { label: "activity", width: activityWidth, value: (row) => row.activity },
  ];
}

function renderWidgetTable<T>(rows: T[], columns: Array<WidgetColumn<T>>, width: number, theme: WidgetTheme): string[] {
  return [
    truncateToWidth(theme.fg("dim", columns.map((column) => formatWidgetCell(column.label, column.width)).join("  ")), width),
    ...rows.map((row) => truncateToWidth(columns.map((column) => {
      const color = typeof column.color === "function" ? column.color(row) : column.color;
      const cell = formatWidgetCell(column.value(row), column.width);
      return color ? theme.fg(color, cell) : cell;
    }).join("  "), width)),
  ];
}

function formatWidgetCell(value: string, width?: number): string {
  if (width == null) {
    return value;
  }
  return truncateToWidth(value, width).padEnd(width);
}

function formatWidgetSummary(rows: PeerActivityRow[], transportDegraded: boolean): string {
  const busy = rows.filter((row) => row.state === "busy").length;
  const issues = rows.filter((row) => ["error", "offline", "waiting"].includes(row.state)).length + (transportDegraded ? 1 : 0);
  return [
    `${rows.length} peer${rows.length === 1 ? "" : "s"}`,
    busy > 0 ? `${busy} busy` : undefined,
    issues > 0 ? `${issues} issue${issues === 1 ? "" : "s"}` : undefined,
  ].filter((part): part is string => Boolean(part)).join(" · ");
}

function sortWidgetRows(rows: PeerActivityRow[]): PeerActivityRow[] {
  const priority = (row: PeerActivityRow) => {
    if (["error", "waiting", "offline"].includes(row.state)) {
      return 0;
    }
    if (row.state === "busy") {
      return 1;
    }
    return 2;
  };
  return [...rows].sort((left, right) => priority(left) - priority(right) || left.name.localeCompare(right.name));
}

function widgetStateColor(row: PeerActivityRow): string {
  if (row.state === "busy") {
    return "success";
  }
  if (["waiting", "offline"].includes(row.state)) {
    return "warning";
  }
  if (row.state === "error") {
    return "error";
  }
  return "text";
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
  const peerRows = await Promise.all(
    peers.map(async (peer) => buildPeerActivityRow(peer, await runtime.tail(peer.sessionId, 12).catch(() => []))),
  );
  const attention = listAttentionViews(attentionLedger, runs, Date.now());
  const intercomLive = bridge.hasTransport();
  const hasNonStoppedPeers = peers.some((peer) => peer.state !== "stopped");
  const transportDegraded = hasNonStoppedPeers && (!intercomLive || shouldRebindTransport(transportStatus));

  return {
    snapshot: {
      sessions: sessions.length,
      peers: peers.length,
      peerBusy: peers.filter((peer) => ["busy", "starting"].includes(peer.state)).length,
      peerIssues: peers.filter((peer) => isProblemState(peer.state)).length,
      peerRows,
      intercomLive,
      intercomBoundPeers: transportStatus?.boundPeers ?? 0,
      intercomConnectedPeers: transportStatus?.connectedPeers ?? 0,
      transportDegraded,
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

function completePeerCommand(prefix: string, names: Set<string>): AutocompleteItem[] | null {
  const trimmedStart = prefix.trimStart();
  const [subcommand = "", ...restParts] = trimmedStart.split(/\s+/);
  const endsWithSpace = /\s$/.test(trimmedStart);
  const subcommands = ["init", "dashboard", "start", "ask", "send", "list", "models", "history", "interrupt", "stop", "help"];

  if (!subcommand || (!endsWithSpace && restParts.length === 0)) {
    const matches = subcommands
      .filter((item) => item.startsWith(subcommand.toLowerCase()))
      .map((item) => ({ value: `${item} `, label: item }));
    return matches.length > 0 ? matches : null;
  }

  if (["ask", "send"].includes(subcommand)) {
    return completePeerName(restParts.join(" "), names, true);
  }
  if (["history", "interrupt", "stop"].includes(subcommand)) {
    return completePeerName(restParts.join(" "), names, false);
  }
  if (subcommand === "models") {
    const trimmed = restParts.join(" ").trim();
    const items = ["claude-sdk", "codex-cli"]
      .filter((driver) => trimmed.length === 0 || driver.startsWith(trimmed))
      .map((driver) => ({ value: driver, label: driver }));
    return items.length > 0 ? items : null;
  }
  return null;
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

function joinLeftRight(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "");
}

function formatPeerList(rows: PeerActivityRow[]): string {
  if (rows.length === 0) {
    return [
      "No peers yet.",
      "hint  /peer start <task or prompt>",
    ].join("\n");
  }

  const hasDriver = rows.some((row) => row.driver);
  const hasModel = rows.some((row) => row.model);
  const hasContext = rows.some(hasPeerContextUsage);
  const headers = [
    "name",
    "state",
    ...(hasDriver ? ["driver"] : []),
    ...(hasModel ? ["model"] : []),
    ...(hasContext ? ["ctx"] : []),
    "activity",
    "last update",
  ];

  return formatTable(
    headers,
    rows.map((row) => [
      row.name,
      row.state,
      ...(hasDriver ? [row.driver ?? "-"] : []),
      ...(hasModel ? [row.model ?? "-"] : []),
      ...(hasContext ? [formatPeerContextUsage(row)] : []),
      row.activity,
      formatIsoTime(row.lastUpdateAt),
    ]),
  );
}

function formatPeerFirstDashboardReport(data: DashboardData): string {
  const { snapshot } = data;
  const health = getPeerFirstHealth(snapshot.peerRows, snapshot.transportDegraded);
  const sections = [
    `health   ${health}`,
    `updated  ${formatTime(snapshot.lastRefreshedAt)}`,
    `event    ${snapshot.lastEvent}`,
  ];

  if (snapshot.transportDegraded) {
    sections.push(
      "",
      "Transport",
      "status   broker offline",
      "impact   existing peers remain local; live broker routing unavailable",
    );
  }

  sections.push("", "Peers", formatPeerList(snapshot.peerRows));
  return sections.join("\n");
}

function formatAdvancedDashboardReport(data: DashboardData): string {
  const now = Date.now();
  const { snapshot, runs, teammates, tasks, attention } = data;
  const health = getPeerFirstHealth(snapshot.peerRows, snapshot.transportDegraded);
  const sections = [
    `health   ${health}`,
    `updated  ${formatTime(snapshot.lastRefreshedAt)}`,
    `event    ${snapshot.lastEvent}`,
  ];

  if (snapshot.transportDegraded) {
    sections.push(
      "",
      "Transport",
      "status   broker offline",
      "impact   existing peers remain local; live broker routing unavailable",
    );
  }

  sections.push(
    "",
    "Peers",
    formatPeerList(snapshot.peerRows),
    "",
    "Advanced diagnostics",
    `runtime sessions   ${snapshot.sessions} retained`,
    `runs               ${snapshot.runs} retained`,
    `attention          ${attention.length} active`,
    `teammates          ${snapshot.teammates} retained`,
    `tasks              ${snapshot.openTasks} open`,
    `broker             ${snapshot.transportDegraded ? "offline" : snapshot.intercomLive ? "live" : "local only"}`,
  );

  if (runs.length > 0) {
    sections.push(
      "",
      "Runs",
      formatTable(
        ["run", "state", "driver", "agent", "note"],
        runs.slice(0, 8).map((run) => [
          shortId(run.runId, 12),
          run.state,
          run.driver ?? "-",
          run.agentName,
          truncate(run.note ?? run.result?.summary ?? "", 48),
        ]),
      ),
    );
  }

  if (attention.length > 0) {
    sections.push(
      "",
      "Attention",
      formatTable(
        ["run", "state", "agent", "note"],
        attention.map((view) => [
          shortId(view.run.runId, 12),
          describeAttentionState(view, now),
          view.run.agentName,
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
        ["name", "state", "driver", "session"],
        teammates.map((teammate) => [teammate.name, teammate.state, teammate.driver ?? "-", shortId(teammate.sessionId ?? "-", 12)]),
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

function parsePeerModelsArgs(args: string): { driver?: "claude-sdk" | "codex-cli"; verbose: boolean } {
  let driver: "claude-sdk" | "codex-cli" | undefined;
  let verbose = false;
  for (const token of args.trim().split(/\s+/).filter(Boolean)) {
    const parsedDriver = parseRuntimeDriverName(token);
    if (parsedDriver) {
      driver = parsedDriver;
      continue;
    }
    if (["all", "advanced", "verbose", "--all", "--advanced", "--verbose"].includes(token.toLowerCase())) {
      verbose = true;
      continue;
    }
    throw new Error("usage: /peer models [claude-sdk|codex-cli] [all|advanced|verbose]");
  }
  return { driver, verbose };
}

function formatModelCatalogReport(catalogs: RuntimeDriverModelCatalog[], options: { verbose?: boolean } = {}): string {
  return catalogs.map((catalog) => {
    const verbose = options.verbose === true;
    const rows = verbose ? formatFullModelCatalogRows(catalog) : formatRecommendedModelCatalogRows(catalog);
    const sections = [
      `${catalog.driver} models`,
      `provider ${catalog.provider}`,
      `default ${catalog.defaultModel}`,
      `aliases ${formatModelAliases(catalog.aliases)}`,
      `cli ${catalog.flag}`,
      `source ${catalog.source}`,
      "columns context window=input token capacity; max output=maximum generated output tokens",
      "guidance advisory; actual model availability depends on the installed runtime, account, region, and provider rollout",
      "",
      verbose
        ? formatTable(["model", "name", "context window", "max output", "reasoning", "$/M in/out"], rows)
        : formatTable(["alias", "model", "name", "best for", "context window", "max output", "$/M in/out"], rows),
    ];
    if (!verbose) {
      sections.push(`Use /peer models ${catalog.driver} all or runtime_models({ driver: "${catalog.driver}", verbose: true }) for the full catalog.`);
    }
    return sections.join("\n");
  }).join("\n\n");
}

function formatRecommendedModelCatalogRows(catalog: RuntimeDriverModelCatalog): string[][] {
  return catalog.recommendations.map((recommendation) => {
    const model = catalog.models.find((entry) => entry.id === recommendation.model);
    return [
      recommendation.alias,
      recommendation.model === catalog.defaultModel ? `${recommendation.model} *` : recommendation.model,
      model?.name ?? "-",
      recommendation.useCase,
      model ? String(model.contextWindow) : "-",
      model ? String(model.maxTokens) : "-",
      model ? `$${model.inputCostPerMillion}/$${model.outputCostPerMillion}` : "-",
    ];
  });
}

function formatFullModelCatalogRows(catalog: RuntimeDriverModelCatalog): string[][] {
  return catalog.models.map((model) => [
    model.id === catalog.defaultModel ? `${model.id} *` : model.id,
    model.name,
    String(model.contextWindow),
    String(model.maxTokens),
    model.reasoning ? "yes" : "no",
    `$${model.inputCostPerMillion}/$${model.outputCostPerMillion}`,
  ]);
}

function formatModelAliases(aliases: Record<string, string>): string {
  const entries = Object.entries(aliases);
  if (entries.length === 0) {
    return "-";
  }
  return entries.map(([alias, target]) => `${alias}->${target}`).join(", ");
}

function parseExtensionLogInput(params: unknown): ExtensionLogEntryInput {
  const input = (params ?? {}) as Record<string, unknown>;
  const category = parseStringEnum(input.category, ["ux", "agent-guidance", "tooling", "runtime", "model-selection", "docs", "bug", "other"], "category") ?? "other";
  const severity = parseStringEnum(input.severity, ["low", "medium", "high"], "severity") ?? "medium";
  const summary = cleanLogText(input.summary);
  if (!summary) {
    throw new Error("summary is required");
  }
  const files = Array.isArray(input.files)
    ? input.files.map((file) => cleanLogText(file)).filter(Boolean)
    : [];
  return {
    category,
    severity,
    summary,
    observed: cleanOptionalLogText(input.observed),
    expected: cleanOptionalLogText(input.expected),
    reproduction: cleanOptionalLogText(input.reproduction),
    suggestedFix: cleanOptionalLogText(input.suggestedFix),
    relatedCommand: cleanOptionalLogText(input.relatedCommand),
    relatedTool: cleanOptionalLogText(input.relatedTool),
    files,
  };
}

function parseStringEnum<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if ((allowed as readonly string[]).includes(trimmed)) {
    return trimmed as T[number];
  }
  throw new Error(`${field} must be one of ${allowed.join(", ")}`);
}

function cleanOptionalLogText(value: unknown): string | undefined {
  const cleaned = cleanLogText(value);
  return cleaned || undefined;
}

function cleanLogText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

function formatExtensionLogEntry(input: ExtensionLogEntryInput): string {
  const lines = [
    `## ${new Date().toISOString()} - ${input.category} - ${input.severity}`,
    "",
    `Summary: ${input.summary}`,
  ];
  addLogSection(lines, "Observed", input.observed);
  addLogSection(lines, "Expected", input.expected);
  addLogSection(lines, "Reproduction", input.reproduction);
  addLogSection(lines, "Suggested fix", input.suggestedFix);

  const related = [
    input.relatedCommand ? `- command: ${input.relatedCommand}` : undefined,
    input.relatedTool ? `- tool: ${input.relatedTool}` : undefined,
    ...input.files.map((file) => `- file: ${file}`),
  ].filter(Boolean);
  if (related.length > 0) {
    lines.push("", "Related:", ...related);
  }

  return `${lines.join("\n")}\n\n`;
}

function addLogSection(lines: string[], title: string, value?: string): void {
  if (!value) {
    return;
  }
  lines.push("", `${title}:`, value);
}

function formatTable(headers: string[], rows: string[][]): string {
  const matrix = [headers, ...rows].map((row) => row.map((cell) => cell ?? ""));
  const widths = headers.map((_, index) => Math.max(...matrix.map((row) => row[index]?.length ?? 0)));
  const formatRow = (row: string[]) => row.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  const separator = widths.map((width) => "-".repeat(width)).join("  ");
  return [formatRow(headers), separator, ...rows.map(formatRow)].join("\n");
}

function formatIsoTime(value: string): string {
  return formatTime(new Date(value).getTime());
}

function formatWidgetUpdateTime(value: string): string {
  return formatIsoTime(value).slice(0, 5);
}

function measureWidgetColumnWidth<T>(column: SizedWidgetColumn<T>, rows: T[]): number {
  return Math.min(
    column.maxWidth,
    Math.max(column.minWidth, visibleWidth(column.label), ...rows.map((row) => visibleWidth(column.value(row)))),
  );
}

function sumWidgetColumnWidths(widths: Map<string, number>): number {
  return [...widths.values()].reduce((total, value) => total + value, 0);
}

function widgetTableGapWidth(columns: number): number {
  return Math.max(0, (columns - 1) * 2);
}

function widgetTableMinWidth<T>(columns: Array<SizedWidgetColumn<T>>, minActivityWidth: number): number {
  return columns.reduce((total, column) => total + column.minWidth, minActivityWidth) + widgetTableGapWidth(columns.length + 1);
}

function compactModel(model: string): string {
  const stripped = model.replace(/^claude-/, "");
  return stripped.length > 12 ? `${stripped.slice(0, 11)}…` : stripped;
}

function compactDriver(driver: string): string {
  switch (driver) {
    case "claude-sdk":
      return "claude";
    case "codex-cli":
      return "codex";
    default:
      return driver.length > 7 ? `${driver.slice(0, 6)}…` : driver;
  }
}

function hasPeerContextUsage(row: PeerActivityRow): boolean {
  return row.contextPercentage != null;
}

function formatPeerContextUsage(row: Pick<PeerActivityRow, "contextPercentage">): string {
  if (row.contextPercentage == null) {
    return "-";
  }
  const percentage = row.contextPercentage > 0 && row.contextPercentage < 1
    ? "<1"
    : String(Math.round(row.contextPercentage));
  return `ctx ${percentage}%`;
}

function formatWidgetContextUsage(row: Pick<PeerActivityRow, "contextPercentage">): string {
  if (row.contextPercentage == null) {
    return "-";
  }
  if (row.contextPercentage > 999) {
    return ">999%";
  }
  const percentage = row.contextPercentage > 0 && row.contextPercentage < 1
    ? "<1"
    : String(Math.round(row.contextPercentage));
  return `${percentage}%`;
}

function contextUsageColor(row: Pick<PeerActivityRow, "contextPercentage">): string {
  if (row.contextPercentage == null) {
    return "dim";
  }
  if (row.contextPercentage >= 100) {
    return "error";
  }
  if (row.contextPercentage >= 80) {
    return "warning";
  }
  return "dim";
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

function commandMessageBg(surface: CommandMessageSurface, level: CommandMessageLevel): string {
  if (surface === "custom" || surface === "agent") {
    return "toolPendingBg";
  }
  switch (level) {
    case "success":
      return "toolSuccessBg";
    case "error":
      return "toolErrorBg";
    default:
      return "toolPendingBg";
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

function resolveSubagentRunId(token: string, runs: Array<{ runId: string }>): string {
  const matches = runs.filter((run) => run.runId.startsWith(token));
  if (matches.length === 1) {
    return matches[0]!.runId;
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous run id prefix ${token}`);
  }
  throw new Error(`Unknown run ${token}`);
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
