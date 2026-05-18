/**
 * Internal entry point for `@pi-claude-code-agent/runtime`.
 *
 * Importing from `@pi-claude-code-agent/runtime/internal` is a deliberate,
 * visible signal that you are reaching past the public Bridge surface to
 * the underlying supervisor.
 *
 * Legitimate uses are sibling supervisors (`intercom-bridge`,
 * `subagents-backend`, `teams-backend`) and harness-level smokes that need
 * to exercise the runtime directly. Application consumers should use the
 * `intercom-bridge` (`ClaudeRuntimeIntercomBridge` / `PiCaLeashManagedPeerApi`)
 * surface instead — every gap there should be filed as a Bridge feature
 * request, not a silent bypass via this entry point.
 */
export { ClaudeCodeRuntime } from "./runtime.js";
