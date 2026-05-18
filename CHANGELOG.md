# Changelog

All notable changes to this repository should be recorded here.

## 1.1.0 - 2026-05-18

### Added — Bridge `waitForCompletion` (#14)
- New `ClaudeRuntimeIntercomBridge.waitForCompletion(sessionId, opts)` and `PiCaLeashManagedPeerApi.waitForCompletion(sessionId, opts)` passthrough. Replaces the consumer-side 1 Hz polling loop in `waitForIdle`-style helpers with an event-driven wait. Subscribes to the runtime event stream and resets the staleness window on every observable driver event (message / tool / result / state change) — a peer that has been busy for an hour producing tool calls is correctly distinguished from one that has been silent for an hour.
- Termination order: terminal state (`idle`, `interrupted`, `failed`, `stopped`) → resolve; staleness past `staleThresholdMs` → reject `WaitCompletionError` code `WAIT_STALE`; wall-clock past `hardCeilingMs` → reject `WAIT_HARD_CEILING`; `signal.aborted` → reject with `signal.reason` verbatim.
- `state: "failed"` is a resolution, not a rejection — inspect `status.state` and `status.lastError`. To make failures hard to miss the bridge emits one `console.warn` per failed resolution. Suppress with `silentOnFailure: true` (typical only in tests that *expect* a failure).
- Driver-aware default staleness threshold via the exported `defaultStaleThresholdMsForDriver(driverName)` helper — `claude-sdk` / `claude-cli`: 2 min; `codex-cli` / `pi-coding-agent`: 5 min. Override per call with `staleThresholdMs`.
- Listen-then-look ordering: the runtime subscribe is wired *before* the status snapshot, so a peer that lands terminal between the two calls cannot be missed.
- Public exports: `WaitCompletionError`, `WaitForCompletionOptions`, `WaitCompletionErrorCode`, `defaultStaleThresholdMsForDriver` from `@pi-claude-code-agent/intercom-bridge`.

### Fixed — Bridge bootstrap window (#11)
- `bridge.send` / `bridge.ask` no longer reject with `PEER_BUSY` against a peer that is still inside its `launchPeer({ waitForIdle: false })` bootstrap run. The previous starting-window wait only handled the `starting` state; drivers that emit `system/init` quickly (the claude-sdk iterator, fake drivers in tests) flip to `busy` while the launch prompt is still running, and the bridge incorrectly treated that as "real" busy. The bridge now tracks per-name bootstrap state (set when `launchPeer` is called with `waitForIdle: false`, cleared on the first observed terminal state) and treats `busy` as a starting-window state while bootstrapping. Once the launch run completes, real follow-up `busy` correctly rejects `PEER_BUSY`. Resolves two long-standing flaky bridge tests on the "send through starting window" path that were 100 % red in CI.

### Fixed — codex driver flag (#13)
- `codex-cli` driver emits `--sandbox workspace-write` instead of the deprecated `--full-auto` alias for `securityMode: "safe"` (the default). `yolo` mode still uses `--dangerously-bypass-approvals-and-sandbox`. End-to-end semantics are identical (same bwrap `--unshare-net`, same seccomp filter, same `additionalDirectories` plumbing) — the change removes the deprecation warning that was cluttering every safe-mode session's stderr against codex-cli 0.130.0+ and protects against a future codex release dropping the alias.

### Fixed — extension tests
- `extensions/command-parity.test.ts` and `extensions/llm-tools.test.ts` import `ClaudeCodeRuntime` from `packages/runtime/src/internal.ts` instead of `packages/runtime/src/index.ts`. The class moved to the `/internal` sub-path in 1.0 but these two tests were missed in the refactor — they have been broken since the 1.0 release. `npm test` is fully green again.

### Migration

No breaking changes. Existing consumers can adopt `waitForCompletion` incrementally:

```diff
- // Old: polling loop in consumer code
- while ((await managedApi.statusBySessionId(sid))?.state === "busy") {
-   if (Date.now() - started > hardCeilingMs) throw new Error("timeout");
-   await sleep(1000);
- }
+ // New: event-driven, with explicit staleness + hard ceiling
+ const status = await managedApi.waitForCompletion(sid, {
+   staleThresholdMs: 5 * 60_000,
+   hardCeilingMs: 60 * 60_000,
+ });
+ if (status.state === "failed") {
+   // status.lastError carries the captured driver error
+ }
```

## 1.0.0 - 2026-05-18

### Breaking
- `PiCaLeashManagedPeerApi.runtime` is removed (issue [#9](https://github.com/durandom/pi-ca-leash/issues/9)). Callers that previously reached past the Bridge to use the embedded Runtime directly (`managedApi.runtime.send`, `managedApi.runtime.events`, etc.) must use the Bridge surface — see "Added" below for the new sessionId-keyed Bridge methods. This was the load-bearing escape hatch that made it possible to silently drop driver fields like `securityMode` (cause of #8); closing it forces every gap in the Bridge to surface as a feature request rather than a quiet bypass.
- `ManagedPeerApiOptions.runtime` removed. Configure the embedded Runtime via the new `runtimeOptions` field (driver, storageDir, defaultDriver, etc.) — the Runtime instance itself stays internal to the API.
- **`ClaudeCodeRuntime` is no longer exported from `@pi-claude-code-agent/runtime`.** It moved to the `@pi-claude-code-agent/runtime/internal` sub-path. Importing the class from the top-level entry point now fails — a deliberate, visible signal that you are reaching past the public Bridge surface. Sibling supervisors (`intercom-bridge`, `subagents-backend`, `teams-backend`, harness smokes) import from `/internal`. Application consumers should use `@pi-claude-code-agent/intercom-bridge` instead.
- `BridgeOptions.runtimeOptions` is new and used in the common case where the Bridge owns its Runtime. `BridgeOptions.runtime` is retained for the sibling-sharing case (e.g. the extension shares one Runtime between the Bridge and `ClaudeCodeSubagentBackend` so they see a single in-process event source); if both are passed, `runtime` wins.

### Added — Bridge feature parity (#9)
- **Pass-through invariant**: `bridge.deliver` / `bridge.send` / `bridge.ask` / `bridge.reply` now forward every driver field from the inbound intercom message verbatim to `runtime.send`. `securityMode`, `thinkingLevel`, `appendSystemPrompt`, `env`, and `model` reach the driver unchanged. Drivers ignore fields they don't recognise. This is the load-bearing fix that prevents future #8-style regressions when new driver fields are added — the Bridge does not need a release. Covered by a dedicated regression test in `packages/intercom-bridge/test/bridge.test.ts`.
- `IntercomInboundMessage` gains optional `appendSystemPrompt`, `env`, `thinkingLevel`, and `securityMode` fields (the per-message pass-through surface).
- **`BridgePeer.raw`** projection of `RuntimeStatus.raw` (issue [#9](https://github.com/durandom/pi-ca-leash/issues/9)). Bridge consumers can now read driver init capability fields (`requestedThinkingLevel`, `effectiveThinkingLevel`, `thinkingLevelSupported`, etc.) via `bridge.status(name).raw.init` — the runtime folds system/init driver messages into `status.raw.init` rather than emitting them as transcript events, so this is the only consumer-visible surface. Without this projection callers would have had to drop to `runtime.status(sid).raw.init`, re-creating the bypass pattern #9 closes.
- **sessionId-keyed Bridge methods**:
  - `bridge.statusBySessionId(sessionId)` — lookup that mirrors `bridge.status(name)` but takes the runtime sessionId callers already hold from `launchPeer` or events.
  - `bridge.events(sessionId, cursor?)` — Bridge-routed transcript fetch.
  - `bridge.subscribe(listener, sessionId?)` — passthrough subscription to the raw `RuntimeEvent` stream, optionally filtered.
- `PiCaLeashManagedPeerApi` mirrors all three sessionId-keyed methods so consumers don't need to reach into `.bridge`.
- `ManagedPeerApiOptions.runtimeOptions` lets callers (including tests) inject a custom driver / resolver into the embedded Runtime without taking a handle to the instance.

### Fixed
- `claude-sdk` driver no longer wedges at `state="running"` when the SDK's native child is externally `SIGKILL`ed (issue [#7](https://github.com/durandom/pi-ca-leash/issues/7)). The driver now attaches a watchdog to the SDK's underlying subprocess; on `close`/`exit` it aborts the in-process iterator after a 5 s grace window and the run transitions to `failed` (code 137, signal `SIGKILL`). If the SDK ever stops exposing a reachable subprocess handle the driver logs one warning and degrades to the previous behavior. Decision record: `docs/design-issue-7-claude-sdk-wedge.md`.
- `securityMode` is now session-sticky across resumes (issue [#8](https://github.com/durandom/pi-ca-leash/issues/8)). `start()` persists the resolved mode into `RuntimeStatus`; `send()` re-applies it on every subsequent turn unless the caller passes an explicit `securityMode` override (which then becomes the new persisted canonical value, matching the existing `model`-override semantics). Previously the codex-cli sandbox silently regressed to `safe` on resume, breaking git writes inside sibling-tree worktrees with `EROFS` on `.git/worktrees/<wt>/index.lock`.
- The Bridge previously forwarded only `{sessionId, message, model}` to `runtime.send` — the upstream cause of #8 and the reason callers had to bypass the Bridge to keep `securityMode` sticky. With the pass-through invariant in place, callers that had to use `managedApi.runtime.send` directly can move back to `bridge.send` / `managedApi.send`.

### Added — other
- `ClaudeSdkDriver` constructor accepts a `childDeathGraceMs` option (default 5000) for tests and hosts that want a tighter / looser death-detection window.
- `RuntimeStatus.securityMode` is a new persisted field.

### Migration

Consumers (e.g. `spellkave/packages/work-issue-runtime`):

```diff
- managedApi.runtime.send({ sessionId, message, securityMode, thinkingLevel })
+ managedApi.send(name, { from, text: message, securityMode, thinkingLevel })

- managedApi.runtime.events(sessionId)
+ managedApi.events(sessionId)

- managedApi.runtime.status(sessionId)
+ managedApi.statusBySessionId(sessionId)

- managedApi.runtime.subscribe(listener, sessionId)
+ managedApi.subscribe(listener, sessionId)
```

Bridge consumers who were injecting a Runtime via `BridgeOptions.runtime` only because the public surface lacked features (rather than for sibling sharing) should switch to `runtimeOptions`:

```diff
- new ClaudeRuntimeIntercomBridge({ runtime: new ClaudeCodeRuntime({ driver, storageDir }) })
+ new ClaudeRuntimeIntercomBridge({ runtimeOptions: { driver, storageDir } })
```

Sibling supervisors that legitimately need the `ClaudeCodeRuntime` class (e.g. you are building a parallel backend on top of the runtime, not a Bridge consumer) must import from the `/internal` sub-path:

```diff
- import { ClaudeCodeRuntime } from "@pi-claude-code-agent/runtime";
+ import { ClaudeCodeRuntime } from "@pi-claude-code-agent/runtime/internal";
```

## 0.16.1 - 2026-05-17

### Fixed
- `claude-sdk`, `claude-cli`, and `codex-cli` drivers: capability fields (`thinkingLevelSupported`, `requestedThinkingLevel`, `effectiveThinkingLevel`) added in v0.16 via `enrichInitWithCapabilities` were written into `SystemDriverMessage.metadata` only — but the runtime's `handleDriverEvent` system-init handler forwards `message.raw` to `status.raw.init` and drops `metadata` on the floor. Net effect: the capability surface was invisible to consumers for three of the four drivers. The helper now merges the fields into **both** `metadata` (for driver-level event subscribers) and `raw` (so the same fields survive into `status.raw.init`). `pi-coding-agent` was unaffected because it writes the fields directly into its synthetic `raw` payload.
- Verified end-to-end with `npm run smoke:thinking`: real Anthropic + OpenAI calls produce `thinking` content blocks (claude-sdk, claude-cli) or `reasoning_output_tokens > 0` (codex-cli) when `thinkingLevel: "high"` (or `"max"` for Anthropic, which only engages thinking on non-trivial prompts).

### Added
- `npm run smoke:thinking` opt-in E2E smoke (`scripts/smoke-thinking.mjs`) that asserts (a) the init capability surface for each driver and (b) that the model actually reasoned (thinking blocks for Anthropic, `reasoning_output_tokens` for OpenAI). Skips a driver when its CLI / SDK / credentials are missing.

## 0.16.0 - 2026-05-17

### Breaking
- `RuntimeThinkingLevel` is now Claude's `EffortLevel` (5 values): `"low" | "medium" | "high" | "xhigh" | "max"`. Dropped `"off"` and `"minimal"` from the v0.15 superset. Each driver folds these five values down to its own native vocabulary internally; consumers no longer need to know which value a particular driver understands. Migration: drop `"off"` entirely (omit the field to use the vendor default), replace `"minimal"` with `"low"` (semantically equivalent on every driver under the old fold table).

### Fixed
- `claude-sdk`, `claude-cli`, and `codex-cli` drivers now actually forward `thinkingLevel` to their underlying SDK/CLI. v0.15 surfaced the value in the type but silently dropped it — three of the four drivers were leaving thinking tokens on the table. Sources verified:
  - `claude-sdk`: `Options.effort` accepts `low | medium | high | xhigh | max` ([`@anthropic-ai/claude-agent-sdk` exports `EffortLevel`](https://docs.anthropic.com/en/docs/build-with-claude/effort)).
  - `claude-cli`: `--effort <level>` with the same five values.
  - `codex-cli`: `-c model_reasoning_effort="..."` TOML config override; OpenAI's `reasoning_effort` enum tops at `"high"`.

### Added
- Per-driver fold table in `packages/runtime/src/drivers/thinking.ts`. Claude family: passthrough. pi-coding-agent: `xhigh`/`max` → `high` (SDK ladder tops at high). codex-cli: `xhigh`/`max` → `high` (OpenAI tops at high). Folds are intentionally lossy where the vendor surface is narrower; the audit event always echoes both the requested and the effective value.
- Init-event normalization across all four drivers: every init now carries `thinkingLevelSupported: true`, plus `requestedThinkingLevel` (verbatim caller value) and `effectiveThinkingLevel` (post-fold). On `pi-coding-agent` the fields land on `init.raw`; on the other three drivers they land in `init.metadata`. Consumer code can read the same fields regardless of which driver served the turn.
- `DRIVER_THINKING_SUPPORTED` registry exported from `drivers/thinking.ts` so consumers can introspect capabilities without round-tripping through an init event.

## 0.15.0 - 2026-05-17

### Added
- `RuntimeThinkingLevel` widened from the four-step ladder (`"off" | "low" | "medium" | "high"`) to a vendor-superset vocabulary: `"off" | "minimal" | "low" | "medium" | "high" | "xhigh"`. `"minimal"` matches OpenAI's `reasoning_effort: "minimal"`; `"xhigh"` is a placeholder for above-high vendor budgets some families surface. Callers can now write the vendor-native value verbatim — drivers project to their native vocabulary internally so consumers don't have to maintain duplicate fold helpers.
- Per-driver thinking-level fold table (issue [#6](https://github.com/durandom/pi-ca-leash/issues/6)). For `pi-coding-agent`: `minimal → low`, `xhigh → high`, others passthrough. For `claude-sdk` / `claude-cli` / `codex-cli`: not consumed (no per-call thinking knob in their CLI/SDK surface today).
- `init` system event now carries `thinkingLevelSupported: boolean` plus `effectiveThinkingLevel` and `requestedThinkingLevel` so audit consumers can detect the silent-drop failure mode (PM-026 in spellkave) without running a synthetic latency/usage probe. On `pi-coding-agent` the fields land on `init.raw` alongside the existing `resumed` / `securityMode` family; on the three other drivers they land in `init.metadata` (added by a shared `enrichInitWithCapabilities` helper that wraps the driver's `onEvent` callback for the first `system/init` message only).

## 0.14.0 - 2026-05-17

### Fixed
- `pi-coding-agent` driver: session resume no longer silently no-ops for callers that change `cwd` between turns (e.g. spellkave's per-task worktree pattern). The driver now pins the SDK's `sessionDir` to a runtime-owned, per-`sessionId` directory under `<storageDir>/sessions/<sessionId>/pi-coding-agent/` instead of relying on the SDK's default cwd-encoded path under `~/.pi/agent/sessions/`. Resume survives both worktree drift and process restarts; cache-read tokens are reclaimed on sticky roles previously affected by issue [#5](https://github.com/durandom/pi-ca-leash/issues/5). Interactive `pi-dev` usage at `~/.pi/agent/sessions/` is untouched.

### Added
- New optional field `sessionStorageDir` on `RuntimeDriverRunInput`. The runtime always populates it with the per-session storage directory; drivers may colocate persistent state with the runtime's `state.json` / `events.jsonl` / `transcript.jsonl`. Currently only consumed by the `pi-coding-agent` driver.
- `pi-coding-agent` init system event now exposes `resumed`, `resumeSupported`, and `driverSessionDir` on its `raw` payload so audit consumers can detect silent resume failures instead of inferring from `cacheRead` being zero.

## 0.13.0 - 2026-05-17

### Added
- Per-call `thinkingLevel` on `LaunchPeerInput`, `StartSessionInput`, `SendMessageInput`, and `RuntimeDriverRunInput` so callers can override the `pi-coding-agent` driver's `defaultThinkingLevel` per peer launch / per turn. Callers that omit the field keep existing behavior (the driver default is used). The `pi-coding-agent` driver now echoes the effective level and its source (`per-call` vs `default`) on the init system event's `raw` payload so downstream consumers can audit what actually landed on the wire vs what was requested. Other drivers ignore the field.
- `securityMode: "safe" | "yolo"` on `LaunchPeerInput`, `StartSessionInput`, `SendMessageInput`, and `RuntimeDriverRunInput`. Replaces the five-valued `permissionMode` with a coarse two-mode model that maps onto each driver's *native* sandbox / approval flag — pi-ca-leash does not layer additional tool filtering on top. Default is `safe`.
- `npm run smoke:security` opt-in E2E that exercises the only documented guarantees end-to-end against real `claude` and `codex` binaries: codex `safe` blocks writes outside cwd, codex `yolo` allows them, claude-cli `safe` does not auto-execute Bash.

### Changed
- `codex-cli` driver: `securityMode: "safe"` passes `--full-auto` (workspace-write sandbox, cwd writable); `securityMode: "yolo"` passes `--dangerously-bypass-approvals-and-sandbox`. The previous PR-floated default of always bypassing the sandbox is reverted — callers that need to write outside cwd (e.g. `git commit` in a linked worktree) must opt in via `yolo`.
- `claude-sdk` and `claude-cli` drivers: `securityMode: "safe"` maps to `permissionMode: "default"`, `securityMode: "yolo"` maps to `permissionMode: "bypassPermissions"`. On `claude-cli`, the historical default remains `yolo` because the driver runs with `stdio: ["ignore", ...]` and cannot answer interactive permission prompts in `safe`. Document and opt-in if you can tolerate hangs.
- `pi-coding-agent` driver: ignores `securityMode` (no native sandbox surface) and echoes `{ securityMode, securityModeEnforced: false, securityModeNote }` on the init system event so audit consumers can flag callers relying on a guarantee that does not exist for this driver.

### Deprecated
- `permissionMode` on `StartSessionInput`/`SendMessageInput`/`LaunchPeerInput`/`RuntimeDriverRunInput`. Resolved internally as: `bypassPermissions` → `yolo`; `default`/`acceptEdits`/`auto` → `safe`; `plan` and `dontAsk` throw. Will be removed in a future release.

## 0.12.0 - 2026-05-15

### Fixed
- `claude-cli` driver no longer hangs in `starting` when the caller passes `tools` or `additionalDirectories`. The runtime previously emitted `claude -p ... --add-dir <cwd> <prompt>`; claude 2.1.x's `--add-dir` and `--allowedTools` are Commander.js variadic flags that consumed the positional prompt, causing claude to exit with `Error: Input must be provided either through stdin or as a prompt argument when using --print` before any stream-json envelope flowed. The argument builder now appends a POSIX `--` end-of-options marker before the prompt so variadic flags stop consuming at the boundary.
- `claude-cli` driver now passes `--verbose` alongside `--output-format stream-json`. Claude 2.1+ requires it when combining `--print` with stream-json output and rejected the prior invocation immediately.

### Changed
- `@earendil-works/pi-coding-agent` is now a hard dependency rather than an optional peer. The catalog change that pointed `gpt-*` models at the pi-coding-agent driver made this package required in every install; the optional-peer treatment caused needless `@ts-expect-error` plumbing and surprising install-time gaps.
- Added `/peer dashboard hide|show` plus `/peer hide|show` aliases so operators can clear or restore the compact Peers widget without stopping peers or disabling completion relays.
- Added an optional `claude-cli` runtime driver that shells out to local `claude -p --output-format stream-json`, preserves the existing `claude-sdk` driver, and supports resumed peer follow-up sends via Claude Code session ids.
- Added pi-ca-leash JSON config loading from XDG global config, repository-local `.pi-ca-leash/config.json`, and optional `PI_CA_LEASH_CONFIG`, with explicit tool/command driver parameters and `PI_CLAUDE_RUNTIME_DRIVER` taking precedence for driver selection.
- Mapped `codex-cli` `permissionMode: "bypassPermissions"` to Codex's unsandboxed exec flag for fresh and resumed peer runs.
- Added `RELEASE_NOTES.md` with user-facing notes and examples for the new runtime/configuration behavior.
- Restored public npm packaging with explicit Agent SDK authentication and subscription-use caveats, while keeping pi.dev discovery keywords removed.
- Updated the top-level Claude Code auth warning to distinguish direct `claude-sdk` Agent SDK use from the new local `claude-cli` print-mode path, while keeping read-only/local features and the experimental Codex path separate.

## 0.11.0 - 2026-05-04

### Changed
- Peer replies that enter main-agent context now label the quoted block as peer-authored content more explicitly and trim wrapper noise, reducing confusion between tool metadata and the peer's actual message.
- `@pi-claude-code-agent/intercom-bridge` now exposes a supported managed-peer API plus shared pi-ca-leash state-path helpers, and the live peer UX now reconciles externally created peers without requiring a pi restart.
- `/peer dashboard` now shows a compact managed-owner badge for managed peers, while `/peer dashboard advanced` exposes full managed-peer metadata such as kind, owner, persona, cycle id, and extra tags.

## 0.10.2 - 2026-05-03

### Fixed
- README now links to the GitHub `DEVELOPMENT.md` instead of a file that is intentionally excluded from the published npm tarball, so package-gallery readers do not hit a broken docs link.

## 0.10.1 - 2026-05-03

### Changed
- Public package/docs wording now leads with Claude Code and Codex CLI as harnesses, not just model endpoints, with pi positioned as the orchestrating brain over retained workers.
- README now uses a more ecosystem-style flow: install, a fictional multi-peer session, natural-language orchestration framing, and clearer user-vs-development install guidance.
- Removed stale "local MVP" phrasing from public/project docs while keeping runtime and integration limits explicit.
- Trimmed the published npm tarball to the minimum extension/runtime payload while keeping gallery assets in GitHub and package metadata pointing at the raw preview image.

## 0.10.0 - 2026-05-03

### Changed
- Root package is now publishable as a single npm package that bundles the internal runtime, bridge, subagents, and teams workspaces while keeping their build output inside the shipped tarball.
- Root install/build hooks now use `prepare` plus `prepack` instead of consumer-side `postinstall` rebuilds.
- README and package metadata now describe the package as a harness-aware Claude Code and Codex CLI extension, while still calling out Codex support as experimental.

### Fixed
- `peer_interrupt` now reports whether an interrupt signal was delivered, the runtime reason, resulting peer state, and whether follow-up input can be sent immediately.
- Peer list/dashboard waiting state now only flags explicit unresolved asks, avoiding false `waiting / needs input` rows for normal completion reports.
- Newly started peers now relay their first real `waiting`, `idle`, or `error` transition into the main context instead of suppressing the initial `needs input` signal.

## 0.9.0 - 2026-05-03

### Changed
- The compact peer-mode user help now uses a persistent user-only notification instead of the lower widget area, avoiding widget truncation without adding help text to the main agent context.

## 0.8.0 - 2026-05-03

### Changed
- Peer slash-command guidance, reports, dashboards, model lists, and history pages now use user-only UI notifications instead of custom chat messages, keeping them out of the main agent context.
- Agent-facing peer messages remain explicit: the one-time orchestration guide is added to the main agent context, and peer completion/block/failure relays still arrive as wrapped follow-up turns with the latest visible peer message.

## 0.7.0 - 2026-05-03

### Changed
- `/peer init` now carries the one-time main-agent orchestration guide plus a compact user-facing command cheat sheet, while repeated peer tool prompts stay narrowly tool-specific.
- Runtime model selection now resolves common shorthand aliases such as `sonnet`, `opus`, `haiku`, `mini`, and `spark` to concrete catalog model ids before launching peers, subagents, or teammates.
- `/peer models` and `runtime_models` now show a shorter recommended model list by default, with advisory use cases and clearer `context window` / `max output` column labels; pass `all`, `advanced`, `verbose`, or `verbose: true` for the full catalog.
- Added `extension_log`, an LLM-callable local feedback tool that appends structured extension UX and interaction roughness notes to `.pi-ca-leash/log.md`.
- Peer/subagent/team launch surfaces now include prompt-size warnings for large delegated prompts, nudging agents toward smaller slices and file-based context.
- `runtime_models` reports bundled model aliases alongside exact model ids.
- Compact Peers widget rendering now uses a small adaptive table layout helper, including a wide-mode driver column and narrow-mode fallback.
- `/peer help` now includes versioned concept guidance, and `/peer about` reports installed version and runtime environment details without activating peer mode.
- Subagent and team LLM-callable tools are now hidden by default and only registered when `PI_CLAUDE_ENABLE_ADVANCED_COMMANDS=1`.

### Fixed
- Runtime driver errors now add actionable hints for missing Claude Code/Codex executables, Bedrock credential routing, missing API keys, and prompt/context-length failures.
- Extension version reporting now reads the package version instead of a hardcoded constant.

## 0.3.0 - 2026-05-03

### Changed
- Added `DEVELOPMENT.md` and linked it from `README.md` as the dedicated developer workflow and smoke-debugging guide.
- Added developer-oriented smoke helpers: `npm run smoke:dev`, `smoke:dev:codex`, `smoke:manual`, `smoke:manual:codex`, `smoke:last`, and `smoke:clean`.
- Added `npm run smoke:pi:auto` and `npm run smoke:pi:auto:codex` helpers that start pi against this checkout in JSON mode with an isolated runtime-only prompt, then write Markdown and raw event/stderr smoke artifacts under `.pi-ca-leash/smoke/auto/`.
- Added `npm run smoke:pi` and `npm run smoke:pi:codex` helpers that start pi against this checkout with `--no-extensions -e <repo-root>` for isolated pre-release hands-on smoke testing.
- Automated pi smoke runs now stop the `pi --no-session` child after an explicit `SMOKE_OK`/`SMOKE_FAIL` final marker instead of waiting for the idle CLI process to exit by itself.
- Extension startup is now lazy: loading registers commands/tools only, while `/peer init` or the first actionable `/peer` command starts the widget/background workflow and shows the operator guide.
- Moved core extension prompt/guidance text into editable files under `extensions/prompts/`.
- Added a bundled Lanista-derived runtime model catalog for `claude-sdk` and `codex-cli`, exposed through `runtime_models` and `/peer models`.
- `/peer start` can now include explicit driver and model fields in pipe syntax.
- Runtime tool guidance now points agents to `runtime_models` before choosing non-default model ids.
- Polished README setup, persistence, and runtime-driver wording around the current runtime-first package.
- Polished the compact Peers widget with peer counts, column labels, priority ordering, clearer context usage, and explicit local-mode broker warning text.
- Aligned workspace package versions with the root `0.3.0` package version.
- Reworked README into the single practical entrypoint, with the useful manual smoke and peer no-polling guidance folded in.

### Fixed
- `subagent_status` now accepts the same short run id prefixes shown by `subagent_run` and `subagent_list`, while still rejecting unknown or ambiguous prefixes.
- `--no-session` smoke runs no longer start dashboard/background peer polling or emit stale peer follow-up turns after cleanup.

### Removed
- Removed the redundant direct runtime dependency on `@anthropic-ai/sdk`; the runtime imports `@anthropic-ai/claude-agent-sdk`, and the root override remains as a guard for SDK resolution through that dependency tree.
- Removed unused internal TypeScript declarations found by `noUnusedLocals` / `noUnusedParameters` checks.
- Removed leftover standalone manual/stress-test Markdown files from the public repo root.

## 0.2.0 - 2026-05-03

### Changed
- Public slash-command UX now centers on `/peer` (`dashboard`, `start`, `ask`, `send`, `list`, `history`, `interrupt`, `stop`).
- Old `/claude-*` slash commands are hidden by default and only restored with `PI_CA_LEASH_ENABLE_LEGACY_COMMANDS=1`; old internal diagnostics additionally require `PI_CLAUDE_ENABLE_ADVANCED_COMMANDS=1`.
- Command result renderer, widget key/title, hints, and peer guidance now use `peer`/`pi-ca-leash` branding instead of `cca` or old extension labels.
- README install instructions now pin the public release as `git:github.com/durandom/pi-ca-leash@v0.2.0`.
- Pi host peer dependencies are marked optional so clean git installs do not download pi core packages unnecessarily.
- Root package overrides now guard `@anthropic-ai/sdk` resolution through the current Claude agent SDK dependency tree.

### Removed
- Scratch/planning markdown files that should not ship in the public package.

## 0.1.1 - 2026-05-03

### Fixed
- Git pi package installs now build workspace packages during install so extension imports can resolve package `dist/index.js` files.
- README install instructions now use the renamed `durandom/pi-ca-leash` repository URL.

## 0.1.0 - 2026-05-03

### Changed
- Renamed the pi package/extension surface to `pi-ca-leash` while keeping the internal runtime package names and honest `claude-code-agent` runner identity unchanged.
- Runtime now includes an optional experimental `codex-cli` driver, bridge peers now persist selected runtime driver identity, extension startup can select the default driver for new peers via `PI_CLAUDE_RUNTIME_DRIVER`, LLM-callable `peer_start` can override the driver per peer, subagent/team backend APIs can thread runtime driver selection, the runtime/subagent/team demo CLIs now honor `PI_CLAUDE_RUNTIME_DRIVER` for Codex-backed smoke checks, and the extension now exposes LLM-callable subagent/team tools.
- Extension default UX is now peer-first.
- Primary footer status line was removed from the main UX.
- Compact widget now shows one live row per peer with short activity summaries derived from runtime events.
- `/claude-dashboard` now defaults to a peer-first view, with retained backend diagnostics moved to `/claude-dashboard advanced`.
- `/claude-peer-start` and `/claude-peer-ask` now emit immediate acknowledgment messages before final completion.
- LLM-callable `peer_start` now returns and displays no-babysitting guidance, and `peer_ask` now returns and displays the outgoing prompt sent to the peer.
- Runtime Peers widget rows now include each peer's last update time.
- Claude SDK result usage now preserves last-known context-window metrics, and peer rows show `ctx <percent>%` when available.
- LLM-callable `peer_ask` now shows the outgoing prompt once as direct `[cca] Sent to peer` user feedback while keeping the tool result compact.
- Stopped peers are hidden from the compact Runtime Peers widget but remain visible in `/claude-dashboard`.
- Codex usage parsing now preserves cached/reasoning token counts internally, but compact peer rows only show `ctx <percent>%` when a trustworthy context-window percentage is available.
- Added fire-and-forget peer messaging via `peer_send` and `/claude-peer-send`, plus graceful peer interruption via `peer_interrupt` and `/claude-peer-interrupt`.
- `peer_ask` timeouts after successful delivery now return `delivered_and_running` instead of reporting a confusing delivery failure.
- `/claude-peer-start <prompt>` now auto-generates a short peer name, while `/claude-peer-start <name> | <prompt>` remains available as an explicit override.
- Internal slash commands (`/claude-dev-ping`, `/claude-runtime-list`, `/claude-subagent-*`, `/claude-attention-*`, `/claude-team-*`) are now hidden from the default UX and only reappear when pi starts with `PI_CLAUDE_ENABLE_ADVANCED_COMMANDS=1`.
- Peer completions now inject one wrapped follow-up turn into the main agent by default, carrying the peer's latest message when the peer finishes, needs input, or errors.
- Peer tool output and wrapped peer relays now fence latest visible peer messages as raw text blocks for cleaner multiline boundaries and safer relay inspection.
- LLM-callable peer tools now support explicit start-time `model` and `cwd`, and `peer_ask` can persistently switch the peer model for later turns.
- Main-agent peer transcript scrolling is now available through `peer_history(name, cursor?, limit?)`, including cursor-based paging through visible peer messages and tool activity.
- `peer_stop` can now bulk-stop all retained peers when explicitly confirmed with `all=true` and `confirmAll=true`.
- `peer_history` paging now counts visible history entries instead of raw transcript events, which makes scrolling behave more like a human reading backscroll.
- Runtime now preserves an explicitly requested model switch across resumed-session init events that report a stale prior model.
- Primary peer operations are now also exposed as LLM-callable tools: `peer_start`, `peer_list`, `peer_history`, `peer_ask`, and `peer_stop`.
- README, architecture notes, and known limits were updated to match current peer-first behavior.

### Notes
- Codex support is still partial: extension startup can choose a default peer driver, per-peer driver override exists on the LLM-callable `peer_start` tool, slash-command peer UX still has no per-peer driver selection, subagent/team driver threading is available through backend APIs and LLM-callable tools but not through slash-command/visual UX, and these surfaces are not being described as Codex-parity products.
- Historical session-plan docs were removed in favor of a single current documentation set.

## 2026-04-29

### Added
- Persisted intercom peer registry with restart restore.
- Optional live `pi-intercom` transport adapter.
- Late transport binding and retry logic for broker availability.
- Subagent backend rehydration from persisted runtime state.
- Attention events for stale background runs.
- Dashboard surfacing for intercom state and attention state.
- Intercom disconnect/reconnect notices in the extension.
- Attention list / ack / snooze extension commands.
- Persisted local attention ledger for ack/snooze state.
- Extension helper/state tests.
- Extension persistence tests.

### Changed
- Teams backend scope is now documented and enforced as **local-only**.
- README was rewritten around current reality instead of session-plan history.
- Package metadata was cleaned up to stop implying `pi-teams` integration.

### Removed
- Historical `docs/IMPLEMENTATION_PLAN.md`.
- Historical `docs/sessions/*` handoff/session documents.
- Remaining `pi-teams` roadmap narrative.

## 2026-04-25

### Added
- Initial monorepo structure.
- Claude runtime package.
- Intercom bridge package.
- Subagents backend package.
- Teams backend package.
- Initial tests and demo/smoke scripts.
