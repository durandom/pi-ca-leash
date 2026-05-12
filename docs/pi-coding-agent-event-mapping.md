# pi-coding-agent driver — event mapping

This note records how `PiCodingAgentDriver`
(`packages/runtime/src/drivers/pi-coding-agent.ts`) translates
`@earendil-works/pi-coding-agent`'s `AgentSessionEvent` stream into the
runtime's `NormalizedDriverMessage` shape. It exists so the next person
who touches the driver can re-derive the translation without rereading
both SDKs.

## Translation table

| `AgentSessionEvent.type`  | Normalized output            | Notes                                                                                  |
| ------------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| `tool_execution_start`    | `tool_use`                   | Live request, before `message_end` fires. `toolCallId` → `toolUseId`, `args` → `input`.|
| `message_end` (assistant) | `assistant` (single message) | `content[]` is flattened to blocks: `text`, `thinking`, `toolCall`→`tool_use`.         |
| `message_end` (toolResult)| `tool_result`                | `toolCallId` → `toolUseId`; `content` becomes both raw `output` and normalized blocks. |
| `turn_end`                | `result`                     | Per-turn usage from `message.usage`; `ok` derived from `stopReason ∉ {error, aborted}`.|
| `agent_start`             | —                            | Lifecycle, no runtime state change.                                                    |
| `agent_end`               | —                            | Covered by the preceding per-turn `result` events. Avoids double-counting usage.       |
| `turn_start`              | —                            | Lifecycle, no runtime state change.                                                    |
| `message_start`           | —                            | Deltas only — final shape is captured in `message_end`.                                |
| `message_update`          | —                            | Streaming deltas; the runtime transcript stores final messages.                        |
| `tool_execution_update`   | —                            | Partial tool results.                                                                  |
| `tool_execution_end`      | —                            | Already covered by `message_end` (toolResult).                                         |
| `queue_update`            | —                            | UI-only steering/follow-up state.                                                      |
| `compaction_*`, `auto_retry_*`, `session_info_changed`, `thinking_level_changed` | — | Session-only; no normalized analogue today. |

Lifecycle events are deliberately dropped — they would churn the
transcript without producing additional state.

## Usage shape mapping

pi-coding-agent's `AssistantMessage.usage` (from `@earendil-works/pi-ai`)
to `NormalizedDriverUsage`:

| Source field         | Normalized field            |
| -------------------- | --------------------------- |
| `input`              | `inputTokens`               |
| `output`             | `outputTokens`              |
| `cacheRead`          | `cacheReadInputTokens`      |
| `cacheWrite`         | `cacheCreationInputTokens`  |
| `cost.total`         | `totalCostUsd`              |
| (derived: input+cacheRead+cacheWrite) | `contextTokens` |

Each `turn_end` produces its own `result` event. The runtime does not
accumulate totals across calls (see `ARCHITECTURE.md` L41-43); consumers
sum per-`result` values client-side. The test
`integration — usage is reported per turn_end and accumulates across two runs`
exercises this contract.

## Lifecycle mapping

| Runtime concept     | pi-coding-agent call                            |
| ------------------- | ----------------------------------------------- |
| `driver.run(...)`   | `createAgentSession(...)` → `session.prompt(...)` |
| `handle.kill()`     | `session.abort()` (fire-and-forget)             |
| Session teardown    | `session.dispose()` (in `finally`)              |

The driver emits one synthetic `system` message with `subtype: "init"`
and `sessionId = session.sessionId` immediately after `createAgentSession`
resolves, so the runtime can record the driver session id the same way
it does for the other drivers.

## Session continuation

When `RuntimeDriverRunInput.resumeSessionId` is truthy the driver passes
`sessionManager: SessionManager.continueRecent(input.cwd)` to
`createAgentSession`. The SDK's `SessionManager` keys session files by
cwd-encoded path under `~/.pi/agent/sessions/`, and pi-ca-leash peers
hold a stable cwd per peer name, so `continueRecent(cwd)` reliably picks
the most recent prior session for that peer. `sessionStartEvent.reason`
flips to `"resume"` so the SDK extension surface sees the correct
lifecycle signal.

The runtime's `send(peerName, ...)` path already forwards the persisted
`driverSessionId` as `resumeSessionId`, so multi-turn conversation
history is preserved across `send()` calls without any caller-side
change. Consumers that want a fresh session launch a peer with a
distinct `cwd` (or wipe the session dir).

## Known limitations

- **Model resolution.** Bare model ids (e.g. `claude-opus-4-5`) are
  looked up via `ModelRegistry.getAll()`. Use `<provider>/<id>`
  (e.g. `anthropic/claude-opus-4-5`) for non-Anthropic providers or to
  disambiguate duplicates.
- **Optional peer dependency.** `@earendil-works/pi-coding-agent` is
  loaded via dynamic import; users that never select this driver do
  not need it installed.
