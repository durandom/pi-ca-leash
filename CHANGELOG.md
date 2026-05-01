# Changelog

All notable changes to this repository should be recorded here.

## Unreleased

### Changed
- Runtime now includes an optional experimental `codex-cli` driver, and bridge peers now persist selected runtime driver identity.

- README, architecture notes, known limits, and agent guidance were consolidated and cleaned up for shareability.
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
