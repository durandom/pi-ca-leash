import type { DriverEventEnvelope, RuntimeThinkingLevel } from "../types.js";
import type { SystemDriverMessage } from "./messages.js";

/** SDK-native vocabulary for `pi-coding-agent`'s `thinkingLevel` option. */
export type PiCodingAgentThinkingLevel = "off" | "low" | "medium" | "high";

/**
 * Fold the runtime's superset vocabulary down to `pi-coding-agent`'s native
 * four-step ladder. Callers can configure the vendor-native value
 * (`"minimal"`, `"xhigh"`) verbatim; the driver projects it before handing
 * to the SDK. Documented per-driver in CHANGELOG.
 */
export function foldThinkingLevelForPiCodingAgent(
  level: RuntimeThinkingLevel,
): PiCodingAgentThinkingLevel {
  switch (level) {
    case "off":
      return "off";
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
      return "high";
  }
}

/**
 * Which drivers consume `RuntimeDriverRunInput.thinkingLevel` and forward it
 * to the model. Surfaced on the init system event as
 * `metadata.thinkingLevelSupported` so audit consumers can detect the
 * silent-drop failure mode (e.g. PM-026 in spellkave) without running a
 * synthetic latency/usage probe. Update this table when a driver gains a
 * per-call thinking knob.
 */
export const DRIVER_THINKING_SUPPORTED: Record<string, boolean> = {
  "pi-coding-agent": true,
  "claude-sdk": false,
  "claude-cli": false,
  "codex-cli": false,
};

/**
 * Wrap an `onEvent` callback so the first `system/init` message it sees
 * gets enriched with `thinkingLevelSupported` and `effectiveThinkingLevel`
 * fields in its `metadata`. Used by drivers that forward an upstream init
 * (claude-sdk, claude-cli, codex-cli); `pi-coding-agent` builds its init
 * synthetically and sets the fields directly.
 */
export function enrichInitWithCapabilities(
  onEvent: (event: DriverEventEnvelope) => Promise<void> | void,
  capabilities: { thinkingLevelSupported: boolean; effectiveThinkingLevel?: string },
): (event: DriverEventEnvelope) => Promise<void> | void {
  let enriched = false;
  return (event) => {
    if (
      !enriched &&
      event.type === "message" &&
      event.payload.type === "system" &&
      event.payload.subtype === "init"
    ) {
      enriched = true;
      const system = event.payload as SystemDriverMessage;
      const merged: SystemDriverMessage = {
        ...system,
        metadata: {
          ...(system.metadata ?? {}),
          thinkingLevelSupported: capabilities.thinkingLevelSupported,
          ...(capabilities.effectiveThinkingLevel !== undefined
            ? { effectiveThinkingLevel: capabilities.effectiveThinkingLevel }
            : {}),
        },
      };
      return onEvent({ type: "message", payload: merged });
    }
    return onEvent(event);
  };
}
