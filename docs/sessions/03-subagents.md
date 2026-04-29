# Session 3 — pi-subagents backend

Status: implemented as host-side backend MVP, then extended with rehydration and attention events
Date: 2026-04-25
Updated: 2026-04-29

## What shipped

Created `packages/subagents-backend` as runtime-backed execution backend package.

```text
packages/
  runtime/
  intercom-bridge/
  subagents-backend/
```

Implemented package: `@pi-claude-code-agent/subagents-backend`

Contents:
- backend interface for delegated job execution
- `runner: claude-code-agent` backend implementation
- runtime-to-run status mapping
- async + sync run handling
- run persistence shaped like subagent artifacts
- restart rehydration from persisted run/runtime state
- attention events for stale background runs
- interrupt / stop / result collection API
- demo CLI harness
- unit tests with fake runtime driver

## Forced decisions made

### 1. Runner selection syntax

Decision: use **`runner: claude-code-agent`**.

Why:
- execution backend, not model provider
- aligns with implementation plan recommendation
- avoids pretending Claude runtime is stateless model choice

### 2. Fork behavior

Decision: **real fork unsupported**.

Current behavior:
- `context: fresh` supported
- `context: fork` rejected immediately with explicit error

Truth:
- no pseudo-fork implemented yet
- better to reject than lie about branch/session semantics

### 3. Result/status mapping contract

Runtime state → subagent run state:
- `starting` → `starting`
- `running` → `running`
- `idle` → `completed`
- `interrupted` → `interrupted`
- `stopped` → `stopped`
- `failed` → `failed`

Result envelope:
- `summary` — last assistant text, fallback to result summary
- `events` — runtime event log for run session
- `runtimeState` — terminal runtime state for truth-preserving diagnostics

## Public API summary

Main export: `ClaudeCodeSubagentBackend`

Methods:
- `startRun(input)`
- `statusRun(runId)`
- `listRuns()`
- `eventsRun(runId, cursor?)`
- `interruptRun(runId)`
- `stopRun(runId)`
- `collectResult(runId)`

Helpers exported:
- `buildTaskPrompt(...)`
- `extractSummary(...)`
- `mapRunState(...)`

## Persistence layout

Default storage root:

```text
.subagent-runs/
```

Per-run layout:

```text
.subagent-runs/
  runs/
    <run-id>/
      status.json
      events.jsonl
      result.json
      artifacts/
```

This mirrors expected async/job artifacts without duplicating runtime session persistence internals.

## Async behavior

Supported now:
- sync run waits for terminal runtime state
- async run returns quickly and continues background polling in same host process
- `statusRun`, `listRuns`, `eventsRun`, `collectResult` operate on persisted run artifacts

Truth:
- background polling is host-process-local
- no daemonization or cross-process worker resurrection yet

## Validation done

### Unit tests passing

Command:

```bash
npm run test --workspace @pi-claude-code-agent/subagents-backend
```

Coverage:
- completed runtime-backed run persists result
- async run can be listed and tailed
- fork rejection is explicit
- prompt/result helpers behave as expected

### Demo harness

Command:

```bash
npm run demo --workspace @pi-claude-code-agent/subagents-backend -- "Reply with exactly: subagent-ok"
```

## Known limits / unresolved questions

1. No integration with real `pi-subagents` package yet.
   - This package is backend logic and persistence shape only.
   - Actual `pi-subagents` executor abstraction still needs wiring in upstream repo.

2. Async lifecycle is same-process only.
   - If host exits, runtime persistence survives.
   - subagent polling loop does not.

3. Attention events exist now, but upstream `pi-subagents` control wiring still does not.
   - stale local background runs emit `attention` into run artifacts
   - the local extension now surfaces attention in the dashboard and supports ack/snooze for noisy runs
   - local attention ack/snooze state is now persisted across pi restarts
   - no real upstream control-notification integration has been wired in this repo

4. Clarify TUI not represented yet.
   - backend package assumes fully materialized start input

## Runner configuration example

```yaml
name: claude-worker
runner: claude-code-agent
model: claude-sonnet-4-6
```

Invocation concept:

```ts
await backend.startRun({
  agent: {
    name: "claude-worker",
    runner: "claude-code-agent",
    prompt: "You are delegated worker. Be concise.",
  },
  task: "Investigate failing tests",
  context: "fresh",
});
```

## Remaining gaps for team mode

Teams still need extra semantics beyond subagent jobs:
- persistent peer identity across many assignments
- inbox/message/task lifecycle
- teammate metadata and task ownership
- teammate-specific UX beyond one-shot run records

## Next session handoff

Session 4 can assume:
- runtime-backed job runner exists
- explicit `runner: claude-code-agent` contract exists
- run artifact persistence exists
- fork limitation documented honestly

Main caution for Session 4:
- this backend is one-shot job oriented
- persistent teammates should build on bridge semantics, not subagent run records
