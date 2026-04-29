# pi-claude-code-agent

Runtime-first integration repo for bringing Claude Code into pi without pretending Claude Code is a stateless model provider.

## Implemented now

Session 1 runtime foundation lives in `packages/runtime`.
Session 2 intercom bridge lives in `packages/intercom-bridge`.
Session 3 subagent backend lives in `packages/subagents-backend`.
Session 4 teammate backend lives in `packages/teams-backend`.

Runtime provides:
- Claude-backed session start/resume
- normalized runtime events
- disk persistence
- interrupt/stop lifecycle controls
- smoke CLI harness

Intercom bridge provides:
- named runtime-backed peers
- `send` / `ask` / `reply` orchestration
- idle-cycle reply extraction
- demo CLI harness

Subagent backend provides:
- `runner: claude-code-agent` execution backend
- sync/async run lifecycle
- run artifact persistence
- result collection and control APIs

Teams backend provides:
- persistent Claude-backed teammate spawn/message/stop flows
- simple task assignment lifecycle
- teammate/task persistence
- demo CLI harness

## Repository shape

```text
packages/
  runtime/
  intercom-bridge/
  subagents-backend/
  teams-backend/
docs/
  IMPLEMENTATION_PLAN.md
  sessions/
```

## Useful commands

```bash
npm install
npm test
npm run build
npm run smoke -- "Reply with exactly: smoke-ok"
npm run demo:intercom -- "You are demo worker. Reply briefly."
npm run demo:subagent -- "Reply with exactly: subagent-ok"
npm run demo:teams -- "You are persistent teammate. Reply briefly."
```

## Install into pi from this directory

```bash
npm install
npm run build
pi install /absolute/path/to/pi-claude-code-agent
```

This package now exposes a pi extension from `extensions/index.ts`.

## Extension commands

After install, start pi in this repo and use:

```text
/claude-peer-start <name> | <prompt>
/claude-peer-list
/claude-peer-ask <name> | <message>
/claude-peer-stop <name>

/claude-subagent-run <task>
/claude-subagent-list
/claude-subagent-status <runId>

/claude-team-spawn <name> | <prompt>
/claude-team-task <name> | <title> | <details>
/claude-team-message <name> | <message>
/claude-team-list
/claude-team-stop <name>

/claude-runtime-list
```

State is persisted under:

```text
.pi-claude-code-agent/
```

## Current roadmap

1. `@pi-claude-code-agent/runtime` — implemented
2. `@pi-claude-code-agent/intercom-bridge` — implemented as host-side MVP
3. `@pi-claude-code-agent/subagents-backend` — implemented as host-side MVP
4. `@pi-claude-code-agent/teams-backend` — implemented as host-side MVP

See:
- `docs/IMPLEMENTATION_PLAN.md`
- `docs/sessions/01-runtime.md`
- `docs/sessions/02-intercom.md`
- `docs/sessions/03-subagents.md`
- `docs/sessions/04-teams.md`
