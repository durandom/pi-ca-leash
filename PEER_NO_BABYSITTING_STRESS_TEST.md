# Peer No-Babysitting Stress Test

- Date: 2026-05-02
- Repository: `pi-ca-leash`
- Status: reusable manual stress test definition
- Scope: peer-first Claude runtime UX in pi

## Goal

Verify that the main agent treats a Claude peer as an asynchronous worker, not as something it must supervise.

Core behavior:

> Start peer, receive clear handling instructions, do independent work, and react only when the peer sends completion, attention, or error back into the main context.

## Non-goals

This test does not validate:
- real upstream `pi-subagents` integration
- real Claude fork/session-tree semantics
- external `pi-teams` integration
- full runtime correctness under heavy load

## UX requirements under test

### Requirement 1 — Peer-start guidance appears in main context

Whenever a peer is started through the LLM-callable `peer_start` tool, the main chat should receive an explicit guidance message.

Required message intent:

```text
Peer started: <name>

How to work with this peer:
- Treat it as an async worker/subagent.
- Do not poll it with peer_list, peer_history, or repeated peer_ask calls.
- Continue your own work or wait passively.
- The peer will send a follow-up into the main context when it is done, blocked, or failed.
- Only contact the peer if the user explicitly asks, or if the peer asks for input.
```

Acceptance notes:
- Exact wording may change, but the message must clearly say **no polling loop**.
- The guidance must be visible in the main conversation, not only in internal logs.
- This guidance should appear for LLM-started peers, not only slash-command peers.

### Requirement 2 — `peer_ask` shows the outgoing prompt

Whenever the LLM-callable `peer_ask` tool sends a prompt to a peer, the chat UI should show what was sent.

Required visible shape:

```text
Sent to peer <name>:
<exact prompt or concise preview>
```

Acceptance notes:
- The user must be able to audit what the main agent asked the peer.
- Long prompts may be collapsed or previewed, but there must be a way to inspect the full text.
- Hiding the outgoing prompt is a UX failure, even if the peer response arrives correctly.

## Primary invariant

During peer work, the main agent must not babysit.

Forbidden after peer start and before peer final/attention/error:
- `peer_list` polling
- `peer_history` polling
- repeated `peer_ask` status checks
- “Are you done?” messages
- artificial monitor loops

Allowed:
- continue independent work
- answer the user about the plan
- inspect unrelated files
- wait passively
- respond to automatic peer completion/attention/error message

## Test setup

Start pi from this repository with the extension installed.

Optional clean baseline:

```bash
git status --short
npm test
npm run build
```

Expected:
- tests/build are green before manual UX testing
- any dirty working tree state is understood

## Test script: single delayed peer

### Step 1 — Ask main agent to start one peer

User prompt:

```text
Start one Claude peer for a no-babysitting stress test.
The peer must wait about 30 seconds, then reply with exactly:
PEER_DONE_NO_BABYSITTING_1
Do not poll the peer. While it works, write a short local checklist for what you are allowed and not allowed to do.
```

Expected main-agent action:
- calls `peer_start` once
- does not immediately call `peer_list`, `peer_history`, or `peer_ask`

Expected visible UX:
- peer start acknowledgment is visible
- peer-start guidance is visible in the main context
- guidance explicitly says not to poll/babysit

### Step 2 — Main agent does independent work

Expected main-agent behavior while peer runs:
- creates or drafts a tiny checklist in the main response or a scratch file
- does not ask the peer for status
- does not inspect peer history
- does not run a peer monitor loop

Suggested checklist content:

```text
Allowed:
- continue independent work
- wait passively for peer completion
- respond when peer sends final/attention/error

Forbidden:
- polling peer_list
- polling peer_history
- repeated status peer_ask
- asking “are you done?”
```

### Step 3 — Peer completion arrives automatically

Expected peer final message:

```text
PEER_DONE_NO_BABYSITTING_1
```

Expected main-agent behavior after automatic completion:
- acknowledges the peer result
- reports that no babysitting was used
- summarizes pass/fail

## Pass criteria

The test passes only if all are true:

- `peer_start` was called once.
- Main context showed peer-start guidance.
- Guidance told the main agent not to poll the peer.
- No peer polling occurred before peer completion/attention/error.
- Main agent continued independent work or waited passively.
- Peer completion arrived automatically in main context.
- Main agent processed the completion after it arrived.

## Fail criteria

The test fails if any are true:

- Main agent calls `peer_list` merely to check progress.
- Main agent calls `peer_history` merely to check progress.
- Main agent sends “are you done?” or equivalent to the peer.
- Main agent blocks the conversation with an explicit polling loop.
- Peer-start guidance is missing from main context.
- `peer_ask` sends a prompt without showing the outgoing prompt to the user.
- Peer result arrives only in hidden logs and not in the main context.

## Test log template

```text
Date:
Pi version/context:
Runtime driver: claude-sdk | codex-cli
Peer name:

| Check | Pass/Fail | Notes |
|-------|-----------|-------|
| peer_start called once | | |
| start guidance visible | | |
| guidance says no polling | | |
| no peer_list polling | | |
| no peer_history polling | | |
| no status peer_ask | | |
| independent main-agent work happened | | |
| automatic peer completion visible | | |
| main processed completion | | |
| peer_ask outgoing prompt visible, if used | | |

Verdict:
Follow-up issues:
```

## Regression targets

These behaviors are now expected to stay green:

1. LLM-callable `peer_start` injects no-babysitting guidance into tool output and the visible chat UI.
2. `peer_ask` renders the outgoing prompt/previews in the visible chat UI and returns it in tool output.
3. Peer transcript noise stays quiet, but lifecycle events remain visible.

## Future extensions

After this single-peer test is stable, add:
- three peers with staggered completion times
- one peer that asks for clarification
- one peer that fails with a structured error
- one long-output peer that writes details to an artifact and only summarizes in chat
