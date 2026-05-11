import test from "node:test";
import assert from "node:assert/strict";
import {
  RUNTIME_DRIVER_ENV,
  loadPiCaLeashConfigSync,
  parseRuntimeDriverName,
  resolveRuntimeDriverFromEnv,
} from "../src/index.js";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("parseRuntimeDriverName accepts supported names and rejects others", () => {
  assert.equal(parseRuntimeDriverName("claude-sdk"), "claude-sdk");
  assert.equal(parseRuntimeDriverName("claude-cli"), "claude-cli");
  assert.equal(parseRuntimeDriverName("codex-cli"), "codex-cli");
  assert.equal(parseRuntimeDriverName(" codex-cli "), "codex-cli");
  assert.equal(parseRuntimeDriverName("wat"), undefined);
  assert.equal(parseRuntimeDriverName(undefined), undefined);
});

test("resolveRuntimeDriverFromEnv returns parsed runtime driver or undefined", () => {
  assert.equal(resolveRuntimeDriverFromEnv({ [RUNTIME_DRIVER_ENV]: "codex-cli" }), "codex-cli");
  assert.equal(resolveRuntimeDriverFromEnv({ [RUNTIME_DRIVER_ENV]: "claude-sdk" }), "claude-sdk");
  assert.equal(resolveRuntimeDriverFromEnv({ [RUNTIME_DRIVER_ENV]: "claude-cli" }), "claude-cli");
  assert.equal(resolveRuntimeDriverFromEnv({ [RUNTIME_DRIVER_ENV]: "wat" }), undefined);
  assert.equal(resolveRuntimeDriverFromEnv({}), undefined);
});

test("loadPiCaLeashConfigSync merges XDG, repository, and explicit config", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-ca-leash-config-"));
  const xdgHome = join(root, "xdg");
  const repo = join(root, "repo");
  const explicit = join(root, "override.json");
  await mkdir(join(xdgHome, "pi-ca-leash"), { recursive: true });
  await mkdir(join(repo, ".pi-ca-leash"), { recursive: true });
  await writeFile(join(xdgHome, "pi-ca-leash", "config.json"), JSON.stringify({
    defaultDriver: "claude-sdk",
    drivers: { "claude-cli": { executable: "/usr/bin/claude", permissionMode: "acceptEdits" } },
  }));
  await writeFile(join(repo, ".pi-ca-leash", "config.json"), JSON.stringify({
    defaultDriver: "claude-cli",
    drivers: { "codex-cli": { executable: "/usr/bin/codex" } },
  }));
  await writeFile(explicit, JSON.stringify({
    drivers: { "claude-cli": { executable: "/opt/claude" } },
  }));

  const loaded = loadPiCaLeashConfigSync({
    cwd: repo,
    env: { XDG_CONFIG_HOME: xdgHome, PI_CA_LEASH_CONFIG: explicit },
  });

  assert.equal(loaded.config.defaultDriver, "claude-cli");
  assert.equal(loaded.config.drivers?.["claude-cli"]?.executable, "/opt/claude");
  assert.equal(loaded.config.drivers?.["claude-cli"]?.permissionMode, "acceptEdits");
  assert.equal(loaded.config.drivers?.["codex-cli"]?.executable, "/usr/bin/codex");
  assert.equal(loaded.files.length, 3);
  assert.deepEqual(loaded.warnings, []);
});
