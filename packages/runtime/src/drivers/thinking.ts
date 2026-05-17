import type { DriverEventEnvelope, RuntimeThinkingLevel } from "../types.js";
import type { SystemDriverMessage } from "./messages.js";

// ---------------------------------------------------------------------------
// Per-driver fold tables
// ---------------------------------------------------------------------------
//
// `RuntimeThinkingLevel` is Claude's `EffortLevel` (`low / medium / high /
// xhigh / max`). Each driver projects to its native vocabulary so the
// consumer never has to know which value a particular driver understands.
// Folds are intentionally lossy where vendor surfaces are narrower (e.g.
// pi-coding-agent's SDK + OpenAI's reasoning_effort both top out at
// `high`); the audit surface on the init event always echoes both the
// requested and the effective value so consumers can detect downgrades.

/** SDK-native vocabulary for `pi-coding-agent`'s `thinkingLevel`. */
export type PiCodingAgentThinkingLevel = "off" | "low" | "medium" | "high";

/** SDK-native `EffortLevel` exposed by `@anthropic-ai/claude-agent-sdk`. */
export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** Codex CLI's `model_reasoning_effort` accepts OpenAI's reasoning_effort enum. */
export type CodexReasoningEffort = "minimal" | "low" | "medium" | "high";

export function foldThinkingLevelForPiCodingAgent(
  level: RuntimeThinkingLevel,
): PiCodingAgentThinkingLevel {
  switch (level) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
  }
}

export function foldThinkingLevelForClaude(
  level: RuntimeThinkingLevel,
): ClaudeEffortLevel {
  // Native — passthrough.
  return level;
}

export function foldThinkingLevelForCodex(
  level: RuntimeThinkingLevel,
): CodexReasoningEffort {
  switch (level) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
  }
}

// ---------------------------------------------------------------------------
// Capability registry
// ---------------------------------------------------------------------------

/**
 * Whether the driver forwards `RuntimeDriverRunInput.thinkingLevel` to its
 * underlying SDK/CLI. Surfaced on the init system event as
 * `metadata.thinkingLevelSupported` (and `init.raw.thinkingLevelSupported`
 * on `pi-coding-agent`) so audit consumers can detect the silent-drop
 * failure mode without running a synthetic probe. All four built-in
 * drivers now forward — kept as a table so future drivers can opt out
 * explicitly and so consumers have a single place to inspect.
 */
export const DRIVER_THINKING_SUPPORTED: Record<string, boolean> = {
  "pi-coding-agent": true,
  "claude-sdk": true,
  "claude-cli": true,
  "codex-cli": true,
};

// ---------------------------------------------------------------------------
// Init-event enrichment — shared across non-pi-coding-agent drivers
// ---------------------------------------------------------------------------

export interface InitCapabilityFields {
  /** Whether this driver forwards thinkingLevel to its SDK/CLI. */
  thinkingLevelSupported: boolean;
  /** Verbatim caller value (or driver default), pre-fold. */
  requestedThinkingLevel?: RuntimeThinkingLevel;
  /** Value actually handed to the SDK/CLI after the per-driver fold. */
  effectiveThinkingLevel?: string;
}

/**
 * Wrap an `onEvent` callback so the first `system/init` message it sees
 * gets enriched with capability fields in its `metadata`. Used by drivers
 * that forward an upstream init (claude-sdk, claude-cli, codex-cli);
 * `pi-coding-agent` builds its init synthetically and sets the fields
 * directly on `init.raw`.
 */
export function enrichInitWithCapabilities(
  onEvent: (event: DriverEventEnvelope) => Promise<void> | void,
  capabilities: InitCapabilityFields,
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
      const capabilityFields: Record<string, unknown> = {
        thinkingLevelSupported: capabilities.thinkingLevelSupported,
      };
      if (capabilities.requestedThinkingLevel !== undefined) {
        capabilityFields.requestedThinkingLevel = capabilities.requestedThinkingLevel;
      }
      if (capabilities.effectiveThinkingLevel !== undefined) {
        capabilityFields.effectiveThinkingLevel = capabilities.effectiveThinkingLevel;
      }
      // Write into BOTH metadata and raw. The runtime forwards `raw` into
      // `status.raw.init` for consumer introspection but currently drops
      // `metadata` on the floor (see runtime.handleDriverEvent system case).
      // We keep metadata for driver-level event subscribers and copy into
      // raw so the same fields survive the runtime layer.
      const baseRaw =
        system.raw && typeof system.raw === "object" && !Array.isArray(system.raw)
          ? (system.raw as Record<string, unknown>)
          : { upstream: system.raw };
      const merged: SystemDriverMessage = {
        ...system,
        metadata: {
          ...(system.metadata ?? {}),
          ...capabilityFields,
        },
        raw: {
          ...baseRaw,
          ...capabilityFields,
        },
      };
      return onEvent({ type: "message", payload: merged });
    }
    return onEvent(event);
  };
}
