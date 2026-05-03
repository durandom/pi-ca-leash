import test from "node:test";
import assert from "node:assert/strict";
import {
  RUNTIME_DRIVER_ENV,
  parseRuntimeDriverName,
  resolveRuntimeDriverFromEnv,
} from "../src/index.js";

test("parseRuntimeDriverName accepts supported names and rejects others", () => {
  assert.equal(parseRuntimeDriverName("claude-sdk"), "claude-sdk");
  assert.equal(parseRuntimeDriverName("codex-cli"), "codex-cli");
  assert.equal(parseRuntimeDriverName(" codex-cli "), "codex-cli");
  assert.equal(parseRuntimeDriverName("wat"), undefined);
  assert.equal(parseRuntimeDriverName(undefined), undefined);
});

test("resolveRuntimeDriverFromEnv returns parsed runtime driver or undefined", () => {
  assert.equal(resolveRuntimeDriverFromEnv({ [RUNTIME_DRIVER_ENV]: "codex-cli" }), "codex-cli");
  assert.equal(resolveRuntimeDriverFromEnv({ [RUNTIME_DRIVER_ENV]: "claude-sdk" }), "claude-sdk");
  assert.equal(resolveRuntimeDriverFromEnv({ [RUNTIME_DRIVER_ENV]: "wat" }), undefined);
  assert.equal(resolveRuntimeDriverFromEnv({}), undefined);
});
