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

4. **Codex support is partial and still not parity-complete.**
   - Runtime has an experimental `codex-cli` driver.
   - Bridge peers can carry driver identity, including `driver: "codex-cli"`.
   - Extension startup can select Codex as the default driver for new peers via `PI_CLAUDE_RUNTIME_DRIVER=codex-cli`.
   - Per-peer driver override exists on the LLM-callable `peer_start` tool.
   - Public `/peer start` slash-command docs can thread driver and model selection, but treat Codex selection as experimental.
   - Subagents and teams backend APIs, demo CLIs, and LLM-callable tools can thread driver selection, but public slash-command UX still does not expose subagent/team driver selection.
   - The bundled model catalog is advisory and generated from Lanista snapshots; it does not prove that the local CLI or account can use every listed model.
   - Workspace tests do not require a real `codex` binary, but local smoke validation can use a real one.
   - Context-window percentage is currently Claude SDK-derived only; Codex-backed peers show no `ctx` value unless a trustworthy context window can be derived later.
   - Codex effective default model can be shown from the bundled catalog, but the runtime still trusts the Codex CLI for actual model resolution.

## Runtime/host limits

5. **Full extension-host smoke coverage is still environment-dependent.**
   - Workspace/package tests pass.
   - Extension helper/state logic is tested directly.
   - Real pi-host loading still depends on an actual pi installation and host runtime.

6. **Live intercom broker transport is optional.**
   - If the broker is unreachable, local runtime-backed peers still work.
   - Live presence/messaging through the broker is unavailable until reconnect.
   - The extension now waits until `/peer init`, another actionable `/peer` command, or an LLM-callable runtime tool before starting background broker checks.

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

11. **Peer auto-naming is heuristic.**
    - Default `/peer start <prompt>` derives a short readable name from prompt text.
    - Use `/peer start <name> | <prompt>` when you need an exact stable name.

12. **Peer working directory is fixed at start time.**
    - Peer tools can choose `cwd` when starting a peer.
    - Changing `cwd` later requires starting a new peer session.

13. **Default peer UX is intentionally compressed.**
    - The main window does not stream live peer transcript output.
    - Peer completion is relayed back as one wrapped follow-up turn instead of live transcript spam.
    - Detailed retained backend diagnostics live in `/peer dashboard advanced`.
    - Legacy `/claude-*` slash commands stay hidden unless you start pi with `PI_CA_LEASH_ENABLE_LEGACY_COMMANDS=1`.
    - Old internal diagnostic slash commands also require `PI_CLAUDE_ENABLE_ADVANCED_COMMANDS=1`.

## Documentation limits

14. **This repo should be documented as it actually works today, not as a future product fantasy.**
    - If the implementation grows, docs must stay equally honest.
    - Remove stale claims rather than letting optimistic historical docs linger.
