import test from "node:test";
import assert from "node:assert/strict";
import { describePromptSize, explainRuntimeFailure } from "./runtime-safety.ts";

test("describePromptSize warns for large prompts", () => {
  assert.equal(describePromptSize("peer prompt", "small"), undefined);

  const note = describePromptSize("peer prompt", "x".repeat(24_000));
  assert.match(note ?? "", /prompt size note/);
  assert.match(note ?? "", /peer prompt is 24000 chars/);
});

test("explainRuntimeFailure adds actionable runtime hints", () => {
  const binary = explainRuntimeFailure("Claude Code native binary not found", "claude-sdk");
  assert.match(binary, /CLAUDE_CODE_EXECUTABLE/);

  const bedrock = explainRuntimeFailure("Amazon Bedrock rejected request: missing API key", "claude-sdk", "opus");
  assert.match(bedrock, /runtime_models/);
  assert.match(bedrock, /credentials/);
  assert.match(bedrock, /shorthand alias/);
});
