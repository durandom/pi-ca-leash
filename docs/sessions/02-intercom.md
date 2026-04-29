# Session 2 — Intercom bridge

Status: implemented
Date: 2026-04-25

## What shipped

Created `packages/intercom-bridge` as thin host-side bridge on top of runtime.

```text
packages/
  runtime/
  intercom-bridge/
```

Implemented package: `@pi-claude-code-agent/intercom-bridge`

Contents:
- `ClaudeRuntimeIntercomBridge` orchestration class
- peer launch/attach/list/status/stop/disconnect API
- `send` / `ask` / `reply` message semantics
- idle-cycle reply extraction
- bridge prompt contract
- demo CLI harness
- unit tests with fake runtime driver

## Forced decisions made

### 1. Bridge form

Decision: **Option B first** — thin host-side proxy package.

Why:
- lowest-risk MVP
- no refactor of `pi-intercom` required yet
- keeps real intercom integration as outer adapter concern

Truth:
- this is not yet reusable broker-client parity
- transport extraction can happen later without changing runtime contract

### 2. Reply boundary

Decision: **next idle cycle**.

`ask(...)` behavior:
- capture event cursor before forwarding message
- send inbound intercom envelope into runtime session
- wait until runtime reaches terminal state for that cycle (`idle|interrupted|failed|stopped`)
- read new events since cursor
- derive reply from latest assistant text, fallback to result summary

Why:
- stable and deterministic
- matches Session 1 handoff guidance
- avoids guessing on partial stream chunks

### 3. Prompt contract

Bridge appends runtime instruction:
- session is long-lived and intercom-addressable
- inbound messages are continuation, not fresh bootstrap
- asks/replies should be concise
- end each handled message in clean idle state

## Public API summary

Main export: `ClaudeRuntimeIntercomBridge`

Methods:
- `launchPeer(input)` — start runtime session and register visible peer name
- `attachPeer(input)` — bind existing runtime session to visible peer name
- `listPeers()` — list known peers
- `status(name)` — bridge-visible peer status
- `send(name, message)` — forward one message, wait for idle cycle, return updated peer
- `ask(name, message)` — forward one message, wait for idle cycle, return extracted reply + events
- `reply(name, message)` — same forwarding path, preserving reply metadata in message envelope
- `stop(name)` — stop underlying runtime session
- `disconnect(name)` — mark bridge peer disconnected without deleting runtime session

Helpers exported:
- `BRIDGE_SYSTEM_PROMPT`
- `formatInboundMessage(...)`
- `extractReplyText(...)`
- `mapRuntimeState(...)`

## Message envelope

Inbound intercom messages are materialized into runtime text like:

```text
[intercom kind=ask from=planner replyTo=msg-1]

What is status?
```

This keeps transport-neutral metadata without inventing new runtime event types.

## Identity model

Current mapping:
- runtime session id → persisted runtime authority
- bridge peer name → human-visible address
- cwd/model → mirrored from runtime status

Rules:
- peer names must be unique per bridge instance
- attach fails for unknown runtime session ids
- duplicate peer name registration rejected immediately

## Lifecycle model

Bridge-visible states:
- `starting`
- `connected`
- `idle`
- `busy`
- `interrupted`
- `stopped`
- `errored`
- `disconnected`

Runtime mapping now:
- `starting` → `starting`
- `running` → `busy`
- `idle` → `idle`
- `interrupted` → `interrupted`
- `stopped` → `stopped`
- `failed` → `errored`

## Validation done

### Unit tests passing

Command:

```bash
npm run test --workspace @pi-claude-code-agent/intercom-bridge
```

Coverage:
- launch + registration
- ask waits for idle-cycle reply
- send/reply both forward through runtime
- reply extraction helper behavior

### Demo harness

Command:

```bash
npm run demo --workspace @pi-claude-code-agent/intercom-bridge -- "You are demo worker. Reply briefly."
```

Flow:
- launch named worker
- ask worker for exact response
- stop worker

## Known limits / unresolved questions

1. No real `pi-intercom` transport binding yet.
   - This package is host-side bridge logic only.
   - Actual broker registration/proxy layer still needed in pi integration.

2. Peer registry is in-memory only.
   - Runtime session persistence exists.
   - Bridge peer-name registry does not survive bridge process restart yet.

3. Busy handling is strict.
   - concurrent inbound messages are rejected
   - no queueing yet

4. Reply extraction is text-first.
   - latest assistant text wins
   - falls back to `result.summary`
   - tool-only responses may need richer extraction later

5. Disconnect is bridge-local.
   - it does not unregister from real intercom because no transport exists yet

## Known gaps vs Session 3 needs

Subagents will need more than this bridge provides:
- async persistence in subagent-native directories
- needs-attention/control notifications
- backend selection and result envelopes
- explicit truth around fake `fork` semantics

## Example launch flow

```ts
const bridge = new ClaudeRuntimeIntercomBridge();

const peer = await bridge.launchPeer({
  name: "researcher",
  prompt: "You are long-lived worker. Be concise.",
  permissionMode: "bypassPermissions",
});

const answer = await bridge.ask("researcher", {
  from: "planner",
  text: "Reply with exactly: bridge-ok",
});

await bridge.stop("researcher");
```

## Next session handoff

Session 3 can assume:
- runtime-backed peers can now be addressed by stable bridge name
- `ask` has deterministic idle-cycle reply boundary
- bridge prompt contract exists
- transport-neutral message envelope exists

Main caution for Session 3:
- this bridge is not real intercom transport yet
- subagents should integrate against runtime first, not depend on bridge registry persistence
