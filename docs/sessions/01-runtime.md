# Session 1 — Runtime foundation

Status: implemented
Date: 2026-04-25

## What shipped

Monorepo shape chosen now, not later:

```text
packages/
  runtime/
```

Implemented reusable runtime package at `packages/runtime` with:
- runtime contracts and public API
- Claude SDK driver integration
- session lifecycle management
- disk persistence
- normalized event stream
- smoke CLI harness
- unit tests

## Package layout

```text
packages/runtime/
  src/
    cli.ts
    index.ts
    persistence.ts
    runtime.ts
    types.ts
    drivers/
      claude-sdk.ts
  test/
    runtime.test.ts
```

## Public API summary

Package: `@pi-claude-code-agent/runtime`

Main export: `ClaudeCodeRuntime`

Methods:
- `start(input)` → create session, persist it, launch Claude run
- `send(input)` → resume existing session with follow-up message
- `status(sessionId)` → read persisted status
- `list()` → list persisted sessions
- `interrupt(sessionId)` → signal active Claude process with `SIGINT`
- `stop(sessionId)` → mark session stopped and interrupt active run if needed
- `tail(sessionId, limit?)` → read transcript tail
- `readTranscript(sessionId, cursor?)` → paged transcript read
- `events(sessionId, cursor?)` → paged full event log read
- `subscribe(listener, sessionId?)` → live event subscription
- `stream(sessionId?)` → async iterable live event stream

Core types exported:
- `RuntimeSessionId`
- `RuntimeSessionState`
- `RuntimeStatus`
- `RuntimeMessage`
- `RuntimeEvent`
- `StartSessionInput`
- `SendMessageInput`
- `InterruptResult`
- `TranscriptChunk`
- `RuntimeDriver`

## Forced decisions made

### 1. Package layout

Decision: monorepo-shaped now.

Reason:
- matches later adapter split
- avoids repo churn in Session 2+
- keeps runtime isolated from pi imports

### 2. Event schema

Decision: one normalized runtime event log, append-only JSONL.

Event families implemented:
- `session.created`
- `session.updated`
- `session.idle`
- `session.stopped`
- `message`
- `tool`
- `result`
- `error`

`attention` reserved in types, not produced yet.

Notes:
- raw Claude payload preserved on normalized events via `raw`
- tool use and tool result become explicit `tool` events
- transcript file includes only `message|tool|result|error`
- full event log includes session lifecycle events too

### 3. Persistence layout

Decision: per-session directory under runtime storage root.

Default root:

```text
.claude-runtime/
```

Session layout:

```text
.claude-runtime/
  sessions/
    <session-id>/
      state.json
      events.jsonl
      transcript.jsonl
      artifacts/
```

Files:
- `state.json` — latest durable session status
- `events.jsonl` — all normalized runtime events
- `transcript.jsonl` — user-facing transcript subset
- `artifacts/` — reserved for later adapter outputs

### 4. Interrupt semantics

Decision: runtime-level interrupt = signal active Claude CLI process with `SIGINT`.

Behavior:
- active run gets `SIGINT`
- runtime marks session `interrupted`
- later `send(...)` resumes same Claude session id
- `stop(...)` is stronger semantic state: session becomes non-resumable at runtime API level

Truth:
- this is host-process interrupt semantics, not proven Claude-native transactional cancellation
- safe enough for Session 1 runtime control
- later adapters should treat interrupt as best-effort, not as exact replay boundary guarantee

## Claude driver integration

Implemented driver: `ClaudeSdkDriver`

Current strategy:
- use `@anthropic-ai/claude-agent-sdk` directly
- feed prompt through SDK stream input
- resume with persisted Claude session id
- normalize SDK messages into runtime events
- interrupt via SDK `interrupt()` / `close()` on abort

Why SDK driver:
- already proven in `ca-leash`
- avoids extra CLI subprocess hop
- cleaner interrupt/lifecycle control
- keeps normalization logic reusable inside runtime process

## Validation done

### Unit tests passing

Command:

```bash
npm test
```

Coverage:
- start persists state and transcript
- send reuses persisted driver session id
- tool events normalize correctly
- interrupt marks active run interrupted

### Build passing

Command:

```bash
npm run build
```

### Smoke harness demonstrated

Command run:

```bash
npm run smoke -- "Reply with exactly: smoke-ok"
```

Observed:
- session started
- Claude CLI responded
- runtime persisted `state.json`
- transcript tail contained `message` and `result` events

## Example session directory

Example after smoke run:

```text
.claude-runtime/
  sessions/
    b03f3482-2d17-4c0f-ae28-43e2d10f317b/
      state.json
      events.jsonl
      transcript.jsonl
      artifacts/
```

## Known limits / unresolved questions

1. Active runs are process-local.
   - Persisted status survives restart.
   - Active child process control does not survive host process exit.
   - If we need cross-process control later, we need daemonization or PID bookkeeping + attach story.

2. Interrupt semantics are best-effort.
   - We kill local Claude CLI process.
   - We do not yet prove what Claude persists mid-tool-run on every path.

3. Event schema is useful but still coarse.
   - partial assistant chunks not exposed
   - rate-limit/system secondary events not normalized yet
   - thinking blocks preserved only as generic message blocks

4. Persistence is simple JSON/JSONL.
   - good for polling adapters
   - no file locking beyond atomic state replace
   - concurrent multi-process writers are not supported

5. CLI harness is smoke-only, not operator-grade.
   - enough for manual validation
   - not yet a persistent runtime daemon or full admin CLI

## Explicit out-of-scope lines held

Did not implement:
- intercom bridge
- subagents backend
- teams backend
- fake provider layer

## Next session handoff

Session 2 can assume:
- runtime package path: `packages/runtime`
- normalized event log exists
- persistent session directories exist
- session ids are stable and resumable
- `subscribe`, `events`, `status`, `send`, `interrupt`, `stop` exist

Main caution for Session 2:
- intercom bridge must not assume active process control survives runtime host exit
- reply-boundary logic should use `session.idle` + latest `result/message`, not raw Claude CLI completion alone
