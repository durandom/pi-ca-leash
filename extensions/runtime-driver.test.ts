import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RUNTIME_DRIVER_ENV,
  parseRuntimeDriverName,
  resolveExtensionRuntimeDriverConfig,
} from "./runtime-driver.ts";

test("parseRuntimeDriverName accepts supported names and rejects others", () => {
  assert.equal(parseRuntimeDriverName("claude-sdk"), "claude-sdk");
  assert.equal(parseRuntimeDriverName("codex-cli"), "codex-cli");
  assert.equal(parseRuntimeDriverName(" codex-cli "), "codex-cli");
  assert.equal(parseRuntimeDriverName("wat"), undefined);
  assert.equal(parseRuntimeDriverName(undefined), undefined);
});

test("default runtime driver is claude-sdk when env unset", () => {
  assert.deepEqual(resolveExtensionRuntimeDriverConfig({}), {
    defaultDriver: "claude-sdk",
  });
});

test("codex-cli env selects codex default driver", () => {
  assert.deepEqual(resolveExtensionRuntimeDriverConfig({
    [DEFAULT_RUNTIME_DRIVER_ENV]: "codex-cli",
  }), {
    defaultDriver: "codex-cli",
  });
});

test("invalid env falls back to claude-sdk with note", () => {
  assert.deepEqual(resolveExtensionRuntimeDriverConfig({
    [DEFAULT_RUNTIME_DRIVER_ENV]: "wat",
  }), {
    defaultDriver: "claude-sdk",
    note: `invalid ${DEFAULT_RUNTIME_DRIVER_ENV}=wat; using claude-sdk`,
  });
});
