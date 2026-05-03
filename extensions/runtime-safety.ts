const PROMPT_WARNING_CHAR_THRESHOLD = 24_000;
const PROMPT_DANGER_CHAR_THRESHOLD = 100_000;

export function describePromptSize(label: string, text: string): string | undefined {
  const chars = text.length;
  if (chars < PROMPT_WARNING_CHAR_THRESHOLD) {
    return undefined;
  }

  const approxTokens = Math.ceil(chars / 4);
  const severity = chars >= PROMPT_DANGER_CHAR_THRESHOLD ? "large prompt risk" : "prompt size note";
  return `${severity}: ${label} is ${chars} chars (~${approxTokens} tokens). Prefer a smaller scoped prompt or point the peer at files instead of pasting large context.`;
}

export function explainRuntimeFailure(message: string, driver?: string, model?: string): string {
  const lower = message.toLowerCase();
  const hints: string[] = [];

  if (lower.includes("native binary not found") || lower.includes("claude code") && lower.includes("not found")) {
    hints.push("Claude Code executable was not found. Install Claude Code or set CLAUDE_CODE_EXECUTABLE to the native binary path.");
  }

  if (lower.includes("enoent") || lower.includes("spawn") && lower.includes("not found")) {
    const binary = driver === "codex-cli" ? "codex" : driver === "claude-sdk" ? "Claude Code" : "runtime";
    hints.push(`${binary} executable could not be spawned. Check PATH or configure the matching executable env var before starting peers.`);
  }

  if (lower.includes("bedrock")) {
    hints.push("The provider appears to route through Amazon Bedrock. Use a fully qualified catalog model id from runtime_models, or configure the required Bedrock credentials.");
  }

  if (lower.includes("api key") || lower.includes("apikey") || lower.includes("unauthorized")) {
    hints.push("Provider credentials are missing or rejected for this runtime/model.");
  }

  if (lower.includes("prompt is too long") || lower.includes("prompt too long") || lower.includes("context length")) {
    hints.push("The prompt exceeded the provider context budget. Split the task into smaller slices or ask the peer to inspect files instead of pasting large context.");
  }

  if (model && /^(opus|sonnet|haiku)$/i.test(model.trim())) {
    hints.push(`"${model}" is a shorthand alias; pi-ca-leash now resolves it before future runtime calls. Use runtime_models to inspect the exact id.`);
  }

  if (hints.length === 0) {
    return message;
  }

  return [message, ...[...new Set(hints)].map((hint) => `Hint: ${hint}`)].join("\n");
}
