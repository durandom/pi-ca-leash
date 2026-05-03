export const ADVANCED_COMMANDS_ENV = "PI_CLAUDE_ENABLE_ADVANCED_COMMANDS";

export function advancedCommandsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[ADVANCED_COMMANDS_ENV] === "1";
}
