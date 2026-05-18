import { resolve } from "node:path";
import {
  type RuntimeDriverName,
  type RuntimeEvent,
  type RuntimeMessageBlock,
  type RuntimeSessionId,
  type RuntimeSessionState,
  type RuntimeStatus,
  type TranscriptChunk,
} from "@pi-claude-code-agent/runtime";
import { ClaudeCodeRuntime } from "@pi-claude-code-agent/runtime/internal";
import {
  defaultBridgeStorageDir,
  readBridgeRegistry,
  writeBridgeRegistry,
  type PersistedBridgePeerRecord,
} from "./persistence.js";
import type {
  AskResult,
  AttachPeerInput,
  BridgeOptions,
  BridgePeer,
  BridgeState,
  BridgeTransport,
  BridgeTransportIncomingMessage,
  BridgeTransportStatus,
  IntercomInboundMessage,
  InterruptPeerResult,
  LaunchPeerInput,
  WaitForCompletionOptions,
} from "./types.js";
import { WaitCompletionError } from "./types.js";

const DEFAULT_ASK_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

const TERMINAL_RUNTIME_STATES: ReadonlySet<RuntimeSessionState> = new Set([
  "idle",
  "interrupted",
  "failed",
  "stopped",
]);

/**
 * Driver-aware default for `WaitForCompletionOptions.staleThresholdMs`.
 *
 * Different drivers emit driver events at very different rates. Claude
 * (sdk/cli) streams thinking blocks and tool deltas continuously, so a
 * 2-minute gap is already strongly indicative of a wedged peer. Codex and
 * `pi-coding-agent` batch much more aggressively — a 5-minute gap is closer
 * to the "alive but quiet" floor. The numbers are deliberately coarse;
 * callers wanting tighter bounds should pass `staleThresholdMs` explicitly.
 */
export function defaultStaleThresholdMsForDriver(driver: RuntimeDriverName): number {
  switch (driver) {
    case "claude-sdk":
    case "claude-cli":
      return 2 * 60_000;
    case "codex-cli":
    case "pi-coding-agent":
      return 5 * 60_000;
  }
}

const BRIDGE_SYSTEM_PROMPT = [
  "You are a long-lived Claude worker reached through intercom-style messages.",
  "Treat new messages as continuation of same session, not fresh bootstrap.",
  "For asks and replies, answer concisely and directly.",
  "When you finish handling one inbound message, end in a clean idle state.",
].join(" ");

export class ClaudeRuntimeIntercomBridge {
  private readonly runtime: ClaudeCodeRuntime;
  private readonly storageDir: string;
  private transport?: BridgeTransport;
  private readonly pollIntervalMs: number;
  private readonly askTimeoutMs: number;
  private readonly peers = new Map<string, BridgePeer>();
  /**
   * Names of peers that were launched with `waitForIdle: false` and have not
   * yet been observed in a terminal state. While in this set, a concurrent
   * `send`/`ask` must wait through the launch run's `busy` window rather
   * than reject with `PEER_BUSY` — the only work the peer is doing is its
   * own bootstrap. Cleared as soon as `deliver` (or any sync path) sees
   * idle/interrupted/failed/stopped, or on stop/disconnect.
   */
  private readonly bootstrappingPeers = new Set<string>();

  constructor(options: BridgeOptions = {}) {
    this.runtime = options.runtime ?? new ClaudeCodeRuntime(options.runtimeOptions);
    this.storageDir = resolve(options.storageDir ?? defaultBridgeStorageDir());
    this.transport = options.transport;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.askTimeoutMs = options.askTimeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  }

  async launchPeer(input: LaunchPeerInput): Promise<BridgePeer> {
    await this.assertLaunchPeerNameAvailable(input.name);
    const status = await this.runtime.start({
      prompt: input.prompt,
      driver: input.driver,
      cwd: input.cwd,
      model: input.model,
      name: input.name,
      appendSystemPrompt: mergeSystemPrompt(input.appendSystemPrompt),
      permissionMode: input.permissionMode,
      securityMode: input.securityMode,
      tools: input.tools,
      additionalDirectories: input.additionalDirectories,
      env: input.env,
      thinkingLevel: input.thinkingLevel,
    });
    const peer = this.peerFromStatus(input.name, status, "starting", {
      kind: input.kind ?? "ad-hoc",
      metadata: input.metadata,
    });
    this.peers.set(peer.name, peer);
    await this.rememberPeer(peer);
    await this.registerTransportPeer(peer.name);
    if (input.waitForIdle !== false) {
      await this.waitForTerminalState(peer.sessionId);
    } else {
      // Fire-and-forget launch: subsequent `send`/`ask` must treat the launch
      // run's `busy` state as part of the starting window, not as PEER_BUSY.
      this.bootstrappingPeers.add(input.name);
    }
    return this.syncPeerFromRuntime(peer.name);
  }

  async attachPeer(input: AttachPeerInput): Promise<BridgePeer> {
    await this.assertAttachPeerNameAvailable(input);
    const status = await this.runtime.status(input.sessionId);
    if (!status) {
      throw new Error(`Unknown runtime session ${input.sessionId}`);
    }
    const peer = this.peerFromStatus(input.name, status, mapRuntimeState(status.state, true), {
      kind: input.kind ?? "ad-hoc",
      metadata: input.metadata,
    });
    this.peers.set(peer.name, peer);
    await this.rememberPeer(peer);
    await this.registerTransportPeer(peer.name);
    return peer;
  }

  async listPeers(): Promise<BridgePeer[]> {
    await this.restorePeers();
    const peers = await Promise.all([...this.peers.values()].map((peer) => this.syncPeerFromRuntime(peer.name)));
    return peers.sort((a, b) => a.name.localeCompare(b.name));
  }

  async status(name: string): Promise<BridgePeer | undefined> {
    if (!this.peers.has(name)) {
      await this.restorePeers();
    }
    if (!this.peers.has(name)) {
      return undefined;
    }
    return this.syncPeerFromRuntime(name);
  }

  /**
   * Look up a peer by its runtime sessionId rather than its registry name.
   * Useful for callers that received the sessionId from `launchPeer` or from
   * a runtime event and don't want to keep a name→sessionId map of their own.
   */
  async statusBySessionId(sessionId: RuntimeSessionId): Promise<BridgePeer | undefined> {
    for (const peer of this.peers.values()) {
      if (peer.sessionId === sessionId) {
        return this.syncPeerFromRuntime(peer.name);
      }
    }
    await this.restorePeers();
    for (const peer of this.peers.values()) {
      if (peer.sessionId === sessionId) {
        return this.syncPeerFromRuntime(peer.name);
      }
    }
    return undefined;
  }

  /**
   * Fetch the transcript chunk for a sessionId. Thin Bridge-routed wrapper
   * over the embedded runtime so any future Bridge-side accounting (rate
   * limiting, telemetry, replay buffers) applies uniformly.
   */
  async events(sessionId: RuntimeSessionId, cursor = 0): Promise<TranscriptChunk> {
    return this.runtime.events(sessionId, cursor);
  }

  /**
   * Subscribe to raw runtime events, optionally filtered to a single
   * sessionId. Returns an unsubscribe function. This is a passthrough — the
   * caller sees the underlying `RuntimeEvent` stream, not the Bridge's own
   * lifecycle envelope.
   */
  subscribe(listener: (event: RuntimeEvent) => void, sessionId?: RuntimeSessionId): () => void {
    return this.runtime.subscribe(listener, sessionId);
  }

  /**
   * Wait until `sessionId` reaches a terminal state (`idle`, `interrupted`,
   * `failed`, `stopped`), or reject if the peer goes silent past
   * `staleThresholdMs`, exceeds `hardCeilingMs`, or the caller aborts.
   *
   * Event-driven: subscribes to the runtime's event stream and resets the
   * staleness window on every event for this session. The pattern is
   * listen-then-look — we subscribe BEFORE snapshotting status, so a peer
   * that lands terminal between snapshot and subscribe cannot be missed.
   *
   * Resolves with the terminal `RuntimeStatus`. `failed` is a resolution,
   * not a rejection: inspect `.state` and `.lastError` to distinguish.
   */
  async waitForCompletion(
    sessionId: RuntimeSessionId,
    opts: WaitForCompletionOptions = {},
  ): Promise<RuntimeStatus> {
    const started = Date.now();
    return new Promise<RuntimeStatus>((resolveP, rejectP) => {
      let settled = false;
      let unsubscribe: (() => void) | null = null;
      let staleTimer: NodeJS.Timeout | null = null;
      let ceilingTimer: NodeJS.Timeout | null = null;
      let abortHandler: (() => void) | null = null;
      let staleThresholdMs: number | undefined;
      let lastActivityIso: string | undefined;
      let lastActivityMs = started;

      const cleanup = () => {
        if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
        if (ceilingTimer) { clearTimeout(ceilingTimer); ceilingTimer = null; }
        if (abortHandler && opts.signal) {
          opts.signal.removeEventListener("abort", abortHandler);
          abortHandler = null;
        }
        if (unsubscribe) { unsubscribe(); unsubscribe = null; }
      };
      const resolve = (status: RuntimeStatus) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (status.state === "failed" && !opts.silentOnFailure) {
          // `failed` is a resolution, not a rejection — but we make it loud
          // so callers don't silently drop a failure on the floor. Suppress
          // with `silentOnFailure: true` (tests, expected-failure flows).
          const detail = status.lastError?.message ?? "(no lastError captured)";
          // eslint-disable-next-line no-console
          console.warn(
            `[bridge.waitForCompletion] peer ${status.sessionId} resolved with state=failed: ${detail}`,
          );
        }
        resolveP(status);
      };
      const reject = (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectP(err);
      };

      const armStaleTimer = () => {
        if (staleThresholdMs === undefined || !Number.isFinite(staleThresholdMs)) return;
        if (staleTimer) clearTimeout(staleTimer);
        const remaining = Math.max(0, staleThresholdMs - (Date.now() - lastActivityMs));
        staleTimer = setTimeout(() => {
          const stalenessMs = Date.now() - lastActivityMs;
          reject(new WaitCompletionError({
            code: "WAIT_STALE",
            message: `Peer ${sessionId} silent for ${stalenessMs}ms (threshold ${staleThresholdMs}ms)`,
            sessionId,
            elapsedMs: Date.now() - started,
            stalenessMs,
            lastActivityAt: lastActivityIso,
          }));
        }, remaining);
      };

      const onEvent = (event: RuntimeEvent) => {
        if (settled) return;
        if (event.sessionId !== sessionId) return;
        lastActivityMs = Date.now();
        lastActivityIso = event.timestamp ?? new Date(lastActivityMs).toISOString();
        armStaleTimer();
        if (event.type === "session.idle" || event.type === "session.stopped") {
          this.runtime.status(sessionId).then((status) => {
            if (!status) {
              reject(new Error(`Unknown runtime session ${sessionId}`));
              return;
            }
            resolve(status);
          }).catch(reject);
        }
      };

      // 1. Listen first — anything emitted between here and the snapshot
      //    below will hit `onEvent` and cannot be lost.
      unsubscribe = this.runtime.subscribe(onEvent, sessionId);

      // 2. Hard ceiling + abort signal.
      if (opts.hardCeilingMs !== undefined && Number.isFinite(opts.hardCeilingMs)) {
        ceilingTimer = setTimeout(() => {
          reject(new WaitCompletionError({
            code: "WAIT_HARD_CEILING",
            message: `Peer ${sessionId} did not complete within hard ceiling ${opts.hardCeilingMs}ms`,
            sessionId,
            elapsedMs: Date.now() - started,
            lastActivityAt: lastActivityIso,
          }));
        }, opts.hardCeilingMs);
      }
      if (opts.signal) {
        if (opts.signal.aborted) {
          queueMicrotask(() => reject(opts.signal!.reason ?? new DOMException("Aborted", "AbortError")));
          return;
        }
        abortHandler = () => reject(opts.signal!.reason ?? new DOMException("Aborted", "AbortError"));
        opts.signal.addEventListener("abort", abortHandler, { once: true });
      }

      // 3. Snapshot. Returns immediately for already-terminal peers; otherwise
      //    arms the staleness timer using the driver-aware default.
      this.runtime.status(sessionId).then((status) => {
        if (settled) return;
        if (!status) {
          reject(new Error(`Unknown runtime session ${sessionId}`));
          return;
        }
        if (TERMINAL_RUNTIME_STATES.has(status.state)) {
          resolve(status);
          return;
        }
        staleThresholdMs = opts.staleThresholdMs ?? defaultStaleThresholdMsForDriver(status.driver);
        const parsed = Date.parse(status.lastActivityAt);
        if (Number.isFinite(parsed)) {
          lastActivityMs = parsed;
          lastActivityIso = status.lastActivityAt;
        }
        armStaleTimer();
      }).catch(reject);
    });
  }

  async reconcilePeers(): Promise<BridgePeer[]> {
    await this.restorePeers();
    return this.listPeersWithoutRestore();
  }

  async send(name: string, message: Omit<IntercomInboundMessage, "kind">, options: { waitForIdle?: boolean } = {}): Promise<BridgePeer> {
    const result = await this.deliver(name, { ...message, kind: "send" }, { waitForIdle: options.waitForIdle ?? true });
    return result.peer;
  }

  async ask(name: string, message: Omit<IntercomInboundMessage, "kind">): Promise<AskResult> {
    return this.deliver(name, { ...message, kind: "ask" }, { waitForIdle: true });
  }

  async reply(name: string, message: Omit<IntercomInboundMessage, "kind">): Promise<BridgePeer> {
    const result = await this.deliver(name, { ...message, kind: "reply" }, { waitForIdle: true });
    return result.peer;
  }

  async interrupt(name: string): Promise<BridgePeer> {
    return (await this.interruptWithResult(name)).peer;
  }

  async interruptWithResult(name: string): Promise<InterruptPeerResult> {
    const peer = this.requirePeer(name);
    const interrupt = await this.runtime.interrupt(peer.sessionId);
    return {
      peer: await this.syncPeerFromRuntime(name),
      interrupt,
    };
  }

  async stop(name: string): Promise<BridgePeer> {
    if (!this.peers.has(name)) {
      await this.restorePeers();
    }
    const peer = this.requirePeer(name);
    const status = await this.runtime.stop(peer.sessionId);
    const stopped = this.peerFromStatus(name, status, mapRuntimeState(status.state, true), peer);
    await this.forgetPeer(name);
    await this.unregisterTransportPeer(name);
    this.peers.delete(name);
    return stopped;
  }

  async disconnect(name: string): Promise<BridgePeer> {
    const peer = this.requirePeer(name);
    const next: BridgePeer = {
      ...peer,
      state: "disconnected",
      updatedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    this.peers.set(name, next);
    await this.forgetPeer(name);
    await this.unregisterTransportPeer(name);
    return next;
  }

  async setTransport(transport?: BridgeTransport): Promise<void> {
    if (this.transport === transport) {
      return;
    }
    const previous = this.transport;
    this.transport = transport;
    await previous?.close?.();
    if (!transport) {
      return;
    }
    for (const peer of this.peers.values()) {
      await this.registerTransportPeer(peer.name);
      await transport.updatePeer(peer);
    }
  }

  async restorePeers(): Promise<BridgePeer[]> {
    const registry = await readBridgeRegistry(this.storageDir);
    const restored: BridgePeer[] = [];
    const survivors: PersistedBridgePeerRecord[] = [];

    for (const record of registry.peers) {
      if (this.peers.has(record.name)) {
        const current = this.mergePersistedPeerRecord(this.peers.get(record.name)!, record);
        this.peers.set(current.name, current);
        survivors.push(this.recordFromPeer(current));
        restored.push(current);
        continue;
      }
      try {
        const status = await this.runtime.status(record.sessionId);
        if (!status) {
          throw new Error(`Unknown runtime session ${record.sessionId}`);
        }
        const peer = this.peerFromStatus(record.name, status, mapRuntimeState(status.state, true), record);
        this.peers.set(peer.name, peer);
        await this.registerTransportPeer(peer.name);
        survivors.push(this.recordFromPeer(peer));
        restored.push(peer);
      } catch {
        // Drop stale registry entries.
      }
    }

    await writeBridgeRegistry(this.storageDir, { peers: survivors });
    return restored.sort((a, b) => a.name.localeCompare(b.name));
  }

  async transportStatus(): Promise<BridgeTransportStatus | undefined> {
    return this.transport?.getStatus?.();
  }

  hasTransport(): boolean {
    return Boolean(this.transport);
  }

  async close(): Promise<void> {
    for (const name of [...this.peers.keys()]) {
      await this.unregisterTransportPeer(name);
    }
    await this.transport?.close?.();
  }

  private async deliver(name: string, inbound: IntercomInboundMessage, options: { waitForIdle: boolean }): Promise<AskResult> {
    let peer = await this.syncPeerFromRuntime(name);
    // If the peer has ever reached a terminal state, its launch run is done —
    // any future `busy` is real work, not bootstrap.
    if (["idle", "interrupted", "failed", "stopped"].includes(peer.state)) {
      this.bootstrappingPeers.delete(name);
    }
    const inBootstrap = this.bootstrappingPeers.has(name);
    // Slow-spawn drivers leave the peer in `starting` while the first prompt
    // runs (claude-cli). Fast-init drivers flip to `busy` after `init` even
    // though the launch prompt is still running (claude-sdk via fake/slow
    // driver). Both cases are bootstrap and must wait through, not throw
    // PEER_BUSY — the peer never had a chance to accept a follow-up.
    if (peer.state === "starting" || peer.state === "connected" || (inBootstrap && peer.state === "busy")) {
      const waited = await this.waitForTerminalStateOrCurrent(
        peer.sessionId,
        inbound.timeoutMs ?? this.askTimeoutMs,
      );
      if (waited.timedOut) {
        throw Object.assign(
          new Error(`Peer ${name} did not finish starting within timeout. Last runtime state: ${waited.status.state}.`),
          { code: "PEER_STARTING_TIMEOUT" },
        );
      }
      this.bootstrappingPeers.delete(name);
      peer = await this.syncPeerFromRuntime(name);
    }
    if (peer.state === "busy") {
      throw Object.assign(
        new Error(`Peer ${name} is busy executing a prior message. Wait for state=idle.`),
        { code: "PEER_BUSY" },
      );
    }
    if (["stopped", "disconnected"].includes(peer.state)) {
      throw Object.assign(
        new Error(`Peer ${name} unavailable (${peer.state})`),
        { code: "PEER_UNAVAILABLE" },
      );
    }

    const before = await this.runtime.events(peer.sessionId);
    const cursor = before.nextCursor;
    // Pass-through invariant: forward every driver field from `inbound`
    // verbatim. The Bridge owns (and overrides) `sessionId` and the
    // formatted `message` envelope; everything else flows through as-is.
    // Drivers ignore fields they don't understand. The destructure here
    // strips Bridge-only fields (`kind`/`from`/`text`/`replyTo`/`timeoutMs`)
    // and spreads the remainder — so adding a new driver field to
    // `IntercomInboundMessage` propagates automatically without touching
    // this method.
    const { kind: _kind, from: _from, text: _text, replyTo: _replyTo, timeoutMs: _timeoutMs, ...passthrough } = inbound;
    const sentStatus = await this.runtime.send({
      ...passthrough,
      sessionId: peer.sessionId,
      message: formatInboundMessage(inbound),
    });

    if (!options.waitForIdle) {
      const syncedPeer = await this.syncPeerFromRuntime(name);
      return {
        peer: syncedPeer,
        reply: "",
        runState: sentStatus.state,
        events: [],
        deliveryState: "delivered_and_running",
      };
    }

    const waited = await this.waitForTerminalStateOrCurrent(peer.sessionId, inbound.timeoutMs ?? this.askTimeoutMs);
    const chunk = await this.runtime.events(peer.sessionId, cursor);
    const syncedPeer = await this.syncPeerFromRuntime(name);
    return {
      peer: syncedPeer,
      reply: waited.timedOut ? "" : extractReplyText(chunk.items),
      runState: waited.status.state,
      events: chunk.items,
      deliveryState: waited.timedOut ? "delivered_and_running" : "completed",
    };
  }

  private async waitForTerminalStateOrCurrent(sessionId: RuntimeSessionId, timeoutMs = this.askTimeoutMs): Promise<{ status: RuntimeStatus; timedOut: boolean }> {
    const started = Date.now();
    for (;;) {
      const status = await this.runtime.status(sessionId);
      if (!status) {
        throw new Error(`Unknown runtime session ${sessionId}`);
      }
      if (["idle", "interrupted", "failed", "stopped"].includes(status.state)) {
        return { status, timedOut: false };
      }
      if (Date.now() - started > timeoutMs) {
        return { status, timedOut: true };
      }
      await delay(this.pollIntervalMs);
    }
  }

  private async waitForTerminalState(sessionId: RuntimeSessionId, timeoutMs = this.askTimeoutMs): Promise<RuntimeStatus> {
    const started = Date.now();
    for (;;) {
      const status = await this.runtime.status(sessionId);
      if (!status) {
        throw new Error(`Unknown runtime session ${sessionId}`);
      }
      if (["idle", "interrupted", "failed", "stopped"].includes(status.state)) {
        return status;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for peer ${sessionId} to become idle`);
      }
      await delay(this.pollIntervalMs);
    }
  }

  private async syncPeerFromRuntime(name: string): Promise<BridgePeer> {
    const peer = this.requirePeer(name);
    const status = await this.runtime.status(peer.sessionId);
    if (!status) {
      const next: BridgePeer = {
        ...peer,
        state: "disconnected",
        updatedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      };
      this.peers.set(name, next);
      return next;
    }
    const next = this.peerFromStatus(name, status, mapRuntimeState(status.state, true), peer);
    this.peers.set(name, next);
    await this.transport?.updatePeer(next);
    return next;
  }

  private peerFromStatus(
    name: string,
    status: RuntimeStatus,
    state: BridgeState,
    preserved: Partial<Pick<BridgePeer, "kind" | "metadata">> = {},
  ): BridgePeer {
    return {
      name,
      sessionId: status.sessionId,
      cwd: status.cwd,
      model: status.model,
      driver: status.driver,
      state,
      createdAt: status.createdAt,
      updatedAt: status.updatedAt,
      lastActivityAt: status.lastActivityAt,
      kind: preserved.kind,
      metadata: cloneMetadata(preserved.metadata),
      raw: status.raw,
    };
  }

  private async registerTransportPeer(name: string): Promise<void> {
    if (!this.transport) {
      return;
    }
    const peer = this.requirePeer(name);
    await this.transport.registerPeer(peer, async (message) => {
      await this.handleTransportMessage(name, message);
    });
  }

  private async unregisterTransportPeer(name: string): Promise<void> {
    await this.transport?.unregisterPeer(name);
  }

  private async handleTransportMessage(name: string, message: BridgeTransportIncomingMessage): Promise<void> {
    const inbound: IntercomInboundMessage = {
      kind: message.replyTo ? "reply" : message.expectsReply ? "ask" : "send",
      from: message.from.name ?? message.from.id,
      text: formatTransportInboundText(message),
      replyTo: message.replyTo,
    };

    if (message.expectsReply) {
      try {
        const result = await this.deliver(name, inbound, { waitForIdle: true });
        await this.transport?.sendFromPeer(name, message.from.id, {
          text: result.reply,
          replyTo: message.id,
        });
      } catch (error) {
        await this.transport?.sendFromPeer(name, message.from.id, {
          text: `Bridge error: ${error instanceof Error ? error.message : String(error)}`,
          replyTo: message.id,
        });
      }
      return;
    }

    await this.deliver(name, inbound, { waitForIdle: false });
  }

  private async rememberPeer(peer: BridgePeer): Promise<void> {
    const registry = await readBridgeRegistry(this.storageDir);
    const peers = registry.peers.filter((entry) => entry.name !== peer.name);
    peers.push(this.recordFromPeer(peer));
    await writeBridgeRegistry(this.storageDir, { peers: peers.sort((a, b) => a.name.localeCompare(b.name)) });
  }

  private async forgetPeer(name: string): Promise<void> {
    this.bootstrappingPeers.delete(name);
    const registry = await readBridgeRegistry(this.storageDir);
    await writeBridgeRegistry(this.storageDir, {
      peers: registry.peers.filter((peer) => peer.name !== name),
    });
  }

  private async listPeersWithoutRestore(): Promise<BridgePeer[]> {
    const peers = await Promise.all([...this.peers.values()].map((peer) => this.syncPeerFromRuntime(peer.name)));
    return peers.sort((a, b) => a.name.localeCompare(b.name));
  }

  private mergePersistedPeerRecord(peer: BridgePeer, record: PersistedBridgePeerRecord): BridgePeer {
    return {
      ...peer,
      kind: record.kind ?? peer.kind,
      metadata: cloneMetadata(record.metadata ?? peer.metadata),
    };
  }

  private recordFromPeer(peer: BridgePeer): PersistedBridgePeerRecord {
    return {
      name: peer.name,
      sessionId: peer.sessionId,
      kind: peer.kind,
      metadata: cloneMetadata(peer.metadata),
    };
  }

  private requirePeer(name: string): BridgePeer {
    const peer = this.peers.get(name);
    if (!peer) {
      throw new Error(`Unknown peer ${name}`);
    }
    return peer;
  }

  private async assertLaunchPeerNameAvailable(name: string): Promise<void> {
    if (this.peers.has(name)) {
      throw new Error(`Peer name ${name} already registered`);
    }
    const registry = await readBridgeRegistry(this.storageDir);
    if (registry.peers.some((peer) => peer.name === name)) {
      throw new Error(`Peer name ${name} already registered`);
    }
  }

  private async assertAttachPeerNameAvailable(input: AttachPeerInput): Promise<void> {
    const existing = this.peers.get(input.name);
    if (existing) {
      throw new Error(`Peer name ${input.name} already registered`);
    }
    const registry = await readBridgeRegistry(this.storageDir);
    const persisted = registry.peers.find((peer) => peer.name === input.name);
    if (persisted && persisted.sessionId !== input.sessionId) {
      throw new Error(`Peer name ${input.name} already registered`);
    }
  }
}

function mergeSystemPrompt(appendSystemPrompt?: string): string {
  return appendSystemPrompt ? `${appendSystemPrompt}\n\n${BRIDGE_SYSTEM_PROMPT}` : BRIDGE_SYSTEM_PROMPT;
}

function formatInboundMessage(message: IntercomInboundMessage): string {
  const header = [
    `kind=${message.kind}`,
    `from=${message.from}`,
    message.replyTo ? `replyTo=${message.replyTo}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  return [`[intercom ${header}]`, message.text].join("\n\n");
}

function extractReplyText(events: RuntimeEvent[]): string {
  const assistantBlocks = events
    .filter((event): event is Extract<RuntimeEvent, { type: "message" }> => event.type === "message" && event.role === "assistant")
    .flatMap((event) => event.message.blocks)
    .map(blockToVisibleText)
    .filter((value): value is string => Boolean(value && value.trim()));

  if (assistantBlocks.length > 0) {
    return assistantBlocks.join("\n\n").trim();
  }

  const result = [...events]
    .reverse()
    .find((event): event is Extract<RuntimeEvent, { type: "result" }> => event.type === "result");
  return result?.summary ?? "";
}

function extractLatestReplyText(events: RuntimeEvent[]): string {
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

function mapRuntimeState(state: RuntimeStatus["state"], registered: boolean): BridgeState {
  switch (state) {
    case "starting":
      return registered ? "starting" : "connected";
    case "running":
      return "busy";
    case "idle":
      return "idle";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "failed":
      return "errored";
    default:
      return "connected";
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function cloneMetadata(metadata?: Record<string, string>): Record<string, string> | undefined {
  if (!metadata || Object.keys(metadata).length === 0) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b)));
}

function formatTransportInboundText(message: BridgeTransportIncomingMessage): string {
  const attachmentText = (message.attachments ?? []).map((attachment) => {
    if (attachment.language) {
      return [`---`, `Attachment: ${attachment.name}`, `~~~${attachment.language}`, attachment.content, `~~~`].join("\n");
    }
    return [`---`, `Attachment: ${attachment.name}`, attachment.content].join("\n");
  }).join("\n\n");

  return attachmentText ? `${message.text}\n\n${attachmentText}` : message.text;
}

export { BRIDGE_SYSTEM_PROMPT, extractLatestReplyText, extractReplyText, formatInboundMessage, formatTransportInboundText, mapRuntimeState };
