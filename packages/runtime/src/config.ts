import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { RuntimeDriverName, StartSessionInput } from "./types.js";
import { parseRuntimeDriverName } from "./driver-config.js";

export const PI_CA_LEASH_CONFIG_ENV = "PI_CA_LEASH_CONFIG";

export interface RuntimeDriverFileConfig {
  executable?: string;
  permissionMode?: StartSessionInput["permissionMode"];
}

export interface PiCaLeashConfig {
  defaultDriver?: RuntimeDriverName;
  drivers?: Partial<Record<RuntimeDriverName, RuntimeDriverFileConfig>>;
}

export interface LoadedPiCaLeashConfig {
  config: PiCaLeashConfig;
  files: string[];
  warnings: string[];
}

export function xdgConfigPath(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || resolve(homedir(), ".config");
  return resolve(base, "pi-ca-leash", "config.json");
}

export function repositoryConfigPath(cwd = process.cwd()): string {
  return resolve(cwd, ".pi-ca-leash", "config.json");
}

export function defaultConfigPaths(
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
): string[] {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  return [
    xdgConfigPath(env),
    repositoryConfigPath(cwd),
    ...(env[PI_CA_LEASH_CONFIG_ENV]?.trim() ? [resolve(cwd, env[PI_CA_LEASH_CONFIG_ENV]!.trim())] : []),
  ];
}

export function loadPiCaLeashConfigSync(
  options: { cwd?: string; env?: Record<string, string | undefined>; paths?: string[] } = {},
): LoadedPiCaLeashConfig {
  const paths = options.paths ?? defaultConfigPaths(options);
  const warnings: string[] = [];
  const files: string[] = [];
  let config: PiCaLeashConfig = {};

  for (const path of paths) {
    if (!existsSync(path)) {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const normalized = normalizeConfig(parsed, path, warnings);
      config = mergeConfig(config, normalized);
      files.push(path);
    } catch (error) {
      warnings.push(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { config, files, warnings };
}

function normalizeConfig(value: unknown, path: string, warnings: string[]): PiCaLeashConfig {
  if (!value || typeof value !== "object") {
    warnings.push(`Ignoring ${path}: expected JSON object`);
    return {};
  }
  const raw = value as Record<string, unknown>;
  const result: PiCaLeashConfig = {};

  const defaultDriver = parseRuntimeDriverName(raw.defaultDriver);
  if (raw.defaultDriver != null) {
    if (defaultDriver) {
      result.defaultDriver = defaultDriver;
    } else {
      warnings.push(`Ignoring ${path}: invalid defaultDriver=${String(raw.defaultDriver)}`);
    }
  }

  if (raw.drivers && typeof raw.drivers === "object") {
    const drivers: PiCaLeashConfig["drivers"] = {};
    for (const [key, driverValue] of Object.entries(raw.drivers as Record<string, unknown>)) {
      const driver = parseRuntimeDriverName(key);
      if (!driver) {
        warnings.push(`Ignoring ${path}: invalid driver config key ${key}`);
        continue;
      }
      if (!driverValue || typeof driverValue !== "object") {
        warnings.push(`Ignoring ${path}: driver ${key} config must be an object`);
        continue;
      }
      const item = driverValue as Record<string, unknown>;
      const normalized: RuntimeDriverFileConfig = {};
      if (typeof item.executable === "string" && item.executable.trim()) {
        normalized.executable = item.executable.trim();
      }
      if (typeof item.permissionMode === "string" && isPermissionMode(item.permissionMode)) {
        normalized.permissionMode = item.permissionMode;
      } else if (item.permissionMode != null) {
        warnings.push(`Ignoring ${path}: invalid ${key}.permissionMode=${String(item.permissionMode)}`);
      }
      drivers[driver] = normalized;
    }
    result.drivers = drivers;
  }

  return result;
}

function mergeConfig(base: PiCaLeashConfig, override: PiCaLeashConfig): PiCaLeashConfig {
  const drivers: PiCaLeashConfig["drivers"] = { ...(base.drivers ?? {}) };
  for (const [driver, value] of Object.entries(override.drivers ?? {}) as Array<[RuntimeDriverName, RuntimeDriverFileConfig]>) {
    drivers[driver] = {
      ...(drivers[driver] ?? {}),
      ...value,
    };
  }
  return {
    defaultDriver: override.defaultDriver ?? base.defaultDriver,
    drivers,
  };
}

function isPermissionMode(value: string): value is NonNullable<StartSessionInput["permissionMode"]> {
  return ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"].includes(value);
}
