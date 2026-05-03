# Changelog

All notable changes to this repository should be recorded here.

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
- Polished README setup, persistence, and runtime-driver wording around the current local MVP.
- Aligned workspace package versions with the root `0.2.0` package version.
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
- README, architecture notes, and known limits were updated to match peer-first MVP behavior.

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
