import type { RuntimeDriverName } from "./types.js";

export const RUNTIME_DRIVER_ENV = "PI_CLAUDE_RUNTIME_DRIVER";

export function parseRuntimeDriverName(value: unknown): RuntimeDriverName | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "claude-sdk" ||
    trimmed === "claude-cli" ||
    trimmed === "codex-cli" ||
    trimmed === "pi-coding-agent"
    ? trimmed
    : undefined;
}

export function resolveRuntimeDriverFromEnv(
  env: Record<string, string | undefined> = process.env,
): RuntimeDriverName | undefined {
  return parseRuntimeDriverName(env[RUNTIME_DRIVER_ENV]);
}
