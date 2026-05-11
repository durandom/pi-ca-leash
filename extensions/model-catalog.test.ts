import test from "node:test";
import assert from "node:assert/strict";
import { describeModelSelection, findRuntimeModel, modelCatalogsForDriver, resolveRuntimeModelSelection } from "./model-catalog.ts";

test("model catalog maps runtime drivers to Lanista provider snapshots", () => {
  const claude = modelCatalogsForDriver("claude-sdk")[0]!;
  const claudeCli = modelCatalogsForDriver("claude-cli")[0]!;
  const codex = modelCatalogsForDriver("codex-cli")[0]!;

  assert.equal(claude.provider, "anthropic");
  assert.equal(claude.defaultModel, "claude-opus-4-7");
  assert.equal(claude.aliases.sonnet, "claude-sonnet-4-6");
  assert.deepEqual(claude.recommendations.map((entry) => entry.alias), ["opus", "sonnet", "haiku"]);
  assert.ok(findRuntimeModel("claude-sdk", "claude-sonnet-4-6"));
  assert.equal(claudeCli.driver, "claude-cli");
  assert.equal(claudeCli.provider, "anthropic");
  assert.ok(findRuntimeModel("claude-cli", "claude-sonnet-4-6"));

  assert.equal(codex.provider, "openai-codex");
  assert.equal(codex.defaultModel, "gpt-5.5");
  assert.equal(codex.aliases.mini, "gpt-5.4-mini");
  assert.deepEqual(codex.recommendations.map((entry) => entry.alias), ["default", "codex", "mini", "spark"]);
  assert.ok(findRuntimeModel("codex-cli", "gpt-5.4-mini"));
});

test("model aliases resolve to concrete runtime model ids", () => {
  const sonnet = resolveRuntimeModelSelection("claude-sdk", "sonnet");
  assert.equal(sonnet.runtimeModel, "claude-sonnet-4-6");
  assert.match(sonnet.note, /model alias sonnet -> model claude-sonnet-4-6/);

  const mini = resolveRuntimeModelSelection("codex-cli", "mini");
  assert.equal(mini.runtimeModel, "gpt-5.4-mini");
});

test("model selection notes are advisory for unknown models", () => {
  assert.match(describeModelSelection("codex-cli", "gpt-future") ?? "", /not in bundled openai-codex catalog/);
  assert.equal(describeModelSelection("claude-sdk", undefined), "model default claude-opus-4-7");
});
