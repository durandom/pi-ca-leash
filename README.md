# pi-claude-code-agent

Runtime-first Claude Code integration for pi.

This repo does **not** pretend Claude Code is a stateless model provider. It treats Claude Code as a long-lived agent runtime, then builds local adapters on top of that runtime.

## Status

This repository is a **working local MVP**.

Implemented here:
- Claude Code runtime package
- intercom-style bridge package
- subagent backend package
- local teams backend package
- pi extension with dashboard, intercom monitoring, and attention controls

Not claimed here:
- full upstream product integration with real `pi-subagents`
- any external `pi-teams` package integration
- real forked Claude session semantics
- host-independent end-to-end extension smoke coverage

## Documentation map

Start here:
- `README.md` — what this repo is and how to try it
- `MANUAL_TEST_PLAN.md` — fresh-session operator checklist
- `ARCHITECTURE.md` — how the pieces fit together
- `KNOWN_LIMITS.md` — explicit constraints and non-goals
- `CHANGELOG.md` — notable changes over time
- `AGENTS.md` — guidance for agents working inside this repo

## Repository layout

```text
packages/
  runtime/
  intercom-bridge/
  subagents-backend/
  teams-backend/
extensions/
  index.ts
```

## Package overview

### `@pi-claude-code-agent/runtime`
Provides:
- Claude-backed session start/resume by default
- optional experimental `codex-cli` runtime driver
- normalized runtime events
- persisted session state and transcript
- interrupt/stop lifecycle controls

Truth:
- Codex support is currently runtime-level and experimental.
- Unsupported Codex options are rejected instead of being silently mapped to fake Claude parity.

### `@pi-claude-code-agent/intercom-bridge`
Provides:
- named runtime-backed peers
- `send` / `ask` / `reply` behavior
- idle-cycle reply extraction
- persisted peer registry with restart restore
- optional live `pi-intercom` broker transport when reachable
- persisted per-peer runtime driver identity

Truth:
- Bridge peers can carry `driver: "claude-sdk" | "codex-cli"`.
- Extension UX still launches Claude-first peers today.

### `@pi-claude-code-agent/subagents-backend`
Provides:
- `runner: claude-code-agent`
- sync/async run lifecycle
- persisted run artifacts
- restart rehydration
- attention events for stale background runs

Truth:
- `context: fork` is rejected
- this is local backend logic, not real upstream `pi-subagents` wiring

### `@pi-claude-code-agent/teams-backend`
Provides:
- persistent Claude-backed teammates
- teammate restore/reattach after restart
- task assignment and direct messaging
- simple task auto-classification from `DONE:` / `BLOCKED:` style replies

Truth:
- this is a **local teams backend only**
- no external `pi-teams` integration is planned in this repo

## Extension features

The pi extension in `extensions/index.ts` currently adds:
- status line and dashboard widget
- background dashboard refresh every 5s
- intercom disconnect/reconnect notices
- late transport rebind when broker becomes reachable again
- attention notifications for noisy/stale background runs
- attention list / ack / snooze commands
- persisted local attention state across pi restarts

Attention state is stored at:

```text
.pi-claude-code-agent/extension/attention-ledger.json
```

## Requirements

You need:
- Node.js
- npm
- a working Claude Code environment for runtime-backed execution
- a real pi installation to load the extension

Peer dependencies expected from pi host environment:
- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-tui`

## Install

```bash
npm install
npm test
npm run build
```

## Install into pi

From this repository root:

```bash
npm install
npm run build
pi install /absolute/path/to/pi-claude-code-agent
```

## 5-minute quickstart

After installing into pi, start pi in this repo and try these.

### 1. Start a named peer

```text
/claude-peer-start worker1 | You are a brief worker. Reply briefly.
/claude-peer-ask worker1 | Reply with exactly: peer-ok
/claude-peer-list
```

### 2. Run a subagent job

```text
/claude-subagent-run Investigate this repository and reply with exactly: subagent-ok
/claude-subagent-list
```

### 3. Spawn a teammate

```text
/claude-team-spawn researcher | You are a persistent teammate. Reply briefly.
/claude-team-task researcher | Investigate flakes | Look at failing tests and propose next step.
/claude-team-list
```

### 4. Attention controls

```text
/claude-attention-list
/claude-attention-ack <runId-prefix>
/claude-attention-snooze <runId-prefix> 15
```

## Command reference

```text
/claude-peer-start <name> | <prompt>
/claude-peer-list
/claude-peer-ask <name> | <message>
/claude-peer-stop <name>

/claude-subagent-run <task>
/claude-subagent-list
/claude-subagent-status <runId>
/claude-attention-list
/claude-attention-ack <runId-prefix>
/claude-attention-snooze <runId-prefix> [minutes]

/claude-team-spawn <name> | <prompt>
/claude-team-task <name> | <title> | <details>
/claude-team-message <name> | <message>
/claude-team-list
/claude-team-stop <name>

/claude-runtime-list
```

## Useful workspace commands

```bash
npm test
npm run build
npm run smoke -- "Reply with exactly: smoke-ok"
npm run demo:intercom -- "You are demo worker. Reply briefly."
npm run demo:subagent -- "Reply with exactly: subagent-ok"
npm run demo:teams -- "You are persistent teammate. Reply briefly."
```

## Persistence

Repository-local state is written under:

```text
.pi-claude-code-agent/
```

Important subpaths:

```text
.pi-claude-code-agent/
  runtime/
  bridge/
  subagents/
  teams/
  extension/
```

## Testing status

Validated now:
- `npm test` passes
- `npm run build` passes
- package-level behavior is covered by workspace tests
- extension helper/state logic is covered by direct tests in `extensions/*.test.ts`

## Known limits

See `KNOWN_LIMITS.md` for the blunt version.

Most important limits:
- Full extension-host smoke testing still depends on a real pi installation and host runtime.
- Intercom broker availability is optional; local runtime-backed peers still work without live broker presence.
- Experimental Codex support is not exposed through the default extension peer UX yet.
- `runner=claude-code-agent` does not support real `fork` semantics.
- Attention ack/snooze persistence is local extension state, not a shared cross-session protocol.
- Teams backend is local to this repo, not a broader external team product integration.

## Bottom line

This repo is in a good state to share with other developers as a **local MVP with honest limits**.
