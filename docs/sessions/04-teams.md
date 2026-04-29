# Session 4 — teams backend

Status: implemented as host-side teammate MVP, then extended with restore + task auto-classification
Date: 2026-04-25
Updated: 2026-04-29

## What shipped

Created `packages/teams-backend` on top of intercom bridge.

```text
packages/
  runtime/
  intercom-bridge/
  subagents-backend/
  teams-backend/
```

Implemented package: `@pi-claude-code-agent/teams-backend`

Contents:
- persistent teammate spawn/status/stop API
- task assignment flow
- direct team-message flow
- teammate + task persistence
- teammate restore/reattach on backend restart
- task auto-classification for `DONE:` / `BLOCKED:` style replies
- demo CLI harness
- unit tests with fake runtime driver

## Forced decisions made

### 1. Worker host form

Decision: **headless bridge-hosted runtime session first**.

Why:
- fastest path using Session 2 bridge
- enough to validate persistent teammate semantics
- avoids premature pane/window integration coupling

Truth:
- no terminal pane/window observability yet
- wrapper-process UX still future work if pane/window observability becomes necessary

### 2. Task / inbox bridge contract

Decision: team operations become intercom-style asks to named teammate.

Current mapping:
- spawn teammate → launch named bridge peer
- assign task → `ask` teammate with structured task text
- direct message → `ask` teammate with chat text
- stop teammate → stop underlying runtime session

This keeps teammate mode on top of already-defined long-lived messaging semantics.

### 3. Scope tightening

Decision: **local teams backend only**.

Truth:
- this package implements Claude-backed teammate behavior directly
- no external teams package integration is planned here
- mixed-backend orchestration is out of scope unless a real need appears later

## Public API summary

Main export: `ClaudeCodeTeamsBackend`

Methods:
- `spawnTeammate(input)`
- `listTeammates()`
- `teammateStatus(name)`
- `assignTask({ assignee, title, details })`
- `sendMessage(name, text)`
- `markTaskDone(taskId, note?)`
- `listTasks()`
- `stopTeammate(name)`

Helpers exported:
- `formatTaskAssignment(...)`
- `mapState(...)`

## Persistence layout

Default storage root:

```text
.teams-backend/
```

Layout:

```text
.teams-backend/
  teammates/
    <name>.json
  tasks/
    <task-id>.json
```

## Demo workflow supported now

1. spawn long-lived teammate
2. assign task
3. teammate replies with progress / next step
4. send follow-up direct message
5. stop teammate cleanly

## Validation done

### Unit tests passing

Command:

```bash
npm run test --workspace @pi-claude-code-agent/teams-backend
```

Coverage:
- spawn teammate
- assign task
- exchange direct message
- stop teammate
- task assignment formatting helper

### Demo harness

Command:

```bash
npm run demo --workspace @pi-claude-code-agent/teams-backend -- "You are persistent teammate. Reply briefly."
```

## Known limits / unresolved questions

1. No external teams package integration is planned.
   - This package is the local persistent teammate implementation.
   - If richer task-board/inbox UI is wanted later, it should be built here or against a concrete package that actually exists.

2. Task state transitions are still simplified.
   - `assignTask` now classifies obvious `DONE:` / `BLOCKED:` style replies
   - there is still no richer autonomous task lifecycle or board protocol

3. No inbox polling tool contract.
   - runtime does not get native task-board tools
   - host sends tasks/messages as bridged text asks

4. No pane/window host.
   - headless only

5. Teammate recovery after backend restart now exists.
   - persisted teammate records reattach to persisted bridge/runtime sessions on startup
   - richer failure recovery across hard process loss is still limited

## Example usage

```ts
const backend = new ClaudeCodeTeamsBackend();

await backend.spawnTeammate({
  name: "researcher",
  prompt: "You are persistent teammate. Be concise.",
});

await backend.assignTask({
  assignee: "researcher",
  title: "Investigate flakes",
  details: "Look at test failures and propose next step.",
});

await backend.sendMessage("researcher", "Need short update");
await backend.stopTeammate("researcher");
```

## Remaining truth

⚠️ This is a local persistent teammate backend. That is now the intended scope.

Biggest remaining work in-scope:
- richer UI/task-board wiring
- stronger recovery / reconnect semantics
- optional pane/window observability if needed
