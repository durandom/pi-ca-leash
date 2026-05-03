import test from "node:test";
import assert from "node:assert/strict";
import { describeModelSelection, findRuntimeModel, modelCatalogsForDriver } from "./model-catalog.ts";

test("model catalog maps runtime drivers to Lanista provider snapshots", () => {
  const claude = modelCatalogsForDriver("claude-sdk")[0]!;
  const codex = modelCatalogsForDriver("codex-cli")[0]!;

  assert.equal(claude.provider, "anthropic");
  assert.equal(claude.defaultModel, "claude-opus-4-7");
  assert.ok(findRuntimeModel("claude-sdk", "claude-sonnet-4-6"));

  assert.equal(codex.provider, "openai-codex");
  assert.equal(codex.defaultModel, "gpt-5.5");
  assert.ok(findRuntimeModel("codex-cli", "gpt-5.4-mini"));
});

test("model selection notes are advisory for unknown models", () => {
  assert.match(describeModelSelection("codex-cli", "gpt-future") ?? "", /not in bundled openai-codex catalog/);
  assert.equal(describeModelSelection("claude-sdk", undefined), "model default claude-opus-4-7");
});
