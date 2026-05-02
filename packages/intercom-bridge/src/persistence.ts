import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface PersistedBridgePeerRecord {
  name: string;
  sessionId: string;
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
      peers?: Array<{ name?: unknown; sessionId?: unknown }>;
    };
    const peers = Array.isArray(parsed?.peers)
      ? parsed.peers
        .filter((peer): peer is { name: string; sessionId: string } =>
          typeof peer?.name === "string" && typeof peer?.sessionId === "string"
        )
        .map((peer) => ({ name: peer.name, sessionId: peer.sessionId }))
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
