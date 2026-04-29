# Architecture

## Overview

`pi-claude-code-agent` is built around one idea:

> Claude Code should be integrated as a **stateful runtime** first, then adapted into pi-style workflows.

That leads to a layered design.

```text
Claude Code SDK / driver
        ↓
packages/runtime
        ↓
packages/intercom-bridge
        ↓
packages/subagents-backend    packages/teams-backend
        ↓                     ↓
             extensions/index.ts
```

## Layers

### 1. Runtime layer

Path:
- `packages/runtime`

Responsibility:
- start Claude-backed sessions
- resume/send messages into existing sessions
- normalize runtime events
- persist session state and transcript
- expose status, listing, event streaming, interrupt, and stop

This package is the source of truth for Claude session lifecycle.

Important consequence:
- higher layers should not reinvent Claude session persistence or control semantics

### 2. Intercom bridge layer

Path:
- `packages/intercom-bridge`

Responsibility:
- give runtime sessions stable peer names
- map `send` / `ask` / `reply` style messages into runtime sends
- wait for the next idle cycle to determine replies
- persist peer registry for restart restore
- optionally bind peers to live `pi-intercom` transport when broker is reachable

Important consequence:
- intercom transport is optional
- the bridge still works locally without live broker presence

### 3. Subagent backend layer

Path:
- `packages/subagents-backend`

Responsibility:
- run bounded delegated jobs through the Claude runtime
- persist run artifacts in subagent-style layout
- map runtime states into run states
- support sync/async runs
- emit attention events for stale background runs

Truth:
- this is local backend logic in this repo
- it is not proof of real upstream `pi-subagents` product integration
- `context: fork` is rejected explicitly

### 4. Teams backend layer

Path:
- `packages/teams-backend`

Responsibility:
- keep persistent Claude-backed teammates alive across multiple messages/tasks
- assign tasks
- exchange direct messages
- persist teammate/task state
- restore teammate records after restart

Truth:
- this is a local teams backend only
- no external `pi-teams` integration is assumed here

### 5. Extension layer

Path:
- `extensions/index.ts`

Responsibility:
- wire runtime + bridge + backends into a pi extension
- expose operator commands
- render dashboard/status information
- monitor live intercom transport connectivity
- surface attention notifications
- persist local attention ack/snooze state

The extension is where operator UX lives.

## Runtime-first design rationale

Why this shape exists:
- Claude Code is session-based and tool-using
- it has lifecycle concerns that do not fit a pure model-provider abstraction well
- intercom/subagents/teams all need long-lived session identity and persistence

So this repo chooses:
- one runtime core
- multiple adapters on top
- minimal duplication across higher layers

## Persistence model

Repository-local state is written under:

```text
.pi-claude-code-agent/
```

Typical layout:

```text
.pi-claude-code-agent/
  runtime/      # runtime sessions and transcripts
  bridge/       # bridge peer registry
  subagents/    # subagent run artifacts
  teams/        # teammate and task records
  extension/    # extension-local state such as attention ledger
```

## Interaction model

### Named peer flow

```text
user command
  → extension
  → intercom bridge
  → runtime session send
  → wait for idle cycle
  → reply extraction
  → command result / dashboard update
```

### Subagent flow

```text
user command
  → extension
  → subagents backend
  → runtime start/send
  → persisted run status/events/result
  → attention monitoring if stale
```

### Teammate flow

```text
user command
  → extension
  → teams backend
  → bridge-backed persistent peer
  → task/message exchange over time
```

## What is intentionally not abstracted further

This repo currently avoids extra abstraction layers unless they solve a real problem.

Examples:
- no fake generic team product adapter
- no fake upstream `pi-teams` compatibility layer
- no pseudo-fork illusion for Claude sessions

## Testing strategy

Current coverage:
- package-level tests for runtime, intercom bridge, subagent backend, and teams backend
- extension helper/state tests in `extensions/*.test.ts`

Current gap:
- no full end-to-end extension-host smoke test inside a real pi host runtime

See also:
- `README.md`
- `KNOWN_LIMITS.md`
- `CHANGELOG.md`
