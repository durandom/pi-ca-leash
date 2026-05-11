import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RUNTIME_DRIVER_ENV,
  parseRuntimeDriverName,
  resolveExtensionRuntimeDriverConfig,
} from "./runtime-driver.ts";

test("parseRuntimeDriverName accepts supported names and rejects others", () => {
  assert.equal(parseRuntimeDriverName("claude-sdk"), "claude-sdk");
  assert.equal(parseRuntimeDriverName("claude-cli"), "claude-cli");
  assert.equal(parseRuntimeDriverName("codex-cli"), "codex-cli");
  assert.equal(parseRuntimeDriverName(" codex-cli "), "codex-cli");
  assert.equal(parseRuntimeDriverName("wat"), undefined);
  assert.equal(parseRuntimeDriverName(undefined), undefined);
});

test("default runtime driver is claude-sdk when env and config are unset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-driver-"));
  const config = resolveExtensionRuntimeDriverConfig({ XDG_CONFIG_HOME: join(dir, "xdg") }, dir);
  assert.equal(config.defaultDriver, "claude-sdk");
  assert.deepEqual(config.config, {});
  assert.deepEqual(config.configFiles, []);
});

test("codex-cli env selects codex default driver", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-driver-"));
  const config = resolveExtensionRuntimeDriverConfig({
    [DEFAULT_RUNTIME_DRIVER_ENV]: "codex-cli",
    XDG_CONFIG_HOME: join(dir, "xdg"),
  }, dir);
  assert.equal(config.defaultDriver, "codex-cli");
  assert.deepEqual(config.config, {});
});

test("config can select claude-cli default driver", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-driver-"));
  await mkdir(join(dir, ".pi-ca-leash"), { recursive: true });
  await writeFile(join(dir, ".pi-ca-leash", "config.json"), JSON.stringify({ defaultDriver: "claude-cli" }));
  const config = resolveExtensionRuntimeDriverConfig({ XDG_CONFIG_HOME: join(dir, "xdg") }, dir);
  assert.equal(config.defaultDriver, "claude-cli");
  assert.equal(config.configFiles.length, 1);
});

test("invalid env falls back to configured default with note", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-driver-"));
  await mkdir(join(dir, ".pi-ca-leash"), { recursive: true });
  await writeFile(join(dir, ".pi-ca-leash", "config.json"), JSON.stringify({ defaultDriver: "claude-cli" }));
  const config = resolveExtensionRuntimeDriverConfig({
    [DEFAULT_RUNTIME_DRIVER_ENV]: "wat",
    XDG_CONFIG_HOME: join(dir, "xdg"),
  }, dir);
  assert.equal(config.defaultDriver, "claude-cli");
  assert.equal(config.note, `invalid ${DEFAULT_RUNTIME_DRIVER_ENV}=wat; using claude-cli`);
});
