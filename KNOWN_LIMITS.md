# Known Limits

This file is intentionally blunt.

## Product/integration limits

1. **No real upstream `pi-subagents` integration is proven here.**
   - This repo contains local backend logic and extension wiring.
   - It should not be described as shipped upstream integration unless that is separately verified.

2. **No external `pi-teams` integration exists here.**
   - Teams backend is local to this repository.
   - Do not imply compatibility with a package/product that is not actually present.

3. **Claude fork semantics are not supported.**
   - `runner=claude-code-agent` rejects real `fork`.
   - Better an explicit error than a fake branch illusion.

4. **Codex support is partial and still extension-dark.**
   - Runtime has an experimental `codex-cli` driver.
   - Bridge peers can carry driver identity, including `driver: "codex-cli"`.
   - Default extension peer UX still does not expose Codex selection.
   - Subagents and teams remain effectively Claude-only in this repo.
   - Automated tests do not require a real `codex` binary.

## Runtime/host limits

5. **Full extension-host smoke coverage is still environment-dependent.**
   - Workspace/package tests pass.
   - Extension helper/state logic is tested directly.
   - Real pi-host loading still depends on an actual pi installation and host runtime.

6. **Live intercom broker transport is optional.**
   - If the broker is unreachable, local runtime-backed peers still work.
   - Live presence/messaging through the broker is unavailable until reconnect.

7. **Cross-process resurrection is partial, not magical.**
   - Persisted state survives.
   - In-flight control of an already-running host-local process does not fully survive arbitrary host loss.

## UX/coordination limits

8. **Attention ack/snooze is local extension state.**
   - It is persisted across pi restarts in this repo.
   - It is not a shared multi-host or cross-session control protocol.

9. **Teams workflow is intentionally simple.**
   - Task classification is heuristic (`DONE:` / `BLOCKED:` style replies).
   - There is no rich board UI, inbox app, or broader collaboration product layer.

10. **Busy handling is strict.**
   - A busy peer can reject concurrent inbound work instead of queueing it.
   - There is no sophisticated queueing/scheduling layer yet.

## Documentation limits

11. **This repo is documented as a local MVP, not a final product.**
    - If the implementation grows, docs must stay equally honest.
    - Remove stale claims rather than letting optimistic historical docs linger.
