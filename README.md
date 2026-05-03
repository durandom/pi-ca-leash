# pi-ca-leash

Runtime-first Claude Code integration for pi.

This repo treats Claude Code as a long-lived local runtime, not as a stateless model provider. It builds a small local MVP around that runtime: named peers, retained subagent-style jobs, persistent teammates, and pi extension wiring.

## Status

Working local MVP:
- Claude Code runtime package
- optional experimental Codex CLI runtime driver
- named peer bridge with optional live intercom transport
- local subagent backend
- local teams backend
- pi extension with `/peer`, peer dashboard, attention state, and LLM-callable tools

Not claimed:
- no real upstream `pi-subagents` integration
- no external `pi-teams` integration
- no real Claude fork/session-tree semantics
- no host-independent full pi extension smoke test

## Install

Requirements:
- Node.js 18 or newer
- npm
- Claude Code configured for Claude-backed execution
- a real pi installation to load the extension

Optional:
- `codex` on `PATH` for experimental Codex-backed runtime checks

Install and verify from the repo root:

```bash
npm install
npm test
npm run build
```

`npm install` runs the workspace build through `postinstall`, so git-based pi installs have package `dist/` files available.

Install into pi from a pinned release:

```bash
pi install git:github.com/durandom/pi-ca-leash@v0.2.0
```

Install into pi from this checkout:

```bash
npm install
npm run build
pi install /absolute/path/to/pi-ca-leash
```

Start pi with Codex as the default runtime driver for new peers:

```bash
PI_CLAUDE_RUNTIME_DRIVER=codex-cli pi
```

Existing persisted peers keep their recorded driver.

## Use

Primary slash-command surface:

```text
/peer
/peer dashboard
/peer dashboard advanced
/peer start <prompt>
/peer start <name> | <prompt>
/peer ask <name> | <message>
/peer send <name> | <message>
/peer list
/peer history <name> [cursor] [limit]
/peer interrupt <name>
/peer stop <name>
/peer stop --all --confirm
```

Quick check inside pi:

```text
/peer start reviewer | Review this repo briefly and report one concrete risk.
/peer ask reviewer | Reply with exactly: peer-ok
/peer list
/peer dashboard advanced
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

LLM-callable backend tools:

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

Legacy `/claude-*` commands are hidden by default. Re-enable old peer commands only for compatibility:

```bash
PI_CA_LEASH_ENABLE_LEGACY_COMMANDS=1 pi
```

Re-enable old internal diagnostics for development:

```bash
PI_CA_LEASH_ENABLE_LEGACY_COMMANDS=1 PI_CLAUDE_ENABLE_ADVANCED_COMMANDS=1 pi
```

## Behavior

Peers are asynchronous workers. The main agent should start a peer, continue useful work, and wait for the automatic peer completion, blocked, or failure relay. It should not poll `peer_list`, `peer_history`, or repeated `peer_ask` just to see whether the peer is done.

The extension keeps peer output quiet by default:
- peer work does not stream child transcript spam into the main window
- peer start and ask commands show immediate acknowledgments
- peer completion is relayed back as one wrapped follow-up turn
- detailed backend diagnostics live in `/peer dashboard advanced`

Runtime driver notes:
- `claude-sdk` is the default and most complete path
- `codex-cli` is experimental
- `PI_CLAUDE_RUNTIME_DRIVER=codex-cli` changes the default for newly started peers
- LLM-callable `peer_start`, `subagent_run`, and `team_spawn` can pass an explicit driver
- slash-command and visual UX intentionally stay driver-light

## Repository Layout

```text
packages/
  runtime/            Claude/Codex runtime abstraction
  intercom-bridge/    named runtime-backed peers
  subagents-backend/  local subagent-style run backend
  teams-backend/      local persistent teammate backend
extensions/
  index.ts            pi extension wiring and command/tool surface
```

Useful docs that should remain current:
- `ARCHITECTURE.md`
- `KNOWN_LIMITS.md`
- `CHANGELOG.md`
- `AGENTS.md`

## Development

Common commands:

```bash
npm test
npm run build
npm run smoke -- "Reply with exactly: smoke-ok"
npm run demo:intercom -- "You are demo worker. Reply briefly."
npm run demo:subagent -- "Reply with exactly: subagent-ok"
npm run demo:teams -- "You are persistent teammate. Reply briefly."
```

Experimental Codex checks:

```bash
PI_CLAUDE_RUNTIME_DRIVER=codex-cli npm run smoke -- "Reply with exactly: codex-smoke-ok"
PI_CLAUDE_RUNTIME_DRIVER=codex-cli npm run demo:subagent -- "Reply with exactly: codex-subagent-ok"
PI_CLAUDE_RUNTIME_DRIVER=codex-cli npm run demo:teams -- "Reply with exactly: codex-team-ok"
```

Manual pi smoke checklist:
- clean or move `.pi-ca-leash/`
- run `npm install`, `npm test`, and `npm run build`
- install the checkout into pi
- run `/peer`, `/peer start`, `/peer ask`, `/peer list`, and `/peer stop`
- run `/peer dashboard advanced` and confirm retained backend diagnostics are believable
- restart pi and confirm persisted peers/backends restore honestly

## Persistence

Repository-local runtime state is written under:

```text
.pi-ca-leash/
  runtime/
  bridge/
  subagents/
  teams/
  extension/
```

These paths are ignored by git. Remove `.pi-ca-leash/` when you need a clean local manual-test session.

Older local development state may also exist under ignored paths such as `.pi-claude-code-agent/`, `.claude-runtime/`, or `undefined/`. Those are not part of the package.

## Limits

The short version:
- full extension-host smoke testing still needs a real pi installation
- live intercom broker transport is optional
- Codex support is partial
- `runner=claude-code-agent` rejects real `fork`
- teams backend is local-only
- attention ack/snooze is local extension state

See `KNOWN_LIMITS.md` for the detailed version.
