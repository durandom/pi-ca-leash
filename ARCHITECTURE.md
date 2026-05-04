# Architecture

## Overview

`pi-ca-leash` is built around one idea:

> Claude Code should be integrated as a **stateful runtime** first, then adapted into pi-style workflows.

That leads to a layered design.

```text
Claude SDK driver (default)    Codex CLI driver (experimental)
             ↓                          ↓
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
- start driver-backed sessions
- resume/send messages into existing sessions
- normalize runtime events
- persist session state and transcript
- expose status, listing, event streaming, interrupt, and stop

This package is the source of truth for runtime session lifecycle.

Current drivers:
- `claude-sdk` is the default and most complete path.
- `codex-cli` exists as an experimental runtime driver with a narrower supported option set.

Important consequence:
- higher layers should not reinvent runtime session persistence or control semantics

### 2. Intercom bridge layer

Path:
- `packages/intercom-bridge`

Responsibility:
- give runtime sessions stable peer names
- map `send` / `ask` / `reply` style messages into runtime sends
- wait for the next idle cycle to determine replies
- persist peer registry for restart restore
- reconcile persisted peer registry into live bridge state so externally created managed peers can be discovered without restart
- optionally bind peers to live `pi-intercom` transport when broker is reachable
- preserve per-peer runtime driver identity
- expose a supported managed-peer API for downstream orchestrators that want normal peer lifecycle + dashboard visibility

Important consequence:
- intercom transport is optional
- the bridge still works locally without live broker presence
- peers may now be runtime-backed by different drivers
- extension startup can choose the default peer driver via `PI_CLAUDE_RUNTIME_DRIVER`
- downstream extensions can use `PiCaLeashManagedPeerApi` from `@pi-claude-code-agent/intercom-bridge` instead of wrapping public `/peer` tools
- public peer examples stay driver-agnostic; experimental Codex selection is primarily via startup default or LLM-callable tools

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
- backend API can thread runtime driver selection into runs
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
- backend API can thread runtime driver selection into teammate spawn
- no external `pi-teams` integration is assumed here

### 5. Extension layer

Path:
- `extensions/index.ts`
- `extensions/model-catalog.ts`
- `extensions/prompts/`

Responsibility:
- wire runtime + bridge + backends into a pi extension
- expose operator commands
- render peer-first widget/dashboard surfaces
- stay lazy until `/peer init`, another actionable `/peer` command, or an LLM-callable runtime tool activates the workflow
- keep retained backend diagnostics behind explicit advanced views
- monitor live broker transport connectivity
- surface attention notifications
- persist local attention ack/snooze state
- expose a bundled, advisory model catalog for runtime model selection
- keep editable prompt/guidance text out of the main extension implementation

The extension is where operator UX lives.

Activation model:
- extension load registers slash commands, tools, and renderers only
- `session_start` does not create the widget, start the background monitor, or run live intercom checks while inactive
- `/peer init` activates the workflow, adds the one-time orchestration guide to the main agent context, and shows compact user help as a user-only UI notification
- the first actionable `/peer` command also activates the workflow and adds the agent guide once
- `/peer help` stays passive and shows user-only UI help
- after activation, the background monitor handles broker connectivity, attention notifications, peer relays, and visible dashboard refreshes

Context boundary:
- command acknowledgments, dashboards, model lists, history pages, and diagnostics are operator-facing UI notifications
- the main agent context receives only intentional agent-facing prompts, such as the one-time orchestration guide, and automated peer relays
- peer relays are wrapped follow-up turns containing the latest visible peer message so the orchestrator can decide whether to inspect more history
- dashboard refreshes re-reconcile the shared peer registry, so managed peers created by other extensions can appear in the live UX without restarting pi
- the normal dashboard stays compact by showing only a managed-owner badge, while the advanced dashboard can surface fuller managed-peer metadata

Prompt files:
- `extensions/prompts/peer-init.md` is the one-time main-agent orchestration guide added when peer mode is first activated
- `extensions/prompts/peer-init-user-help.md` is the compact user-facing command cheat sheet shown as a user-only UI notification with peer-mode activation
- `extensions/prompts/peer-no-babysitting.md` is included in peer start acknowledgments
- `extensions/prompts/*-tool.md` files provide LLM-callable tool snippets/guidelines
- `extensions/prompts/peer-bridge-system.md` is appended to runtime-backed peer sessions

### Model catalog layer

Path:
- `extensions/model-catalog.ts`

Responsibility:
- map runtime drivers to model-provider catalogs
- expose known model ids, labels, context windows, token limits, modality flags, and rough per-million-token costs
- expose a small deterministic alias map for common shorthand names, resolved before launching a runtime call
- expose a short advisory recommendation list for common use cases such as architecture, coding, quick checks, and cheap worker tasks
- provide advisory model-selection notes for `/peer`, `runtime_models`, and LLM-callable runtime tools

Current mapping:
- `claude-sdk` uses the Lanista `anthropic` catalog and passes models to the Claude SDK / Claude Code runtime.
- `codex-cli` uses the Lanista `openai-codex` catalog and passes models as `codex -m` / `codex --model` compatible ids.

Important consequence:
- the catalog is not an entitlement authority
- recommendation use cases are local product guidance, not upstream provider guarantees
- aliases only normalize shorthand into exact ids from the bundled catalog; they do not guarantee local provider access
- unknown model ids are passed through to the runtime instead of being hard-rejected
- actual availability can still differ by installed CLI version, account, region, and provider rollout state

## Updating the Model Catalog with Lanista

The bundled catalog is a static snapshot so `pi-ca-leash` does not need `lanista` at runtime.

To refresh it from Lanista:

```bash
cd /Users/mhild/src/durandom/b4arena/lanista
.venv/bin/lanista fetch
.venv/bin/lanista --json agents anthropic
.venv/bin/lanista --json agents codex
```

Then copy the relevant provider records into `extensions/model-catalog.ts`:
- Lanista `anthropic` -> `RUNTIME_MODEL_CATALOGS["claude-sdk"]`
- Lanista `openai-codex` -> `RUNTIME_MODEL_CATALOGS["codex-cli"]`

Keep these fields when updating entries:
- model id
- display name
- context window
- max output tokens
- reasoning flag
- input modalities
- input and output cost per million tokens

After updating the snapshot:

```bash
npm test
npm run build
```

Do not add a runtime dependency from this repo to Lanista unless the extension needs live model refresh. The default should stay deterministic and offline-friendly.

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
.pi-ca-leash/
```

Typical layout:

```text
.pi-ca-leash/
  runtime/      # runtime sessions and transcripts
  bridge/       # bridge peer registry
  subagents/    # subagent run artifacts
  teams/        # teammate and task records
  extension/    # extension-local state such as attention ledger
  log.md        # append-only local feedback log for extension smoothing
```

## Interaction model

### Named peer flow

```text
user command
  → extension
  → immediate acknowledgment in main window
  → intercom bridge
  → runtime session send
  → wait for idle cycle
  → reply extraction
  → peer-first dashboard/widget update
  → final command result
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
