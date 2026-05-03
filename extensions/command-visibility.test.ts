import test from "node:test";
import assert from "node:assert/strict";
import { ADVANCED_COMMANDS_ENV, LEGACY_COMMANDS_ENV, advancedCommandsEnabled, legacyCommandsEnabled } from "./command-visibility.ts";

test("advanced commands stay hidden by default", () => {
  assert.equal(advancedCommandsEnabled({}), false);
  assert.equal(advancedCommandsEnabled({ [ADVANCED_COMMANDS_ENV]: "0" }), false);
});

test("advanced commands can be re-enabled explicitly", () => {
  assert.equal(advancedCommandsEnabled({ [ADVANCED_COMMANDS_ENV]: "1" }), true);
});

test("legacy claude commands stay hidden by default", () => {
  assert.equal(legacyCommandsEnabled({}), false);
  assert.equal(legacyCommandsEnabled({ [LEGACY_COMMANDS_ENV]: "0" }), false);
});

test("legacy claude commands can be re-enabled explicitly", () => {
  assert.equal(legacyCommandsEnabled({ [LEGACY_COMMANDS_ENV]: "1" }), true);
});
