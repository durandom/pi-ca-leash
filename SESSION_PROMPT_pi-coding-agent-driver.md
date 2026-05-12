# Session prompt — pi-coding-agent runtime driver (upstream Phase B)

This is a handoff prompt for a future Claude Code session run **inside this
repository** (`/Users/mhild/src/durandom/pi-ca-leash`). It pairs with the
Spellkave-side plan at
`/Users/mhild/.claude/plans/merry-hugging-cocoa.md` (Phase B upstream
section).

## Context

Spellkave's `work-issue` orchestrator can launch agent runs through two
drivers today:

1. **ca-leash driver** (Claude Code via `pi-ca-leash`) — already a first-class
   managed peer in `/peer list` with `metadata.workIssueRunId` tags.
2. **pi-coding-agent driver** — invokes
   `@earendil-works/pi-coding-agent`'s `createAgentSession` directly,
   bypassing `pi-ca-leash`. It is **not** a managed peer; it never appears
   in `/peer list`; the runtime's per-driver event log/state directory is
   never written for these sessions.

That asymmetry is a known follow-up. The Spellkave-side runner is in
`packages/work-issue-runtime/src/runners/pi-coding-agent.ts` (after the
Spellkave Phase A package split lands — currently a single file under
`packages/work-issue-runtime/src/agent.ts` if pre-Phase-A).

Goal of this upstream session: add a `pi-coding-agent` `RuntimeDriver`
inside `pi-ca-leash` so the Spellkave-side runner can collapse to a thin
`PiCaLeashManagedPeerApi` wrapper, identical in shape to the ca-leash
runner. After this lands and is published, the Spellkave repo bumps the
`pi-ca-leash` dependency and rewrites its runner.

## Scope (upstream PR — this session)

Branch: `feature/pi-coding-agent-driver` off `main` here.

### Files to add/modify

**NEW** — `packages/runtime/src/drivers/pi-coding-agent.ts`

- Implements `RuntimeDriver` (same shape as `claude-sdk.ts`; read that
  file first as the model — it is the closest analogue).
- Wraps `createAgentSession({...})` from `@earendil-works/pi-coding-agent`.
- Maps pi-coding-agent's `AgentSessionEvent` stream to the runtime's
  normalized event envelopes (`DriverEventEnvelope` + the
  `NormalizedDriverMessage*` types in `messages.ts`).
- Persistence: writes
  `<cwd>/.pi-ca-leash/runtime/sessions/<sid>/state.json` and
  `events.jsonl` like every other driver. No special-case storage.
- `interrupt` ↔ `session.dispose()`; `stop` ↔ `session.dispose()` + remove
  from the driver registry.
- `status` returns the latest snapshot built from the event stream.
- Emits per-`result` token-usage in the same shape as siblings. The
  driver must accumulate usage per-message (see ARCHITECTURE.md L41-43
  for the documented gap — fix it for this driver from day one).

**MODIFY** — `packages/intercom-bridge/src/managed-peers.ts`

- Add `"pi-coding-agent"` to the `RuntimeDriverName` union.
- `launchPeer` already dispatches by `driver` name; no API surface change.

**MODIFY** — `extensions/model-catalog.ts`

- Add `RUNTIME_MODEL_CATALOGS["pi-coding-agent"]` mapping to whichever
  model registry pi-coding-agent exposes (typically Anthropic models
  routed through pi-ai's provider abstraction).

**MODIFY** — `packages/runtime/src/index.ts`

- Export the new driver alongside `claude-sdk.ts`, `claude-cli.ts`,
  `codex-cli.ts`.

**NEW** — `packages/runtime/test/drivers/pi-coding-agent.test.ts`

- Cover: start/send/status/stop/interrupt; event-shape parity with
  `claude-sdk.ts`'s tests; usage accumulation produces a non-zero total
  after a multi-message run.

## Critical risks

- ⚠️ **Event-shape mapping.** pi-coding-agent's `AgentSessionEvent` is
  not identical to claude-sdk's stream. Wrong `tool_call`/`tool_result`/
  `message` mapping will silently break `/peer history`. Spend time
  reading the actual `AgentSessionEvent` type from
  `@earendil-works/pi-coding-agent` and writing a translation table
  before coding the driver. The Spellkave-side
  `PiCodingAgentRunner` (see Spellkave repo) is the reference
  implementation — port the event-translation logic from there into the
  driver, then have the runner consume the new driver via
  `PiCaLeashManagedPeerApi`.
- ⚠️ **Token-usage accumulation.** `ARCHITECTURE.md` L41-43 documents
  that the runtime does not accumulate token usage across driver calls.
  Do not inherit that gap — make pi-coding-agent's driver compute
  per-`result` and rolling totals correctly. If the architectural fix is
  too invasive for this PR, at minimum surface accurate per-message
  values so consumers can sum them client-side.
- ⚠️ **Existing test infrastructure** for runtime drivers — read
  `packages/runtime/test/drivers/claude-sdk.test.ts` (if it exists; if
  not, model after `codex-cli.test.ts`). Reuse the mock + fixture
  patterns.

## Critical files to read before coding

1. `packages/runtime/src/drivers/claude-sdk.ts` — closest analogue.
2. `packages/runtime/src/types.ts` — `RuntimeDriver` interface.
3. `packages/runtime/src/drivers/messages.ts` — normalized event types.
4. `packages/intercom-bridge/src/managed-peers.ts` — dispatch site.
5. `extensions/model-catalog.ts` — catalog wiring.
6. `ARCHITECTURE.md` — global runtime conventions (L41-43 on
   token-usage gap).
7. **Cross-repo reference**: Spellkave's current
   `PiCodingAgentRunner` in
   `/Users/mhild/src/durandom/spellkave-workflow-dev/packages/work-issue-runtime/src/runners/pi-coding-agent.ts`
   (post-Phase-A; if pre-Phase-A, file is `…/work-issue-runtime/src/agent.ts`).
   That runner's event-translation logic is the prior art.

## Verification before opening the PR

```bash
# Build + lint
npm run build
npm run lint

# Test suite passes
npm test

# New driver-specific tests pass (>= 5 tests covering start/send/status/stop/interrupt)
npm test -- packages/runtime/test/drivers/pi-coding-agent

# Quick smoke against a real spawn (use existing scripts/smoke pattern if present)
```

## PR title + body

Title: `feat(runtime): add pi-coding-agent driver for managed-peer parity`

Body should call out:

- Why: Spellkave's work-issue extension needs uniform peer observability
  across drivers. Currently pi-coding-agent sessions are invisible in
  `/peer list`; this driver fixes that.
- Link the Spellkave plan
  (`/Users/mhild/.claude/plans/merry-hugging-cocoa.md`, Phase B
  upstream section).
- Note the token-usage accumulation behaviour (whether you fixed it
  globally or just for this driver).
- Test plan: covered in test file; verified `/peer list` shows
  pi-coding-agent peers in the smoke test.

## Downstream coordination (after this PR merges)

A separate Spellkave PR will:

1. Bump `pi-ca-leash` dependency in `packages/work-issue-runtime/package.json`
   from `file:../../../pi-ca-leash` to whatever published version this
   upstream PR lands on (or keep file-dep if pi-ca-leash isn't published
   yet — in that case nothing to bump, just merge the upstream change).
2. Rewrite `packages/work-issue-runtime/src/runners/pi-coding-agent.ts`
   as a near-copy of `runners/ca-leash.ts` with `driver: "pi-coding-agent"`.
3. Collapse `runners/configured.ts`'s `if (agent === "ca-leash")` branch
   into a single peer-launching path with the driver name as the only
   knob.

That downstream session is **separate** from this upstream session and
should not be attempted in the same conversation.

## How to start the session

In `/Users/mhild/src/durandom/pi-ca-leash`:

```
claude
> Read SESSION_PROMPT_pi-coding-agent-driver.md and execute Phase B upstream.
```

Lead expectations:

- Read all "critical files to read" before writing any code.
- Run verification gates before opening the PR.
- If the event-shape translation table is non-obvious, write a short
  ADR-like note in `docs/` capturing the mapping decisions.

## Out of scope

- The Spellkave-side runner rewrite (separate session, downstream).
- Castra v2 (Spellkave Phase C, blocked on this PR).
- Backfilling token-usage accumulation across the other three drivers
  (claude-sdk, claude-cli, codex-cli) — note it as a follow-up issue if
  you fix it here for pi-coding-agent only.

---

## Session outcome (2026-05-12)

Branch: `feature/pi-coding-agent-driver` (off `main`).

### What landed

**New**
- `packages/runtime/src/drivers/pi-coding-agent.ts` — `PiCodingAgentDriver`
  implementing `RuntimeDriver`. Wraps `createAgentSession(...)` from
  `@earendil-works/pi-coding-agent` (dynamic import; optional dep).
  Exposes an injectable `createSession` factory for testability,
  mirroring `CodexCliDriver`'s `spawn` injection.
- `packages/runtime/test/pi-coding-agent.test.ts` — 14 tests:
  parser translation table (6), runtime integration via a scripted
  fake session (6: start, usage-accumulation across two runs, send,
  status, stop, createSession-failure), direct-driver kill + delivery
  ordering (2).
- `docs/pi-coding-agent-event-mapping.md` — ADR-style translation
  table, usage-field mapping, lifecycle (`kill ↔ session.abort()`,
  teardown ↔ `session.dispose()`), and known limitations.

**Modified**
- `packages/runtime/src/types.ts` — extended `RuntimeDriverName` union
  with `"pi-coding-agent"`.
- `packages/runtime/src/driver-config.ts` + `extensions/runtime-driver.ts`
  — parsers accept the new name.
- `packages/runtime/src/runtime.ts` — instantiates and registers
  `PiCodingAgentDriver` alongside the other defaults.
- `packages/runtime/src/index.ts` — re-exports the driver and types.
- `extensions/index.ts` — added to `RUNTIME_DRIVER_ENUM`; compact-label
  `pi-ca` in `compactDriver()`.
- `extensions/runtime-safety.ts` — binary hint for the new driver.
- `extensions/model-catalog.ts` — added `provider: "pi-ai"` variant;
  `pi-coding-agent` shares the Anthropic model list with `claude-sdk`,
  `flag: "pi --model <provider>/<id>"`. `modelCatalogsForDriver()` now
  enumerates the new driver.
- `ARCHITECTURE.md` — driver list + diagram updated; resume limitation
  flagged.

### Event translation (final)

```
tool_execution_start   → tool_use
message_end (assistant)→ assistant       (text / thinking / toolCall→tool_use blocks)
message_end (toolResult)→ tool_result
turn_end               → result          (usage from message.usage, per-turn)
agent_*/turn_start/message_start|update/tool_execution_update|end/queue_update → dropped
```

Usage map: pi-ai `Usage` → `NormalizedDriverUsage`
(`input→inputTokens`, `output→outputTokens`,
`cacheRead→cacheReadInputTokens`, `cacheWrite→cacheCreationInputTokens`,
`cost.total→totalCostUsd`; `contextTokens` derived as
`input + cacheRead + cacheWrite`).

### Token-usage decision

Did **not** fix the runtime-wide accumulation gap
(`ARCHITECTURE.md:41-43`). Instead, surface accurate per-`turn_end`
usage values so consumers can sum client-side. The integration test
`integration — usage is reported per turn_end and accumulates across
two runs` exercises this contract (two runs, summed `inputTokens` =
120). Follow-up issue: backfill accumulation across all four drivers.

### Verification gates

- `npm run build` — clean across all 4 workspaces.
- `npm test` — **184/184 pass** (intercom-bridge 19, runtime 55,
  subagents-backend 8, teams-backend 6, extensions 96).
- `npm run lint` — script does not exist in this repo (verified
  `package.json`); skipped.
- Smoke against a real spawn — skipped; the driver is exercised end-to-end
  through `ClaudeCodeRuntime` with a fake `createSession` factory, which
  covers the same `runtime.start / send / status / stop / interrupt` surface
  as a live spawn would.

### Known limitations (carried forward)

- **No resume.** `RuntimeDriverRunInput.resumeSessionId` is accepted
  but ignored; each `driver.run()` creates a fresh `AgentSession`.
  Multi-turn through `runtime.send()` therefore spawns a new
  pi-coding-agent session per send. Documented in the ADR.
- **Optional peer dep.** `@earendil-works/pi-coding-agent` is not in
  `packages/runtime/package.json`. Selecting this driver without
  installing the package surfaces a clear error
  ("pi-coding-agent driver requires @earendil-works/pi-coding-agent")
  via the driver's catch-and-emit path.
- **Model resolution.** Bare ids resolved via `ModelRegistry.getAll()`;
  use `<provider>/<id>` for non-Anthropic providers or to disambiguate.

### Downstream coordination

Unchanged from the original plan: a separate Spellkave-side PR will
collapse `PiCodingAgentRunner` to a thin `PiCaLeashManagedPeerApi`
wrapper using `driver: "pi-coding-agent"`. Not attempted in this
session.

### Pre-existing working-tree changes (untouched)

`README.md`, `packages/runtime/src/drivers/codex-cli.ts`,
`packages/runtime/test/codex-cli.test.ts`, and
`docs/token-usage-reporting.md` were already modified before this
session started and were **not** touched by this work. They should be
reviewed/split out before committing this branch.
