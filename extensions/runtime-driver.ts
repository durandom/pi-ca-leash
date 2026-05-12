import { loadPiCaLeashConfigSync, type RuntimeDriverName, type PiCaLeashConfig } from "@pi-claude-code-agent/runtime";

export const DEFAULT_RUNTIME_DRIVER_ENV = "PI_CLAUDE_RUNTIME_DRIVER";

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

export interface ExtensionRuntimeDriverConfig {
  defaultDriver: RuntimeDriverName;
  note?: string;
  config: PiCaLeashConfig;
  configFiles: string[];
}

export function resolveExtensionRuntimeDriverConfig(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): ExtensionRuntimeDriverConfig {
  const loaded = loadPiCaLeashConfigSync({ cwd, env });
  const raw = env[DEFAULT_RUNTIME_DRIVER_ENV]?.trim();
  if (!raw) {
    return {
      defaultDriver: loaded.config.defaultDriver ?? "claude-sdk",
      note: loaded.warnings.length > 0 ? loaded.warnings.join("\n") : undefined,
      config: loaded.config,
      configFiles: loaded.files,
    };
  }
  const parsed = parseRuntimeDriverName(raw);
  if (parsed) {
    return {
      defaultDriver: parsed,
      note: loaded.warnings.length > 0 ? loaded.warnings.join("\n") : undefined,
      config: loaded.config,
      configFiles: loaded.files,
    };
  }
  return {
    defaultDriver: loaded.config.defaultDriver ?? "claude-sdk",
    note: [`invalid ${DEFAULT_RUNTIME_DRIVER_ENV}=${raw}; using ${loaded.config.defaultDriver ?? "claude-sdk"}`, ...loaded.warnings].join("\n"),
    config: loaded.config,
    configFiles: loaded.files,
  };
}
