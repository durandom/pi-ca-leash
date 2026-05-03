export const ADVANCED_COMMANDS_ENV = "PI_CLAUDE_ENABLE_ADVANCED_COMMANDS";
export const LEGACY_COMMANDS_ENV = "PI_CA_LEASH_ENABLE_LEGACY_COMMANDS";

export function advancedCommandsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[ADVANCED_COMMANDS_ENV] === "1";
}

export function legacyCommandsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[LEGACY_COMMANDS_ENV] === "1";
}
