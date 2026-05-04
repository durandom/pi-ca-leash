import { resolve } from "node:path";
import { ClaudeCodeRuntime, type RuntimeDriverName } from "@pi-claude-code-agent/runtime";
import { ClaudeRuntimeIntercomBridge } from "./bridge.js";
import type {
  AskResult,
  AttachPeerInput,
  BridgeOptions,
  BridgePeer,
  InterruptPeerResult,
  LaunchPeerInput,
} from "./types.js";

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
  runtime?: ClaudeCodeRuntime;
  bridge?: ClaudeRuntimeIntercomBridge;
  defaultDriver?: RuntimeDriverName;
}

export class PiCaLeashManagedPeerApi {
  readonly runtime: ClaudeCodeRuntime;
  readonly bridge: ClaudeRuntimeIntercomBridge;

  constructor(options: ManagedPeerApiOptions = {}) {
    const cwd = resolve(options.cwd ?? process.cwd());
    this.runtime = options.runtime ?? new ClaudeCodeRuntime({
      storageDir: piCaLeashRuntimeStorageDir(cwd),
      defaultDriver: options.defaultDriver,
    });
    this.bridge = options.bridge ?? new ClaudeRuntimeIntercomBridge({
      runtime: this.runtime,
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
