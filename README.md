# pi-ca-leash

Runtime-first Claude Code integration for pi.

This repo does **not** pretend Claude Code is a stateless model provider. It treats Claude Code as a long-lived agent runtime, then builds local adapters on top of that runtime.

## Status

This repository is a **working local MVP**.

Implemented here:
- Claude Code runtime package
- intercom-style bridge package
- subagent backend package
- local teams backend package
- pi extension with peer-first widget/dashboard, transport monitoring, and attention controls

Not claimed here:
- full upstream product integration with real `pi-subagents`
- any external `pi-teams` package integration
- real forked Claude session semantics
- host-independent end-to-end extension smoke coverage

## Documentation map

Start here:
- `README.md` — what this repo is and how to try it
- `MANUAL_TEST_PLAN.md` — fresh-session operator checklist
- `PEER_NO_BABYSITTING_STRESS_TEST.md` — reusable peer no-polling UX stress test
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
- Extension peer UX can launch new peers on the configured default runtime driver.
- Default driver can be selected at pi startup with `PI_CLAUDE_RUNTIME_DRIVER=claude-sdk|codex-cli`.
- LLM-callable `peer_start` can override the driver per peer.
- Slash-command peer UX still has no per-peer driver selection.

### `@pi-claude-code-agent/subagents-backend`
Provides:
- `runner: claude-code-agent`
- sync/async run lifecycle
- persisted run artifacts
- restart rehydration
- attention events for stale background runs
- runtime driver threading in backend API inputs

Truth:
- backend API can start runs on `claude-sdk` or `codex-cli`
- extension UX still does not expose subagent driver selection
- `context: fork` is rejected
- this is local backend logic, not real upstream `pi-subagents` wiring

### `@pi-claude-code-agent/teams-backend`
Provides:
- persistent runtime-backed teammates
- teammate restore/reattach after restart
- task assignment and direct messaging
- simple task auto-classification from `DONE:` / `BLOCKED:` style replies
- runtime driver threading in teammate spawn inputs

Truth:
- backend API can spawn teammates on `claude-sdk` or `codex-cli`
- extension UX still does not expose teammate driver selection
- this is a **local teams backend only**
- no external `pi-teams` integration is planned in this repo

## Extension features

The pi extension in `extensions/index.ts` currently adds:
- peer-first widget with one live row per peer, including last update time and last-known context-window percentage when available
- peer-first `/claude-dashboard` plus explicit advanced mode via `/claude-dashboard advanced`
- immediate visible acknowledgments for `/claude-peer-start` and `/claude-peer-ask`
- LLM-callable peer tools: `peer_start`, `peer_list`, `peer_history`, `peer_ask`, `peer_stop`
- LLM-callable retained backend tools: `subagent_run`, `subagent_list`, `subagent_status`, `team_spawn`, `team_task`, `team_message`, `team_list`, `team_stop`
- peer tool support for explicit start-time `driver`, `model`, and `cwd`, persistent model switching via `peer_ask`, and bulk peer stop through `peer_stop(all=true, confirmAll=true)`
- scrollable peer transcript history for the main agent via `peer_history`
- automatic wrapped follow-up turns into the main agent when a peer finishes, needs input, or errors
- quiet main window behavior for peer work: no streamed child transcript spam
- background dashboard refresh every 5s
- broker disconnect/reconnect notices and late transport rebind when reachable again
- attention notifications for noisy/stale background runs
- internal subagent, attention, team, runtime, and dev slash commands kept in code but hidden from the default UX
- persisted local attention state across pi restarts

Attention state is stored at:

```text
.pi-ca-leash/extension/attention-ledger.json
```

## Requirements

You need:
- Node.js
- npm
- a working Claude Code environment for Claude-backed execution
- a real pi installation to load the extension

Optional for experimental Codex-backed peers:
- installed `codex` CLI available on `PATH`

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

For a pinned release install:

```bash
pi install git:github.com/durandom/pi-ca-leash@v0.1.1
```

For local development from this repository root:

```bash
npm install
npm run build
pi install /absolute/path/to/your/checkout
```

To start pi with experimental Codex-backed peers as the default for new peers:

```bash
PI_CLAUDE_RUNTIME_DRIVER=codex-cli pi
```

Notes:
- This changes the default runtime driver for newly started peers only.
- Existing persisted peers keep their recorded driver.

## 5-minute quickstart

After installing into pi, start pi in this repo and try these.

### 1. Start a peer

```text
/claude-peer-start Review auth flow and reply briefly.
```

You should immediately see a start acknowledgment in the main window, including the auto-generated peer name.
Live activity should appear in the `Runtime Peers` widget.
When the peer finishes, the extension also injects the last peer message back into a new wrapped main-agent turn.

Use an explicit override when needed:

```text
/claude-peer-start reviewer | Review auth flow and reply briefly.
```

### 2. Ask the peer

```text
/claude-peer-ask worker1 | Reply with exactly: peer-ok
/claude-peer-list
```

### 3. Inspect the dashboard

```text
/claude-dashboard
/claude-dashboard advanced
```

Default dashboard is peer-first.
Advanced mode keeps retained backend diagnostics explicit but out of the main UX.

## Command reference

Primary peer UX:

```text
/claude-dashboard [advanced]
/claude-peer-start <prompt>
/claude-peer-start <name> | <prompt>
/claude-peer-list
/claude-peer-ask <name> | <message>
/claude-peer-send <name> | <message>
/claude-peer-interrupt <name>
/claude-peer-stop <name>
```

LLM-callable peer tools:

```text
peer_start(prompt, name?, driver?, model?, cwd?)
peer_list()
peer_history(name, cursor?, limit?)
peer_ask(name, message, model?)
peer_send(name, message, model?)
peer_interrupt(name)
peer_stop(name?, all?, confirmAll?)
```

LLM-callable retained backend tools:

```text
subagent_run(task, name?, prompt?, driver?, model?, cwd?, async?)
subagent_list()
subagent_status(runId)
team_spawn(name, prompt, driver?, model?, cwd?)
team_task(name, title, details)
team_message(name, message)
team_list()
team_stop(name)
```

Notes:
- `cwd` is chosen when the peer starts. To change it later, start a new peer.
- `peer_ask(..., model?)` switches the peer model persistently for later turns.
- `peer_history` lets the main agent scroll through prior peer transcript pages using `previousCursor` and `nextCursor`.
- `peer_history` paging is based on visible history entries, not hidden/raw transcript events.

Internal slash commands are hidden by default.

For development-only access, start pi with:

```bash
PI_CLAUDE_ENABLE_ADVANCED_COMMANDS=1 pi
```

That re-exposes:

```text
/claude-dev-ping
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

Experimental Codex-backed CLI checks:

```bash
PI_CLAUDE_RUNTIME_DRIVER=codex-cli npm run smoke -- "Reply with exactly: codex-smoke-ok"
PI_CLAUDE_RUNTIME_DRIVER=codex-cli npm run demo:subagent -- "Reply with exactly: codex-subagent-ok"
PI_CLAUDE_RUNTIME_DRIVER=codex-cli npm run demo:teams -- "Reply with exactly: codex-team-ok"
```

## Persistence

Repository-local state is written under:

```text
.pi-ca-leash/
```

Important subpaths:

```text
.pi-ca-leash/
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
- Experimental Codex support is currently strongest on runtime-backed peers; subagents and teams backend APIs and LLM-callable tools can also thread driver selection, but slash-command/visual extension UX still does not expose subagent/team driver selection.
- `runner=claude-code-agent` does not support real `fork` semantics.
- Attention ack/snooze persistence is local extension state, not a shared cross-session protocol.
- Teams backend is local to this repo, not a broader external team product integration.

## Bottom line

This repo is in a good state to share with other developers as a **local MVP with honest limits**.
