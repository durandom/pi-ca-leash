# Session 4 — pi-teams backend

Status: implemented as host-side teammate MVP
Date: 2026-04-25

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
- wrapper-process UX still future work if upstream `pi-teams` wants panes

### 2. Task / inbox bridge contract

Decision: team operations become intercom-style asks to named teammate.

Current mapping:
- spawn teammate → launch named bridge peer
- assign task → `ask` teammate with structured task text
- direct message → `ask` teammate with chat text
- stop teammate → stop underlying runtime session

This keeps teammate mode on top of already-defined long-lived messaging semantics.

### 3. Mixed backend support level

Decision: **contract-ready, not upstream-integrated**.

Truth:
- this package only implements Claude-backed teammate backend now
- type surface keeps backend identity field for future mixed teams
- real mixed backend support still needs upstream `pi-teams` abstraction work

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

1. No real upstream `pi-teams` integration yet.
   - This package proves teammate backend behavior locally.
   - Actual task-board/inbox UI integration still needs upstream wiring.

2. Task state transitions are simplified.
   - `assignTask` moves task to `in_progress` after first reply.
   - no autonomous completion detection yet

3. No inbox polling tool contract.
   - runtime does not get native task-board tools
   - host sends tasks/messages as bridged text asks

4. No pane/window host.
   - headless only

5. No teammate recovery after bridge restart.
   - runtime session may still exist
   - teammate registry persistence exists, but live bridge reattach flow is not automated

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

⚠️ This is persistent teammate semantics in local package form, not real `pi-teams` integration.

Biggest missing upstream work:
- real teammate backend abstraction in `pi-teams`
- UI/task-board wiring
- recovery / reconnect semantics
- mixed pi + Claude teammates in one live team
