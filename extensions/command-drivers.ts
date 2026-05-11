import type { RuntimeDriverName } from "@pi-claude-code-agent/runtime";
import { parseRuntimeDriverName } from "./runtime-driver.js";

export interface ParsedPeerStartCommandInput {
  name?: string;
  prompt: string;
  driver?: RuntimeDriverName;
  model?: string;
  autoNamed: boolean;
}

export interface ParsedSubagentRunCommandInput {
  task: string;
  driver?: RuntimeDriverName;
}

export interface ParsedTeamSpawnCommandInput {
  name: string;
  prompt: string;
  driver?: RuntimeDriverName;
}

export function parsePeerStartCommandInput(args: string): ParsedPeerStartCommandInput {
  const parts = args.split("|").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return { prompt: "", autoNamed: false };
  }
  if (parts.length === 1) {
    return {
      prompt: parts[0] ?? "",
      autoNamed: true,
    };
  }
  if (parts.length === 2) {
    const driver = parseRuntimeDriverName(parts[0]);
    if (driver) {
      return {
        prompt: parts[1] ?? "",
        driver,
        autoNamed: true,
      };
    }
    return {
      name: parts[0],
      prompt: parts[1] ?? "",
      autoNamed: false,
    };
  }
  if (parts.length > 4) {
    throw new Error("usage: <prompt> | [driver] | [model] OR <name> | <prompt> | [driver] | [model]");
  }
  if (parts.length === 3) {
    const autoNamedDriver = parseRuntimeDriverName(parts[1]);
    if (autoNamedDriver) {
      return {
        prompt: parts[0] ?? "",
        driver: autoNamedDriver,
        model: parts[2] ?? undefined,
        autoNamed: true,
      };
    }
    const driver = parseRuntimeDriverName(parts[2]);
    if (!driver) {
      throw new Error("driver must be claude-sdk, claude-cli, or codex-cli when using a driver-aware peer start form");
    }
    return {
      name: parts[0],
      prompt: parts[1] ?? "",
      driver,
      autoNamed: false,
    };
  }
  const driver = parseRuntimeDriverName(parts[2]);
  if (!driver) {
    throw new Error("driver must be claude-sdk, claude-cli, or codex-cli when using <name> | <prompt> | <driver> | <model>");
  }
  return {
    name: parts[0],
    prompt: parts[1] ?? "",
    driver,
    model: parts[3] ?? undefined,
    autoNamed: false,
  };
}

export function parseSubagentRunCommandInput(args: string): ParsedSubagentRunCommandInput {
  const trimmed = args.trim();
  if (!trimmed) {
    return { task: "" };
  }
  const parts = trimmed.split("|").map((part) => part.trim());
  if (parts.length === 1) {
    return { task: parts[0] ?? "" };
  }
  const driver = parseRuntimeDriverName(parts[0]);
  if (!driver) {
    throw new Error("driver must be claude-sdk, claude-cli, or codex-cli when using <driver> | <task>");
  }
  return {
    driver,
    task: parts.slice(1).join(" | ").trim(),
  };
}

export function parseTeamSpawnCommandInput(args: string): ParsedTeamSpawnCommandInput {
  const parts = args.split("|").map((part) => part.trim());
  if (parts.length < 2) {
    return { name: parts[0] ?? "", prompt: "" };
  }
  const [name, prompt, maybeDriver, ...rest] = parts;
  if (rest.length > 0) {
    throw new Error("usage: <name> | <prompt> | [driver]");
  }
  if (!maybeDriver) {
    return { name: name ?? "", prompt: prompt ?? "" };
  }
  const driver = parseRuntimeDriverName(maybeDriver);
  if (!driver) {
    throw new Error("driver must be claude-sdk, claude-cli, or codex-cli when using <name> | <prompt> | <driver>");
  }
  return {
    name: name ?? "",
    prompt: prompt ?? "",
    driver,
  };
}
