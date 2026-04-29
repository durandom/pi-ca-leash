# Implementation Plan: pi-claude-code-agent

**Status (2026-04-29):** Runtime, intercom bridge, subagent backend, and teams backend all exist in this repo. This document is now partly historical. Use it as architecture intent plus honest gap tracking, not as a pure future plan.

## Goal

Build a Claude Code-backed execution stack that integrates cleanly with pi's existing orchestration primitives without pretending Claude Code is a normal stateless model provider.

## Core recommendation

Implement in this order:

1. **Runtime package**: extract/adapt a reusable Claude Code session runtime
2. **Intercom bridge**: make runtime sessions named and messageable
3. **pi-subagents backend**: reuse subagent TUI, async, status, and control for job-oriented delegation
4. **teams backend**: provide persistent teammate mode with task-board and messaging semantics

---

## Why this order

### Why not start with model-provider integration?

Because the provider abstraction is the wrong shape.

Claude Code is:
- stateful
- session-based
- tool-using
- resumable
- interruptible
- better described as an **agent runtime** than a model endpoint

pi model providers are optimized for:
- prompt/context in
- stream of assistant/tool-call events out
- stateless or lightly stateful turn execution

Trying to force Claude Code into that shape first would create avoidable complexity around:
- tool ownership
- replay semantics
- session identity
- compaction/fork interactions
- branching and resume behavior

So the correct first-class abstraction is **runtime**, not provider.

---

## Architectural north star

We want one reusable core and multiple adapters:

```text
claude-code-agent-runtime
  ├─ session lifecycle
  ├─ message send/resume/interrupt/stop
  ├─ transcript and status persistence
  ├─ event stream
  └─ Claude SDK driver(s)

adapters/
  ├─ intercom bridge
  ├─ pi-subagents backend
  └─ teams backend
```

This prevents duplicate protocol translations and keeps integration-specific logic out of the runtime core.

---

## Shared design principles

### 1. Keep runtime authoritative over Claude sessions
The runtime owns:
- session ids
- resume behavior
- event normalization
- transcript persistence
- interrupt and stop semantics

Adapters should not reimplement these.

### 2. Normalize once
Define one canonical event/status model in the runtime. Adapters consume normalized events rather than SDK-native event shapes.

### 3. Preserve long-lived sessions
The intercom and teams integrations only make sense if a Claude worker can survive beyond one delegated turn.

### 4. Support job mode and teammate mode separately
Two distinct usage patterns exist:
- **job mode**: run task, monitor progress, return result (`pi-subagents`)
- **teammate mode**: keep agent alive and keep messaging it (teams backend, `pi-intercom`)

Do not collapse these into one muddy API.

### 5. Be explicit about fake vs real forking
pi can create real branched session trees. Claude Code runtime cannot automatically inherit those semantics. Where parity is impossible, document the downgrade explicitly.

---

## Proposed repository structure

```text
pi-claude-code-agent/
  package.json
  README.md
  AGENTS.md
  docs/
    IMPLEMENTATION_PLAN.md
    sessions/
      01-runtime.md
      02-intercom.md
      03-subagents.md
      04-teams.md
  packages/
    runtime/
    intercom-bridge/
    subagents-backend/
    teams-backend/
  examples/
  test/
```

Initial session work can stay docs-first. Package directories can be created in Session 1 when implementation starts.

---

# Session roadmap

This plan is intentionally split into **four subsequent new sessions**. Each session should start from a clean context, complete a bounded slice, and leave a crisp handoff for the next session.

---

# Session 1 — Runtime foundation

## Objective

Create the reusable `claude-code-agent` runtime package as the single source of truth for Claude session execution.

## Outcome

At end of Session 1, there should be a standalone runtime API capable of:
- starting a Claude-backed session
- sending follow-up messages into an existing session
- interrupting and stopping sessions
- reading status and transcript tail
- persisting sessions to disk
- emitting normalized runtime events

## Scope

### In scope
- adapt/extract `ca-leash` concepts
- define public runtime API
- define normalized event model
- define status/session persistence format
- implement Claude SDK driver adapter
- provide smoke-test CLI or test harness for manual validation

### Out of scope
- pi integration
- intercom integration
- subagent integration
- team/task board integration

## Detailed work items

### 1. Decide packaging shape
Pick one:
- single package first (`packages/runtime` only)
- monorepo from day one (`packages/runtime`, future package dirs present)

Recommendation: start monorepo-shaped to avoid later repo churn.

### 2. Define runtime contracts
Create explicit types for:
- `RuntimeSessionId`
- `RuntimeSessionState`
- `RuntimeStatus`
- `RuntimeMessage`
- `RuntimeEvent`
- `StartSessionInput`
- `SendMessageInput`
- `InterruptResult`
- `TranscriptChunk`

Need a stable, adapter-friendly event surface. Suggested event families:
- `session.created`
- `session.updated`
- `session.idle`
- `session.stopped`
- `message`
- `tool`
- `result`
- `error`
- `attention` (reserved for later adapters)

### 3. Separate core from Claude-specific driver
Runtime package should have:
- core session manager
- driver registry / interface
- Claude driver implementation

This keeps future alternate backends possible and avoids hardwiring the runtime to one SDK import path.

### 4. Normalize Claude SDK output
Translate Claude SDK event/message structures into runtime events.
Careful with:
- text blocks
- thinking blocks
- tool use blocks
- tool result blocks
- init/session metadata
- result/usage metadata
- interrupt behavior

### 5. Persist robustly
Implement durable on-disk layout for:
- session state JSON
- transcript JSONL or append-only log
- optional metadata/artifacts

Need predictable paths because later adapters will poll/watch them.

### 6. Build runtime API
Minimum methods:
- `start(...)`
- `send(...)`
- `status(...)`
- `list(...)`
- `interrupt(...)`
- `stop(...)`
- `tail(...)`
- `readTranscript(...)`
- `events(...)`
- `subscribe(...)`

### 7. Test interrupt/resume semantics
This is critical. Need confidence that:
- interrupted session returns to a sane paused/idle state
- follow-up send works after interrupt
- stopped session cannot be resumed accidentally

### 8. Add manual operator entrypoint
Simple CLI or script for:
- start
- send
- status
- tail
- stop

Only for development verification. It is not final UX.

## Deliverables
- runtime package scaffold
- documented API
- normalized event model
- Claude driver adapter
- tests for session lifecycle
- minimal CLI/test harness

## Acceptance criteria
- can start Claude-backed session from shell
- can send at least one follow-up message to same session
- can interrupt active session without corrupting persisted state
- can read transcript and status after restart
- all runtime code contains zero pi-specific imports

## Risks
- Claude SDK interrupt semantics may not match expectations
- tool/result normalization may lose fidelity if done too aggressively
- persistence shape may later constrain adapters

## Mitigations
- keep raw metadata fields alongside normalized fields
- use append-only logging where possible
- store driver-native session id separately from runtime session id

## Session handoff requirements
Before ending Session 1, next session must have:
- package path and entrypoints documented
- exact runtime event schema documented
- example session directory layout documented
- unresolved runtime questions listed explicitly

---

# Session 2 — Intercom bridge

## Objective

Make runtime sessions visible and reachable through intercom semantics so long-lived Claude workers can be named and messaged.

## Outcome

At end of Session 2, one Claude runtime session can behave like a messageable peer from pi's perspective.

## Scope

### In scope
- bridge between runtime sessions and intercom presence/messaging
- named session registration
- message forwarding
- reply/ask correlation support where feasible
- bridge status and cleanup logic

### Out of scope
- subagent TUI integration
- task-board integration
- external team-product integration

## Key design decision

Need to choose bridge form:

### Option A — reusable broker client library
Pros:
- clean architecture
- non-pi processes can speak intercom directly

Cons:
- more refactor in `pi-intercom`

### Option B — thin pi extension host that proxies to local runtime
Pros:
- faster MVP
- lower risk

Cons:
- less reusable outside pi

Recommendation:
- **MVP**: Option B
- **stretch goal**: design Option A compatibility so future extraction stays possible

## Detailed work items

### 1. Define session identity model
Need mapping between:
- runtime session id
- intercom-visible peer name
- cwd
- model
- bridge process identity

Need stable naming rules and collision handling.

### 2. Define bridge lifecycle
Need explicit states:
- starting
- connected
- idle
- busy
- interrupted
- stopped
- errored
- disconnected

### 3. Map incoming intercom message to runtime send
When peer receives:
- `send`
- `ask`
- `reply`

bridge should:
- locate runtime session
- forward text into runtime
- observe output until reply boundary or timeout policy
- send response back when required

### 4. Decide reply boundary
This is subtle.

For intercom `ask`, when is Claude worker considered to have replied?
Options:
- first assistant text block
- final result of next idle cycle
- explicit bridge protocol instruction in prompt

Recommendation:
- use **next idle cycle final assistant summary**
- optionally allow explicit response extraction later

### 5. Prompt contract for bridged workers
Need a tiny system/runtime instruction layer saying:
- this session may receive intercom messages
- answer concisely when asked
- do not assume every message is a new standalone task

### 6. Bridge runtime events back into intercom status/presence
At minimum expose:
- name
- cwd
- model
- busy/idle status
- maybe last activity timestamp

### 7. Handle cancellation and orphan cleanup
Need safe cleanup if:
- pi host session exits
- runtime session stops
- intercom broker disconnects

### 8. Integration tests
Simulate:
- named worker receives message
- ask/reply roundtrip works
- disconnected bridge recovers or fails cleanly

## Deliverables
- intercom bridge package or extension
- documented identity/lifecycle model
- manual demo flow: launch worker, send/ask/reply, stop worker

## Acceptance criteria
- a Claude runtime session can appear as a named peer
- another pi session can send a message that reaches the runtime
- ask/reply flow completes end-to-end
- bridge cleanup leaves no zombie registrations

## Risks
- intercom protocol too coupled to pi session assumptions
- defining reply boundary may be messy
- bridged workers may produce overly verbose responses for `ask`

## Mitigations
- keep bridge contract narrow
- add bridge-specific prompt instructions
- prefer final idle-cycle response over speculative streaming completion

## Session handoff requirements
Before ending Session 2, next session must have:
- exact bridge API documented
- launch and cleanup flow documented
- known gaps between bridge mode and subagent expectations listed

---

# Session 3 — pi-subagents backend

## Objective

Integrate Claude runtime as a **new subagent execution backend** so existing subagent UX can be reused for delegated jobs.

## Outcome

At end of Session 3, `pi-subagents` can run selected agents through Claude runtime instead of only through pi child sessions.

## Scope

### In scope
- backend abstraction for `pi-subagents`
- runtime-backed single-run execution
- progress/status/control mapping
- async support mapping
- clarify TUI compatibility where possible

### Out of scope
- persistent teammate/task-board mode
- full team spawning

## Most important design decision

Add explicit backend/runner selection to agent definition and execution path.

Example frontmatter candidate:

```yaml
runner: claude-code-agent
```

or

```yaml
backend: claude-code-agent
```

Recommendation: use **`runner`** to emphasize execution backend, not model provider.

## Detailed work items

### 1. Add subagent backend abstraction
Current `pi-subagents` execution path is too pi-process-centric.
Introduce interface roughly like:
- `startRun(...)`
- `streamRun(...)`
- `interruptRun(...)`
- `statusRun(...)`
- `collectResult(...)`

Then implement:
- `pi` backend (existing)
- `claude-code-agent` backend (new)

### 2. Map subagent task to runtime prompt contract
Need exact transformation from subagent invocation into Claude runtime start/send.
This includes:
- task text
- cwd
- model override
- system prompt / agent prompt
- skills / project context decisions

### 3. Map progress and status
Need runtime-to-subagent mapping for:
- running
- idle
- paused/interrupted
- failed
- completed
- recent output tail
- tool activity if available

### 4. Map control semantics
pi-subagents has needs-attention / interrupt / async control.
Need mapping to runtime:
- runtime inactivity -> subagent attention signal
- subagent interrupt -> runtime interrupt
- subagent stop -> runtime stop

### 5. Decide fork behavior
This is biggest truth-telling area.
For runtime backend, options:
- no fork support
- pseudo-fork by materializing current branch into prompt

Recommendation:
- support `fresh`
- support `fork` only as **explicit pseudo-fork** if implemented
- show badge or result note that this is not a real pi branch fork

### 6. Async and persisted results
Reuse subagents async/result directories if possible.
Need adapter that writes expected:
- status.json
- events.jsonl
- result summary

without reimplementing all runtime persistence.

### 7. Clarify TUI support
Good news: clarify TUI is pre-launch parameter editing. Backend-agnostic.
Need only ensure model/runner-specific options are represented sensibly.

### 8. Integration tests
Need to prove:
- `/run` using runner=claude-code-agent works
- background run works
- status/interrupt work
- control notification path works or degrades gracefully

## Deliverables
- `pi-subagents` backend abstraction
- runtime backend implementation
- docs for `runner: claude-code-agent`
- integration tests

## Acceptance criteria
- subagent agent definition can opt into Claude runtime backend
- `/run` or tool-call equivalent completes through Claude runtime
- async status appears in existing subagent UI/status flow
- interrupt works from subagent control path
- no regression for existing pi backend agents

## Risks
- current `pi-subagents` executor may be tightly coupled to process spawning
- result rendering may assume pi-native transcript shapes
- fake fork semantics may confuse users

## Mitigations
- isolate backend abstraction surgically
- preserve existing result envelope shape
- clearly annotate runtime-backed runs in UI/output

## Session handoff requirements
Before ending Session 3, next session must have:
- exact runner selection syntax documented
- list of remaining gaps vs persistent teammates documented
- explicit note on fork limitations documented

---

# Session 4 — teams backend

## Objective

Use Claude runtime + intercom bridge to support **persistent teammate mode**, making this the closest analogue to Claude agent teams.

## Outcome

At end of Session 4, a team can include Claude-backed long-lived workers that:
- stay alive
- receive new tasks/messages over time
- participate in team messaging/task flow
- operate as teammates, not one-shot jobs

## Scope

### In scope
- teammate backend abstraction in this repo
- launch/manage Claude-backed teammate workers
- inbox/task/message bridge
- persistent worker lifecycle

### Out of scope
- polished parity with every existing pi teammate feature on day one
- provider integration

## Key idea

This repo's teams backend is the right layer for long-lived collaborative workers.
Claude runtime sessions are naturally compatible with teammate persistence once messaging is bridged.

## Detailed work items

### 1. Add teammate backend abstraction
Current teams backend should assume spawned teammates are runtime-backed workers.
Need abstraction for:
- spawn
- stop
- send message
- check status
- maybe attach logs/pane info

Implement:
- `claude-code-agent` teammate backend

### 2. Decide worker host form
Possible implementations:
- headless runtime + visible logs
- shell wrapper process in pane/window that hosts runtime bridge
- tiny pi extension host that proxies into runtime

Recommendation:
- wrapper process in pane/window for observability
- host intercom bridge there or connect to central bridge manager

### 3. Map team task semantics to runtime messaging
Need rules for:
- initial teammate prompt
- ongoing task assignment
- task update acknowledgements
- completion reporting
- clarification requests

This probably needs a teammate-specific prompt contract:
- regularly read task/messages
- respond with concise updates
- do not treat every message as fresh project bootstrap

### 4. Decide inbox/task API bridge
Claude worker needs conceptual equivalents for:
- read inbox
- send message
- report progress
- report completion

Since Claude runtime is not a pi session with tools, bridge must translate team operations into runtime messages and runtime outputs back into team board updates.

### 5. Persist teammate metadata
Need bookkeeping for:
- runtime session id
- team member id
- intercom peer name
- terminal pane/window mapping
- current assigned task(s)

### 6. Failure handling
Need clean behavior when:
- pane/window dies
- runtime session stops unexpectedly
- teammate disconnects from bridge
- task is left half-owned

### 7. Demo workflow
Must support at least:
- create team
- spawn Claude teammate
- assign task
- teammate asks clarification
- teammate reports completion

### 8. Stretch: richer team UX
Best outcome later:
- better task-board UX
- optional direct human/team inbox views
- optional non-Claude teammate types only if a concrete need appears

## Deliverables
- teams backend abstraction
- Claude teammate backend
- teammate prompt/message contract docs
- demo workflow script/docs

## Acceptance criteria
- can spawn long-lived Claude-backed teammate from this repo's teams backend
- teammate can receive multiple messages/tasks over time
- teammate can participate in task-board and direct-messaging flow
- teammate shutdown cleans up runtime and registration cleanly

## Risks
- task/inbox semantics may require a larger bridge layer than expected
- pane/window UX may expose runtime host details awkwardly
- richer board semantics may be more product work than runtime work

## Mitigations
- keep teammate backend protocol minimal
- use wrapper process for observability and simpler ops
- resist adding alternate teammate types without a concrete need

---

## Cross-session rules

Every session should:
- create/claim explicit work items if beads is functional in the target repo
- leave a written handoff document for next session
- avoid silently changing core contracts without updating docs
- preserve backward compatibility where touching `pi-subagents`

---

## Resolved decisions and remaining gaps

Resolved in this repo:

1. Intercom bridging started as host-side proxy logic, then gained an optional live `pi-intercom` broker transport adapter.
2. The local extension now surfaces broker disconnect/reconnect, auto-refreshes the dashboard, and can rebind peers after broker return.
3. `fork` is still explicitly unsupported for the local runtime-backed subagent backend in this repo.
4. Runtime event stream exposes normalized generic events while preserving raw driver payloads.
5. Team-style collaboration here routes through runtime bridge semantics and intercom-style messaging.
6. Mixed-backend team orchestration is no longer a goal in this repo unless a concrete need appears.

Remaining gaps:

1. No proven upstream `pi-subagents` package wiring from this repo into the real installed extension.
2. Late broker availability is handled in the local extension via retry/rebind, but broker spawning is still owned by `pi-intercom`.
3. Attention ack/snooze is currently persisted local extension state, not a shared cross-session control protocol.
4. Cross-process resurrection is still limited: persisted state survives, active in-flight process control does not.
5. Teams backend remains local/package-level rather than integrated into any broader external team product.

---

## Recommended success metric per phase

### Phase 1 success
A developer can script Claude sessions through the runtime without pi.

### Phase 2 success
A Claude session can be named and messaged like a peer.

### Phase 3 success
A subagent can delegate a bounded job to Claude runtime using existing subagent UX.

### Phase 4 success
A Claude-backed worker can remain alive as a teammate and collaborate through team messaging/task flow.

---

## Final recommendation

Build this as **runtime first, adapters second**.

That keeps the hard part—the Claude session lifecycle—centralized and prevents every pi integration from inventing its own partial Claude wrapper.
