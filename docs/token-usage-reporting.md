# Token Usage Reporting

This document records how token usage moves through `pi-ca-leash`.

The important rule is:

> Runtime usage values are per result event. They are not session totals unless an upstream runtime explicitly reports them that way.

`pi-ca-leash` currently forwards normalized usage from runtime drivers and does not maintain a public cumulative token counter.

This matters for SDK users as much as for the pi extension: the exported packages expose event collections, not precomputed billing or session totals.

## Terms

- **Turn usage**: usage attached to one runtime result event, such as one Claude SDK `result` message or one Codex CLI `turn.completed` event.
- **Session sum**: a caller-computed total across multiple result events in one runtime session or peer lifetime.
- **Latest usage**: the usage from the newest result event in a transcript or event chunk.

## Adapter Matrix

| Runtime adapter | Upstream event | Normalized event | Reported semantics in this repo | Summed by adapter |
| --- | --- | --- | --- | --- |
| `claude-sdk` | Claude SDK `result` / `ResultMessage` | one runtime `result` event | usage object from that SDK result message; cost/context metadata is copied or derived for that same result | No |
| `claude-cli` | `claude -p --output-format stream-json` result lines parsed through the Claude SDK parser | one runtime `result` event per parsed result message | same normalization as `claude-sdk`, because the CLI stream is parsed through `parseClaudeSdkMessage()` | No |
| `codex-cli` | Codex CLI `turn.completed` JSONL event | one runtime `result` event | usage object from that single `turn.completed` event | No |

For `codex-cli`, `parseCodexCliEvent()` maps only the current `turn.completed` event's `usage` object:

- `input_tokens` -> `inputTokens`
- `output_tokens` -> `outputTokens`
- `cache_creation_input_tokens` -> `cacheCreationInputTokens`
- `cache_read_input_tokens` or `cached_input_tokens` -> `cacheReadInputTokens`
- `reasoning_output_tokens` -> `reasoningOutputTokens`

If Codex CLI includes hidden or cached context in those numbers, `pi-ca-leash` preserves that upstream value. It does not try to infer a smaller visible-transcript count.

## Runtime Layer

`packages/runtime` stores usage only on `RuntimeEvent` objects with `type: "result"`.

| API | Usage behavior |
| --- | --- |
| `runtime.events(sessionId, cursor?)` | returns persisted runtime events; each `result` event keeps its own `usage` |
| `runtime.readTranscript(sessionId, cursor?, limit?)` | same event stream, usually consumed for history display |
| `runtime.status(sessionId)` | no usage field; status does not accumulate tokens |
| `runtime.start()` / `runtime.send()` | create new driver runs; result usage is emitted when the driver reports a result |

Runtime does not merge or sum usage across:

- multiple driver events
- multiple `send()` calls
- resumed sessions
- persisted transcript history
- old events replayed through `events()` or `readTranscript()`

If multiple result events arrive in one subprocess stream, runtime emits multiple result events. It does not use "last event wins" internally and does not silently sum them.

## Backend Matrix

| Layer/backend | Where usage appears | Turn vs sum behavior |
| --- | --- | --- |
| Runtime | `RuntimeEvent.type === "result"` | per result event only |
| Intercom bridge peers | `AskResult.events` contains only events after the send cursor; peer history contains full runtime events | no sum; reply extraction ignores usage |
| Subagents backend | `RunResult.events` persists full runtime events for the run | no sum; result summary is extracted from assistant/result text |
| Teams backend | uses intercom bridge ask/send results | no sum; teammate replies are text-level |
| Extension peer dashboard | `buildPeerActivityRow()` reads the latest result usage from the event window it is given | latest visible/windowed usage only, not a session sum |
| Peer history UI | displays runtime transcript events | no token aggregation |

## SDK Surfaces

SDK consumers should choose the lowest layer that matches their workflow.

### `@pi-claude-code-agent/runtime`

Use this package when you need exact runtime events and want to define your own accounting window.

Relevant exports:

- `ClaudeCodeRuntime`
- `RuntimeEvent`
- `ResultEvent`
- `RuntimeUsage`
- `TranscriptChunk`
- `parseClaudeSdkMessage()`
- `parseCodexCliEvent()`

Usage lives only on `ResultEvent.usage`. To compute totals, sum over the result events you intentionally selected:

```ts
import type { ResultEvent, RuntimeEvent, RuntimeUsage } from "@pi-claude-code-agent/runtime";

function resultEvents(events: RuntimeEvent[]): ResultEvent[] {
  return events.filter((event): event is ResultEvent => event.type === "result");
}

function sumUsage(events: RuntimeEvent[]): RuntimeUsage {
  return resultEvents(events).reduce<RuntimeUsage>((sum, event) => ({
    inputTokens: (sum.inputTokens ?? 0) + (event.usage?.inputTokens ?? 0),
    cacheCreationInputTokens: (sum.cacheCreationInputTokens ?? 0) + (event.usage?.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens: (sum.cacheReadInputTokens ?? 0) + (event.usage?.cacheReadInputTokens ?? 0),
    outputTokens: (sum.outputTokens ?? 0) + (event.usage?.outputTokens ?? 0),
    reasoningOutputTokens: (sum.reasoningOutputTokens ?? 0) + (event.usage?.reasoningOutputTokens ?? 0),
    totalCostUsd: (sum.totalCostUsd ?? 0) + (event.usage?.totalCostUsd ?? 0),
  }), {});
}
```

This helper is deliberately caller-owned because different SDK users need different accounting windows.

### `@pi-claude-code-agent/intercom-bridge`

Use this package when you want named long-lived peers.

Relevant exports:

- `ClaudeRuntimeIntercomBridge`
- `AskResult`
- `BridgePeer`

`AskResult.events` is the event chunk after the message cursor used by that ask/send operation. It is suitable for "this message's reported result usage" if a result event exists in that chunk. It is not a peer lifetime total.

For peer lifetime totals, use the `BridgePeer.sessionId` with the runtime instance and call `runtime.events(peer.sessionId)` yourself, then sum the selected `result.usage` events.

### `@pi-claude-code-agent/subagents-backend`

Use this package when you want persisted bounded runs.

Relevant exports:

- `ClaudeCodeSubagentBackend`
- `RunResult`
- `SubagentRunRecord`
- `SubagentRunChunk`

`RunResult.events` stores the runtime events collected for that run. It is a sound place to compute a run total because it is scoped to one run record and preserves the underlying result events. The backend does not compute that total for you.

### `@pi-claude-code-agent/teams-backend`

Use this package when you want persistent teammate records.

Relevant exports:

- `ClaudeCodeTeamsBackend`
- `TeamMessageResult`
- `TeammateRecord`

`TeamMessageResult` contains text-level reply data and the teammate record. It does not expose token usage directly. To inspect or sum usage, read `teammate.sessionId`, use the underlying runtime event API, and sum the result events for the range you care about.

### Extension helpers

`extensions/peer-ux.ts` exports `buildPeerActivityRow()` inside the root extension package. It takes a caller-supplied event array and returns usage from the latest result event in that array. In the pi dashboard, the caller often passes a short tail window for display performance, so this is a status hint, not an accounting API.

## Public Interpretation

Consumers should interpret `inputTokens`, `cacheReadInputTokens`, `outputTokens`, and `reasoningOutputTokens` as values scoped to the result event they are attached to.

If a consumer needs a session total, it should explicitly sum selected `result.usage` events and label that value as cumulative. That summing should define its event range, for example:

- all result events in a runtime session
- result events after a cursor
- result events for one peer lifetime
- result events for one subagent run

Do not compare a summed session value to a single turn value without labeling the difference.

## Current Caveat

The repo does not know whether an upstream adapter reports "turn usage" as visible prompt tokens only, full active context, cached context, or another provider-specific accounting unit. `pi-ca-leash` preserves the upstream runtime's reported values and keeps the raw usage payload on `usage.raw` for inspection.

## Collection Soundness

The current collection model is sound for event-scoped reporting:

- drivers map one upstream result-like event to one runtime `result` event
- runtime persists result events independently and does not mutate older usage
- cursor-based reads return event ranges without recomputing usage
- resumed sends append new events instead of replaying old events into the new cursor chunk
- bridge ask/send uses a cursor taken before the message, so `AskResult.events` is scoped to the new delivery window
- subagent results persist the runtime events for the run, preserving the raw material needed for caller-owned totals

The current model is intentionally not a billing subsystem:

- there is no canonical session total on `RuntimeStatus`
- there is no cross-backend total on peers, subagents, or teams
- dashboard usage is a latest/windowed display value
- upstream adapters may report provider-specific accounting that includes cached or hidden context
