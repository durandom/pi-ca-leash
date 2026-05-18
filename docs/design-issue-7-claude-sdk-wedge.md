# Design / decision: recover from external SIGKILL of claude-agent-sdk child (issue #7)

Status: **implemented (Option A)**.

## Problem

The `claude-sdk` driver runs the Claude Agent SDK **in-process**. The SDK
itself spawns the native `claude` binary as a subprocess, but pi-ca-leash
never owns that child handle. The driver awaits an async iterator
(`for await (const message of request)`,
`packages/runtime/src/drivers/claude-sdk.ts:285-292`) and signals completion
via `handle.done` (`runtime.ts:293`).

When a host externally `SIGKILL`s the native leaf process, the SDK's iterator
**never settles**:
- No Node-level `close` event fires (no Node child to close).
- `request.close()` / `request.interrupt()` are only invoked via the
  `AbortController`, which the runtime triggers on `kill("SIGINT")` — i.e.
  only on cooperative stop, never on opaque death.
- `handle.done` stays pending forever → `waitForRunCompletion` never reaches
  `idle` / `failed` / `stopped`.
- `RuntimeStatus.state` stays `running` → `IntercomBridge.mapRuntimeState`
  maps to `busy` → every subsequent `deliver` is rejected in ~30 ms.

CLI drivers (`claude-cli`, `codex-cli`) are immune: they own a real
`child_process` handle, so an external kill produces a Node `close` event
that settles `handle.done` naturally.

## Constraints

- **Layering**: the runtime should not import SDK internals. The driver may,
  but only through a stable surface.
- **No false positives**: a slow turn (long thinking, big tool output) must
  not be mistaken for a dead child. The detector needs a positive signal of
  *process death*, not just *iterator silence*.
- **Backwards compatible**: hosts that don't externally kill children must
  see no behavior change.
- **In-process driver should self-heal**: pushing all recovery onto the host
  is a footgun — the host had to know it killed the child *and* know to call
  a recovery API. One of those is fine; both is a layering smell.

## Options

### Option A — Driver-side liveness watchdog (issue's option 1)

Inside `ClaudeSdkDriver.run`, after `sdk.query(...)`, locate the SDK's
underlying child handle (currently exposed as `request.subprocess` or a
similar field on the query object — verify against the pinned SDK version).
Attach `child.once("exit", ...)` and `child.once("close", ...)` listeners.
If the iterator hasn't yielded a terminal message within N seconds of
`close`, treat the run as dead: abort the iterator
(`request.close()` / `request.interrupt()`), surface an `error` envelope
with code `CLAUDE_SDK_CHILD_DIED`, and resolve `done` with
`{ code: 137, signal: "SIGKILL" }` so `waitForRunCompletion` flows
through its existing `code && code !== 0` branch into `failed`.

**Pros**
- Host-transparent.
- Reuses the existing `failed` transition; no new state surface.
- Positive death signal (`child.close`) — won't fire on slow turns.

**Cons**
- Couples the driver to a non-public SDK shape. If the SDK rearranges
  `request.subprocess`, this silently regresses to the current bug. Mitigate
  with a feature probe at driver init: log a warning if the handle is
  missing, fall back to a coarse iterator-idle timeout (`60s`, configurable).
- N-second grace window introduces a small recovery latency. Acceptable;
  current behavior is *infinite* wedge.

### Option B — Host-facing `detachDeadChild(sessionId)` API (issue's option 2)

Add to `IntercomBridge`:

```ts
detachDeadChild(name: string, reason?: string): Promise<void>
```

Semantics: "the underlying child is gone, don't try to clean it up — just
reset state to `failed` and accept new messages." Implementation: call
`runtime.markFailed(sessionId, { code: "EXTERNAL_KILL", reason })`, which
patches state to `failed`, clears `activeRunId`, and emits a
`session.stopped` event. The in-flight `awaitRunCompletion` task remains
pending forever; we tolerate this leak because (a) the child really is gone
and (b) the iterator gets aborted via the AbortController during cleanup.

**Pros**
- No SDK internals.
- Small, explicit surface: hosts that need it use it, hosts that don't
  ignore it.

**Cons**
- Requires host cooperation. Castra (the reporter) is already moving to
  `stopPeer` instead of SIGKILL, so this is mostly a *bridge for other
  hosts* and a fallback for emergencies.
- Leaks the orphaned `awaitRunCompletion` promise — harmless but ugly.

### Option C — Both

Recommended. They aren't redundant:
- **A** handles the unknown unknowns (host doesn't realize the child died,
  or third-party tooling killed it).
- **B** handles the known case where the host *intentionally* terminated the
  child and wants a synchronous "ack, ready for next message" beat without
  waiting for A's grace window.

## Decision

**Option A only.** Option B was rejected: it would add a public
`IntercomBridge` method that is a no-op for 3 of 4 drivers (CLI drivers
already self-heal on external kill via their Node `child_process` close
event). Bloating the consumer API with an SDK-specific recovery hook puts
the layering smell on every host author.

A is shipped in `packages/runtime/src/drivers/claude-sdk.ts` via the
internal `attachChildDeathWatchdog` helper. If the SDK ever stops exposing
a reachable subprocess handle, the driver logs one warning at runtime and
the wedge can return — but the recovery path (B) lives in the host's
existing `stopPeer` already, so the worst case is "back to current
behavior," not "no escape hatch."

## Implementation sketch (Option A)

```ts
// claude-sdk.ts, inside run()
const request = sdk.query({ prompt: promptStream, options: this.buildOptions(input) });

const child = (request as any).subprocess as NodeJS.Process | undefined;
let childDied = false;
if (child && typeof (child as any).once === "function") {
  (child as any).once("close", (code: number | null, signal: NodeJS.Signals | null) => {
    childDied = true;
    // Give the iterator a brief grace window to drain any in-flight messages;
    // then abort if it's still spinning.
    setTimeout(() => {
      if (!controller.signal.aborted) controller.abort();
    }, CHILD_DEATH_GRACE_MS);
    void onEvent({
      type: "error",
      payload: {
        message: `claude-agent-sdk child exited unexpectedly (code=${code} signal=${signal})`,
        code: "CLAUDE_SDK_CHILD_DIED",
      },
    });
  });
} else {
  // Capability missing — log once, fall back to a coarse idle timeout
  // checked against the iterator's last-message timestamp.
}

// ...inside catch block, distinguish abort-from-child-death from SIGINT
if ((error as Error)?.name === "AbortError") {
  return childDied
    ? { code: 137, signal: "SIGKILL" as const }
    : { code: 130, signal: "SIGINT" as const };
}
```

Threading the `childDied` flag through to the return code lets
`waitForRunCompletion` route into `failed` (code 137) rather than
`interrupted` (signal SIGINT) — preserving the host-observable distinction
between *user asked to stop* and *child died on us*.

## Test plan

1. **Unit (fake SDK)**: stub `sdk.query` to return a query whose iterator
   never yields *and* whose `subprocess` emits `close` after 50 ms. Assert
   state transitions to `failed` within `CHILD_DEATH_GRACE_MS + slack`.
2. **Unit (capability missing)**: stub `sdk.query` to return a query with no
   `subprocess`. Assert the driver logs once and the coarse-idle fallback
   still recovers (use a low fallback timeout in test config).
3. **Regression**: existing `interrupt marks active run interrupted` test
   still routes through `signal: SIGINT` and lands in `interrupted`, not
   `failed`.
4. **Integration**: against a live SDK, `pkill -KILL` the leaf claude
   process mid-turn, assert state → `failed` within grace window, assert
   next `send()` succeeds.

## Open questions

- Default grace window. Suggest 5 s. Long enough to drain a chunky
  in-flight stream, short enough that a wedged host doesn't notice. Make it
  configurable via `RuntimeOptions.claudeSdkChildDeathGraceMs`.
- Should the SDK iterator-idle fallback (capability-missing path) be on by
  default, or opt-in? Recommend **on**, default 60 s, configurable. Worst
  case: a 60-s thinking turn gets killed. Better than wedging forever.
- Add a `child-died` reason on the existing `session.stopped`/`failed`
  event? Helps observability. Cheap.
