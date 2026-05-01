# Phase 2 — Codex CLI runtime slice

- **Date:** 2026-05-01
- **Parent plan:** `CODEX_CLI_RUNTIME_REFACTOR_PLAN.md` (Phase 2 / "Second implementation slice")
- **Worker target:** Sonnet 4.6
- **Status:** Plan only. No code in this file.

## Goal

Add a `CodexCliDriver` to the runtime package as a new optional driver that conforms to the existing `RuntimeDriver` contract (`packages/runtime/src/types.ts:224-230`) and emits `NormalizedDriverMessage` payloads (`packages/runtime/src/drivers/messages.ts`). Runtime core, bridge, extension, docs, subagents, and teams are untouched.

The slice is done when:

1. `npm test --workspace @pi-claude-code-agent/runtime` is green without Codex installed.
2. New `codex-cli` driver can be registered via `new ClaudeCodeRuntime({ drivers: { "codex-cli": new CodexCliDriver() } })` and selected with `start({ driver: "codex-cli" })`.
3. Runtime emits the same public `RuntimeEvent` shapes for Codex as for Claude (proven by reusing existing runtime-level integration test patterns with a mocked subprocess).

## Files in scope

Strict allow-list. No other files may be edited.

| File | Action |
|---|---|
| `packages/runtime/src/drivers/codex-cli.ts` | **new** — `CodexCliDriver` implementation |
| `packages/runtime/src/drivers/index.ts` | **new or update** — re-export `CodexCliDriver` only if file exists; otherwise create with both driver re-exports |
| `packages/runtime/src/index.ts` | export `CodexCliDriver` and `parseCodexCliEvent` |
| `packages/runtime/test/codex-cli.test.ts` | **new** — unit tests for parser + command builder |

Out of scope, must not be touched in this slice:

- `packages/runtime/src/types.ts` (already widened in Phase 0)
- `packages/runtime/src/runtime.ts` (already provider-agnostic)
- `packages/runtime/src/drivers/claude-sdk.ts`
- `packages/runtime/src/drivers/messages.ts`
- anything under `packages/intercom-bridge/`
- anything under `packages/subagents-backend/` or `packages/teams-backend/`
- anything under `extensions/`
- `README.md`, `ARCHITECTURE.md`, `KNOWN_LIMITS.md`, `CHANGELOG.md`, `MANUAL_TEST_PLAN.md`

## Driver behavior contract

Spawn `codex` via `node:child_process.spawn`. Do not use a shell.

### Command construction

- Fresh run: `codex exec <prompt> --json --full-auto -C <cwd>`
- Resume: `codex exec resume <resumeSessionId> <prompt> --json --full-auto -C <cwd>`
- `model` → append `-m <model>` when present.
- `cwd` is required; default to `input.cwd`.
- `appendSystemPrompt` → prepend `<system>\n${appendSystemPrompt}\n</system>\n\n` to the prompt argument. Do **not** pass any Claude-style preset.
- `env` → merge into spawned process env.

Executable path resolution:

1. If `process.env.CODEX_CLI_EXECUTABLE` set → use that.
2. Otherwise → `"codex"` (rely on PATH).

### Stdout / stderr handling

- Stdout is JSONL. Split on `\n`, trim, skip empty.
- Each line → `JSON.parse`. On parse failure: keep the raw line in a bounded ring buffer (max 50 lines) for crash diagnostics; do not emit a runtime error per malformed line.
- Stderr is collected into a bounded buffer (max 8 KB, tail-only) and surfaced only if the process exits non-zero and no structured error was already emitted.

### Event mapping

Map Codex JSONL events into `NormalizedDriverMessage` envelopes via `onEvent({ type: "message", payload })`:

| Codex event | Normalized message |
|---|---|
| `thread.started` (has `thread_id` or `session_id`) | `system` with `subtype: "init"`, `sessionId` from event |
| `item.started` where `item.type === "command_execution"` | `tool_use` with `toolName: "command_execution"`, `toolUseId` from item id, `input` = command/cwd payload |
| `item.completed` where `item.type === "command_execution"` | `tool_result` with same `toolUseId`, `output` = stdout/exit_code payload, `isError` true if exit_code != 0 |
| `item.completed` where `item.type === "agent_message"` (or `assistant_message`) | `assistant` with one text block from `text` field |
| `turn.completed` | `result` with `ok: true`, `summary` from final agent text or `""`, `usage` mapped from `usage` if present |
| `error` / `*.failed` event | emit `error` envelope (not `message`) with `message`, optional `code` |

Anything unknown → preserve as no-op (do not throw, do not emit).

### Process lifecycle

- `kill(signal = "SIGINT")` → call `child.kill(signal)`. Mark internal `aborted = true`.
- `done` resolves to `{ code, signal }` when the child exits.
- If `aborted && code !== 0` → still resolve normally; runtime layer translates signal into `interrupted` state.
- On non-zero exit without prior `error` envelope → emit one `error` envelope with stderr tail before resolving.

## Unsupported options policy

Reject hard at `run()` time. Throw a `RangeError` with a clear message before spawning if any of these are set:

- `tools` (non-empty array) → `"codex-cli driver does not support allowedTools"`
- `additionalDirectories` (non-empty array) → `"codex-cli driver does not support additionalDirectories"`
- `permissionMode` of `"plan"` or `"dontAsk"` → `"codex-cli driver does not support permissionMode=<value>"`

Accepted permissionModes: `"acceptEdits" | "auto" | "bypassPermissions" | "default"`. They are accepted but currently **not mapped** to Codex sandbox flags in this slice — document this limitation in a one-line code comment only (the `--full-auto` flag is always passed). Do not silently map to fake parity.

`appendSystemPrompt` is supported via prompt prepending only. `model` is supported via `-m`. `env`, `cwd`, `resumeSessionId` are supported.

## Tests to add

File: `packages/runtime/test/codex-cli.test.ts`

Use `node:test` and `node:assert/strict`. Do not require a real `codex` binary. Test the parser as a pure function and the command builder as a pure function. Export them from `codex-cli.ts` (e.g. `parseCodexCliEvent`, `buildCodexCliCommand`) for testability.

Required test cases (one `test(...)` per bullet):

1. `buildCodexCliCommand` — fresh run produces `["exec", "<prompt>", "--json", "--full-auto", "-C", "<cwd>"]`.
2. `buildCodexCliCommand` — resume run produces `["exec", "resume", "<sid>", "<prompt>", "--json", "--full-auto", "-C", "<cwd>"]`.
3. `buildCodexCliCommand` — model adds `-m <model>`; appendSystemPrompt prepends `<system>...</system>` to the prompt argument.
4. `parseCodexCliEvent` — `thread.started` → `system` init with `sessionId`.
5. `parseCodexCliEvent` — `item.started` of type `command_execution` → `tool_use` with `toolName: "command_execution"` and `toolUseId` set.
6. `parseCodexCliEvent` — `item.completed` of type `command_execution` with non-zero exit → `tool_result` with `isError: true`.
7. `parseCodexCliEvent` — `item.completed` of type `agent_message` → `assistant` with text block.
8. `parseCodexCliEvent` — `turn.completed` → `result` with `ok: true` and usage mapped when present.
9. `parseCodexCliEvent` — `error` event → `null` from parser; driver wraps it as `error` envelope (test the wrapping helper directly if exposed, otherwise cover via integration test below).
10. `parseCodexCliEvent` — unknown event type returns `null` and does not throw.
11. **Integration via fake subprocess factory:** the driver accepts an optional `spawn` injection. Feed it a fake child that emits a scripted JSONL stream + exit code 0. Run it through `ClaudeCodeRuntime` registered as `"codex-cli"` and assert:
    - `status.driver === "codex-cli"`
    - `status.driverSessionId` equals the `thread_id` from `thread.started`
    - transcript contains at least one `message` (assistant) and one `result` event
    - state reaches `idle`
12. **Unsupported options reject:** calling `driver.run({ tools: ["Bash"], ... }, …)` throws `RangeError` synchronously and never invokes `spawn`.
13. **Non-zero exit surfaces error:** fake child exits with code 1 and stderr `"boom"`; driver emits one `error` envelope whose message contains `"boom"`; `done` resolves to `{ code: 1, signal: null }`.

The driver constructor signature should accept an options bag like `new CodexCliDriver({ spawn?: typeof spawn, executable?: string })` to make tests injectable. Default behavior unchanged when no options are passed.

## Manual commands

Run from repo root.

```bash
npm install
npm run build --workspace @pi-claude-code-agent/runtime
npm test --workspace @pi-claude-code-agent/runtime
```

Optional, only if `codex` is installed locally and the developer wants a smoke check (not part of CI, not required for slice acceptance):

```bash
codex exec --json --skip-git-repo-check --sandbox read-only "Reply with exactly: codex-ok"
```

Bridge tests should still pass with no changes:

```bash
npm test --workspace @pi-claude-code-agent/intercom-bridge
```

If either test command fails, slice is not done.

## Non-goals

Explicit. Do not do any of these in this slice:

1. No changes to `packages/intercom-bridge/**`.
2. No changes to `extensions/**` — no peer command, no dashboard label, no config plumbing.
3. No documentation edits — `README.md`, `ARCHITECTURE.md`, `KNOWN_LIMITS.md`, `CHANGELOG.md`, `MANUAL_TEST_PLAN.md` stay untouched.
4. No subagents or teams backend changes.
5. No real Codex subprocess invocation in automated tests — always use injected fake spawn.
6. No new public runtime event types or new fields on `RuntimeStatus`.
7. No rename of `/claude-peer-*` commands.
8. No environment-variable-based default-driver selection.
9. No interrupt-semantics work beyond `child.kill("SIGINT")` — runtime already maps that to `interrupted`.

## Abort conditions

Stop the slice and report back if any of these occur — do not improvise:

1. The existing runtime tests start failing as a side effect of the new driver file (they should be untouched).
2. Implementing the parser requires adding new variants to `NormalizedDriverMessage` in `messages.ts`. (If true, the contract change belongs in a separate slice.)
3. The `RuntimeDriver` interface in `types.ts` cannot represent Codex behavior without modification.
4. Codex JSONL event names observed in practice differ from the mapping table above and the difference cannot be handled with defensive parsing. Document the observed shape and stop.
5. Bridge tests (`npm test --workspace @pi-claude-code-agent/intercom-bridge`) start failing — they must remain green; this slice should be invisible to them.
6. Worker is tempted to add Codex exposure in `extensions/index.ts`, the bridge, or docs to "make it usable". That is Phase 3+, not this slice.

## Reporting

On completion the worker reports:

- list of files created/modified (must match the allow-list)
- output of `npm test --workspace @pi-claude-code-agent/runtime`
- output of `npm test --workspace @pi-claude-code-agent/intercom-bridge`
- explicit confirmation that no file outside the allow-list was changed
- any deviation from the event mapping table above, with rationale
