import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeRegistryPath, readBridgeRegistry } from "../src/persistence.js";

test("readBridgeRegistry returns empty peers for malformed json", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-persist-test-"));
  const file = bridgeRegistryPath(storageDir);
  await mkdir(join(storageDir), { recursive: true });
  await writeFile(file, '{\n  "peers": []\n}\n]\n}\n', "utf8");

  const registry = await readBridgeRegistry(storageDir);
  assert.deepEqual(registry, { peers: [] });
});

test("readBridgeRegistry filters invalid peer records", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "claude-intercom-bridge-persist-test-"));
  const file = bridgeRegistryPath(storageDir);
  await mkdir(join(storageDir), { recursive: true });
  await writeFile(file, JSON.stringify({
    peers: [
      { name: "ok", sessionId: "sid-1", kind: "managed", metadata: { owner: "castra", bad: 123 } },
      { name: "missing-session" },
      { sessionId: "missing-name" },
      { name: 123, sessionId: "sid-2" },
    ],
  }), "utf8");

  const registry = await readBridgeRegistry(storageDir);
  assert.deepEqual(registry, { peers: [{ name: "ok", sessionId: "sid-1", kind: "managed", metadata: { owner: "castra" } }] });
});
