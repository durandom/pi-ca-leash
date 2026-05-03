# Manual Test Plan

This document is meant for a **fresh manual verification session**.

It is written as an operator checklist, not as a historical design note.

## Goal

Verify that this repository works as a **shareable local MVP** in a real pi environment.

Primary things to validate:
- repository installs cleanly
- tests/build are green
- pi can load the extension
- peer lifecycle works
- subagent job flow works
- teams backend flow works
- restart restore works for persisted state
- dashboard/intercom status is believable
- attention UI and persistence can be exercised manually

## Scope and truth

This plan validates the repo **as it exists today**.

It does **not** prove:
- upstream `pi-subagents` product integration
- external `pi-teams` integration
- real fork semantics
- host-independent end-to-end automation

## Suggested test log

Copy this table into your notes while testing.

```text
| Step | Result | Notes |
|------|--------|-------|
| Preflight | | |
| Install/build | | |
| Pi load | | |
| Peer flow | | |
| Subagent flow | | |
| Teams flow | | |
| Restart restore | | |
| Attention UX | | |
| Cleanup | | |
```

## Prerequisites

You need:
- Node.js
- npm
- a working Claude Code environment
- a working pi installation
- this repository checked out locally

Optional for experimental Codex-backed checks:
- installed `codex` CLI available on `PATH`

Optional but useful:
- a second terminal window
- an intercom broker already available from a real pi environment

Internal slash commands are hidden in the default UX.
If you want to exercise `/claude-dev-ping`, `/claude-runtime-list`, `/claude-subagent-*`, `/claude-attention-*`, or `/claude-team-*`, start pi with:

```bash
PI_CA_LEASH_ENABLE_LEGACY_COMMANDS=1 PI_CLAUDE_ENABLE_ADVANCED_COMMANDS=1 pi
```

## Recommended clean start

From the repository root:

```bash
git status --short
npm install
npm test
npm run build
```

Expected:
- working tree is clean or intentionally understood
- install succeeds
- `npm test` passes
- `npm run build` passes

If any of those fail, stop here and record the failure before testing pi behavior.

## Phase 1 — Install into pi

From the repository root:

```bash
pi install /absolute/path/to/pi-ca-leash
```

Expected:
- pi accepts the install
- no obvious package resolution failure

## Phase 2 — Start pi in this repository

Start pi from the repository root.

Optional experimental Codex default for new peers:

```bash
PI_CLAUDE_RUNTIME_DRIVER=codex-cli pi
```

Expected early checks:
- extension loads without obvious startup failure
- widget appears eventually
- `/peer dashboard` works
- dashboard event shows the expected default driver for this pi process

Command:

```text
/peer dashboard
```

Expected:
- dashboard command returns a readable report
- widget/dashboard updates

## Phase 3 — Dashboard and runtime baseline

Run:

```text
/peer dashboard
/peer list
```

Expected:
- dashboard command returns a readable report
- peer list works even if empty
- no command crashes

Record whether dashboard shows intercom as:
- `live (...)`
- or `off`

Both are acceptable depending on environment.

If you started pi with `PI_CLAUDE_RUNTIME_DRIVER=codex-cli`, also record that the dashboard event mentions `default driver codex-cli`.

Optional package-level Codex checks outside the pi host:

```bash
PI_CLAUDE_RUNTIME_DRIVER=codex-cli npm run smoke -- "Reply with exactly: codex-smoke-ok"
PI_CLAUDE_RUNTIME_DRIVER=codex-cli npm run demo:subagent -- "Reply with exactly: codex-subagent-ok"
PI_CLAUDE_RUNTIME_DRIVER=codex-cli npm run demo:teams -- "Reply with exactly: codex-team-ok"
```

Expected:
- runtime smoke reports `driver: "codex-cli"`
- subagent demo run record reports `driver: "codex-cli"`
- teams demo teammate record reports `driver: "codex-cli"`

## Phase 4 — Named peer lifecycle

### 4.1 Start peer

```text
/peer start worker1 | You are a brief worker. Reply briefly.
```

Expected:
- success message
- peer name `worker1`
- session id shown

### 4.2 Ask peer

```text
/peer ask worker1 | Reply with exactly: peer-ok
```

Expected:
- reply returns successfully
- output includes `peer-ok`
- peer remains addressable afterward

### 4.3 List peer

```text
/peer list
```

Expected:
- `worker1` appears
- state looks sane, typically `idle` after the ask completes

### 4.4 Stop peer

```text
/peer stop worker1
/peer list
```

Expected:
- stop succeeds
- `worker1` no longer appears in active peer list

## Phase 5 — Subagent job flow

Run:

```text
/claude-subagent-run Investigate this repository and reply with exactly: subagent-ok
/claude-subagent-list
```

Expected:
- run command succeeds
- result message includes `subagent-ok` or equivalent exact requested summary if the model obeys cleanly
- list command shows a run record
- run state is sensible, usually `completed`

If a run id is visible, also run:

```text
/claude-subagent-status <runId>
```

Expected:
- status command returns record details
- no command crash

## Phase 6 — Teams backend flow

### 6.1 Spawn teammate

```text
/claude-team-spawn researcher | You are a persistent teammate. Reply briefly.
```

Expected:
- teammate spawn succeeds
- teammate/session info is shown

### 6.2 Assign task

```text
/claude-team-task researcher | Investigate flakes | Look at failing tests and propose next step.
```

Expected:
- task is created
- task state is sensible (`assigned`, `in_progress`, `done`, or `blocked` depending on reply)
- last reply text is visible if returned

### 6.3 Direct message

```text
/claude-team-message researcher | Give a one-line status update.
```

Expected:
- teammate replies successfully
- response is readable

### 6.4 List state

```text
/claude-team-list
```

Expected:
- teammate appears in list
- task appears in task list

### 6.5 Stop teammate

```text
/claude-team-stop researcher
```

Expected:
- stop succeeds

## Phase 7 — Restart restore

This phase checks persisted restore behavior.

### 7.1 Create restorable state

Do **not** stop these yet:

```text
/peer start persist-peer | You are a persistent peer. Reply briefly.
/claude-team-spawn persist-team | You are a persistent teammate. Reply briefly.
/claude-team-task persist-team | Persisted task | Confirm you survive restart.
```

Expected:
- all commands succeed

### 7.2 Exit pi completely

Close the pi session/process.

### 7.3 Start pi again in the same repository

After restart, run:

```text
/peer list
/claude-team-list
/peer dashboard
```

Expected:
- `persist-peer` is restored if runtime/bridge records are still valid
- `persist-team` and its task are restored if records are still valid
- dashboard/report reflects persisted state rather than starting from nothing

### 7.4 Cleanup restored objects

```text
/peer stop persist-peer
/claude-team-stop persist-team
```

Expected:
- cleanup succeeds

If one of the restored records is stale or unavailable, record that clearly. That is still useful test information.

## Phase 8 — Intercom transport visibility

This phase is environment-dependent.

Run:

```text
/peer dashboard
```

Observe whether intercom is shown as:
- `off`
- or `live (connected/bound)`

Interpretation:
- `off` is acceptable if no broker is reachable
- `live (...)` is acceptable if broker connectivity exists

If you can intentionally bring broker connectivity up or down in your environment, confirm that the extension eventually shows reconnect/disconnect notices and dashboard updates.

If you cannot control broker availability safely, just record the observed state.

## Phase 9 — Attention UI and persistence

⚠️ Important truth:

The extension exposes attention commands, but there is **no simple public command** that reliably creates a stale async attention case from the UI alone.

So this phase uses a **synthetic fixture** to validate operator UX and persistence. It does **not** prove true stale-run detection end-to-end.

### 9.1 Create a synthetic attention run

From a shell in the repository root:

```bash
mkdir -p .pi-ca-leash/subagents/runs/manual-attn
cat > .pi-ca-leash/subagents/runs/manual-attn/status.json <<'JSON'
{
  "runId": "manual-attn",
  "runner": "claude-code-agent",
  "agentName": "manual-fixture",
  "cwd": ".",
  "state": "running",
  "context": "fresh",
  "createdAt": "2026-04-29T00:00:00.000Z",
  "updatedAt": "2026-04-29T00:00:00.000Z",
  "lastActivityAt": "2026-04-29T00:00:00.000Z",
  "task": "Synthetic attention fixture",
  "note": "Needs attention: synthetic manual test"
}
JSON
```

Now in pi run:

```text
/claude-attention-list
```

Expected:
- one attention item appears
- run id `manual-attn` appears
- state is shown as active

### 9.2 Acknowledge it

```text
/claude-attention-ack manual-attn
/claude-attention-list
```

Expected:
- ack command succeeds
- state changes to `acked`

### 9.3 Snooze it

To test snooze cleanly, first replace the fixture with a new note so it becomes active again:

```bash
cat > .pi-ca-leash/subagents/runs/manual-attn/status.json <<'JSON'
{
  "runId": "manual-attn",
  "runner": "claude-code-agent",
  "agentName": "manual-fixture",
  "cwd": ".",
  "state": "running",
  "context": "fresh",
  "createdAt": "2026-04-29T00:00:00.000Z",
  "updatedAt": "2026-04-29T00:05:00.000Z",
  "lastActivityAt": "2026-04-29T00:05:00.000Z",
  "task": "Synthetic attention fixture",
  "note": "Needs attention: synthetic manual test v2"
}
JSON
```

Then in pi:

```text
/claude-attention-snooze manual-attn 15
/claude-attention-list
```

Expected:
- snooze command succeeds
- state becomes `snoozed ...`

### 9.4 Confirm persistence across restart

Exit pi completely and start it again in the same repository.

Then run:

```text
/claude-attention-list
```

Expected:
- `manual-attn` still appears
- ack/snooze state survives restart via persisted extension ledger

### 9.5 Cleanup synthetic fixture

From shell:

```bash
rm -rf .pi-ca-leash/subagents/runs/manual-attn
```

Then optionally restart pi or rerun:

```text
/claude-attention-list
```

Expected:
- fixture disappears after refresh/restart

## Phase 10 — Final cleanup

If any persistent objects remain, stop them:

```text
/peer list
/claude-team-list
```

Clean up anything you intentionally created.

Optional local cleanup from shell:

```bash
rm -rf .pi-ca-leash
```

Only do that if you want to discard all local persisted state.

## Pass/fail summary guidance

A good overall outcome looks like this:
- install/build/test succeeded
- pi loaded extension successfully
- peer lifecycle worked
- subagent flow worked
- teams flow worked
- persisted restore mostly worked or failed in clearly understandable ways
- attention UX/persistence worked with the synthetic fixture
- no unexplained crashes

A failed outcome worth documenting includes:
- install/load errors
- command crashes
- missing persistence where persistence is expected
- inconsistent dashboard state
- commands claiming behavior that reality does not match

## What to record if something fails

Please capture:
- exact command used
- exact visible output
- whether the problem reproduces after a pi restart
- whether `.pi-ca-leash/` contains the expected files
- whether the failure is package/runtime related or extension-host related
