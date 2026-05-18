import { resolve } from "node:path";
import type {
  RuntimeDriverName,
  RuntimeEvent,
  RuntimeOptions,
  RuntimeSessionId,
  TranscriptChunk,
} from "@pi-claude-code-agent/runtime";
import { ClaudeRuntimeIntercomBridge } from "./bridge.js";
import type {
  AskResult,
  AttachPeerInput,
  BridgeOptions,
  BridgePeer,
  InterruptPeerResult,
  LaunchPeerInput,
  WaitForCompletionOptions,
} from "./types.js";
import type { RuntimeStatus } from "@pi-claude-code-agent/runtime";

export const PI_CA_LEASH_STATE_DIR_NAME = ".pi-ca-leash";

export function piCaLeashStateDir(cwd = process.cwd()): string {
  return resolve(cwd, PI_CA_LEASH_STATE_DIR_NAME);
}

export function piCaLeashRuntimeStorageDir(cwd = process.cwd()): string {
  return resolve(piCaLeashStateDir(cwd), "runtime");
}

export function piCaLeashBridgeStorageDir(cwd = process.cwd()): string {
  return resolve(piCaLeashStateDir(cwd), "bridge");
}

export interface ManagedPeerApiOptions extends Pick<BridgeOptions, "transport" | "pollIntervalMs" | "askTimeoutMs"> {
  cwd?: string;
  bridge?: ClaudeRuntimeIntercomBridge;
  defaultDriver?: RuntimeDriverName;
  /**
   * Optional overrides for the embedded Runtime's construction. Merged on top
   * of the defaults derived from `cwd` and `defaultDriver`. Use this to inject
   * a custom driver/resolver (e.g. tests with a fake driver) without exposing
   * the Runtime instance.
   */
  runtimeOptions?: Omit<RuntimeOptions, "storageDir" | "defaultDriver"> & {
    storageDir?: string;
    defaultDriver?: RuntimeDriverName;
  };
}

export class PiCaLeashManagedPeerApi {
  readonly bridge: ClaudeRuntimeIntercomBridge;

  constructor(options: ManagedPeerApiOptions = {}) {
    const cwd = resolve(options.cwd ?? process.cwd());
    this.bridge = options.bridge ?? new ClaudeRuntimeIntercomBridge({
      runtimeOptions: {
        storageDir: piCaLeashRuntimeStorageDir(cwd),
        defaultDriver: options.defaultDriver,
        ...options.runtimeOptions,
      },
      storageDir: piCaLeashBridgeStorageDir(cwd),
      transport: options.transport,
      pollIntervalMs: options.pollIntervalMs,
      askTimeoutMs: options.askTimeoutMs,
    });
  }

  async launchPeer(input: LaunchPeerInput): Promise<BridgePeer> {
    return this.bridge.launchPeer({
      ...input,
      kind: input.kind ?? "managed",
    });
  }

  async attachPeer(input: AttachPeerInput): Promise<BridgePeer> {
    return this.bridge.attachPeer({
      ...input,
      kind: input.kind ?? "managed",
    });
  }

  async listPeers(): Promise<BridgePeer[]> {
    return this.bridge.listPeers();
  }

  async status(name: string): Promise<BridgePeer | undefined> {
    return this.bridge.status(name);
  }

  async statusBySessionId(sessionId: RuntimeSessionId): Promise<BridgePeer | undefined> {
    return this.bridge.statusBySessionId(sessionId);
  }

  async events(sessionId: RuntimeSessionId, cursor = 0): Promise<TranscriptChunk> {
    return this.bridge.events(sessionId, cursor);
  }

  subscribe(listener: (event: RuntimeEvent) => void, sessionId?: RuntimeSessionId): () => void {
    return this.bridge.subscribe(listener, sessionId);
  }

  /**
   * Event-driven wait for a session to reach a terminal state, with
   * staleness + hard-ceiling backstops. Driver-aware defaults are picked
   * from the session's runtime driver. See `ClaudeRuntimeIntercomBridge.waitForCompletion`.
   */
  async waitForCompletion(sessionId: RuntimeSessionId, opts?: WaitForCompletionOptions): Promise<RuntimeStatus> {
    return this.bridge.waitForCompletion(sessionId, opts);
  }

  async reconcilePeers(): Promise<BridgePeer[]> {
    return this.bridge.reconcilePeers();
  }

  async send(name: string, message: Parameters<ClaudeRuntimeIntercomBridge["send"]>[1], options?: Parameters<ClaudeRuntimeIntercomBridge["send"]>[2]): Promise<BridgePeer> {
    return this.bridge.send(name, message, options);
  }

  async ask(name: string, message: Parameters<ClaudeRuntimeIntercomBridge["ask"]>[1]): Promise<AskResult> {
    return this.bridge.ask(name, message);
  }

  async reply(name: string, message: Parameters<ClaudeRuntimeIntercomBridge["reply"]>[1]): Promise<BridgePeer> {
    return this.bridge.reply(name, message);
  }

  async interrupt(name: string): Promise<BridgePeer> {
    return this.bridge.interrupt(name);
  }

  async interruptWithResult(name: string): Promise<InterruptPeerResult> {
    return this.bridge.interruptWithResult(name);
  }

  async stop(name: string): Promise<BridgePeer> {
    return this.bridge.stop(name);
  }

  async close(): Promise<void> {
    await this.bridge.close();
  }
}
