import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { BridgePeerKind } from "./types.js";

export interface PersistedBridgePeerRecord {
  name: string;
  sessionId: string;
  kind?: BridgePeerKind;
  metadata?: Record<string, string>;
}

interface PersistedBridgeRegistry {
  peers: PersistedBridgePeerRecord[];
}

export function defaultBridgeStorageDir(): string {
  return resolve(process.cwd(), ".claude-intercom-bridge");
}

export function bridgeRegistryPath(storageDir: string): string {
  return join(storageDir, "peers.json");
}

export async function readBridgeRegistry(storageDir: string): Promise<PersistedBridgeRegistry> {
  try {
    const parsed = JSON.parse(await readFile(bridgeRegistryPath(storageDir), "utf8")) as {
      peers?: Array<{ name?: unknown; sessionId?: unknown; kind?: unknown; metadata?: unknown }>;
    };
    const peers = Array.isArray(parsed?.peers)
      ? parsed.peers
        .filter((peer): peer is { name: string; sessionId: string; kind?: BridgePeerKind; metadata?: Record<string, string> } =>
          typeof peer?.name === "string" && typeof peer?.sessionId === "string"
        )
        .map((peer) => ({
          name: peer.name,
          sessionId: peer.sessionId,
          kind: peer.kind === "managed" || peer.kind === "ad-hoc" ? peer.kind : undefined,
          metadata: sanitizeMetadata(peer.metadata),
        }))
      : [];
    return { peers };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return { peers: [] };
    }
    throw error;
  }
}

export async function writeBridgeRegistry(storageDir: string, registry: PersistedBridgeRegistry): Promise<void> {
  const path = bridgeRegistryPath(storageDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function sanitizeMetadata(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const entries = Object.entries(input)
    .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string");
  if (entries.length === 0) {
    return undefined;
  }
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}
