import type { RuntimeDriverName } from "@pi-claude-code-agent/runtime";

export const DEFAULT_RUNTIME_DRIVER_ENV = "PI_CLAUDE_RUNTIME_DRIVER";

export function parseRuntimeDriverName(value: unknown): RuntimeDriverName | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "claude-sdk" || trimmed === "codex-cli" ? trimmed : undefined;
}

export interface ExtensionRuntimeDriverConfig {
  defaultDriver: RuntimeDriverName;
  note?: string;
}

export function resolveExtensionRuntimeDriverConfig(
  env: Record<string, string | undefined> = process.env,
): ExtensionRuntimeDriverConfig {
  const raw = env[DEFAULT_RUNTIME_DRIVER_ENV]?.trim();
  if (!raw) {
    return { defaultDriver: "claude-sdk" };
  }
  const parsed = parseRuntimeDriverName(raw);
  if (parsed) {
    return { defaultDriver: parsed };
  }
  return {
    defaultDriver: "claude-sdk",
    note: `invalid ${DEFAULT_RUNTIME_DRIVER_ENV}=${raw}; using claude-sdk`,
  };
}
