# Release Notes

## Unreleased

### `securityMode` — simpler, honest sandbox surface

We collapsed the old five-value `permissionMode` field into two coarse modes that map onto each driver's *native* sandbox/approval flag. pi-ca-leash does **not** layer additional tool filtering on top — what each mode actually buys you depends entirely on the driver. The table below is the contract.

```ts
await bridge.launchPeer({ name: "worker", prompt: "…", securityMode: "safe" }); // default
await bridge.launchPeer({ name: "worker", prompt: "…", securityMode: "yolo" });
```

| Driver           | `safe`                                                              | `yolo`                                                              |
|------------------|---------------------------------------------------------------------|---------------------------------------------------------------------|
| `claude-sdk`     | `permissionMode: "default"` — Anthropic SDK prompts for approvals.  | `permissionMode: "bypassPermissions"` — no prompts.                 |
| `claude-cli`     | `--permission-mode default`. ⚠️ Non-interactive stdin: any tool that asks for approval will hang. Opt in deliberately. | `--permission-mode bypassPermissions` — no prompts.                 |
| `codex-cli`      | `--full-auto` — workspace-write sandbox: cwd is writable, the rest of the FS is read-only. | `--dangerously-bypass-approvals-and-sandbox` — no sandbox, no approvals. Required for callers that write outside cwd (e.g. `git commit` in a linked worktree). |
| `pi-coding-agent`| **Not enforced.** Field is echoed on the init event with `securityModeEnforced: false`. Use the `tools` allowlist instead. | Same — not enforced.                                                |

What this means in practice:

- ✅ `codex-cli safe` is the only mode that gives you a real FS sandbox out of the box.
- ✅ `claude-sdk safe` and `claude-cli safe` give you permission prompts (claude-cli will hang on them — see above).
- ❌ `safe` is **not** a tool filter. We do not block read-vs-write, network, or specific tools based on the mode.
- ❌ `pi-coding-agent` has no sandbox. Treat its runs like local shell sessions and constrain them via `tools`.

The default is `safe`. Callers that previously relied on the implicit `bypassPermissions` behavior (or the short-lived `feat/per-call-thinking-level` branch that briefly always-bypassed codex) must now opt in to `yolo`.

#### Migrating from `permissionMode`

`permissionMode` is deprecated but still accepted. Mapping:

- `bypassPermissions` → `yolo`
- `default` / `acceptEdits` / `auto` → `safe`
- `plan` / `dontAsk` → no longer supported (throws). Use `safe` or `yolo`.

End-to-end verification of these guarantees ships as `npm run smoke:security` (skips drivers whose CLI is not on PATH).

---

This release adds a second Claude-backed runtime path while keeping the existing Agent SDK path intact.

### Claude CLI runtime

- Added `claude-cli`, an optional runtime driver that runs local Claude Code through `claude -p --output-format stream-json`.
- Follow-up peer messages resume the same Claude Code session with `--resume <session-id>`.
- `claude-cli` shares the existing Anthropic model catalog and alias handling used by `claude-sdk`.
- `claude-sdk` remains available and stays the built-in default.

Use it per peer:

```text
/peer start reviewer | Review this repo briefly. | claude-cli
```

Or as the default for new peers:

```bash
PI_CLAUDE_RUNTIME_DRIVER=claude-cli pi
```

### Configuration

Driver defaults and executable overrides can now come from config files as well as environment variables and method/tool parameters.

Precedence:

1. explicit method, tool, or command driver
2. `PI_CLAUDE_RUNTIME_DRIVER`
3. config file `defaultDriver`
4. built-in default `claude-sdk`

Config files are merged in this order:

1. `$XDG_CONFIG_HOME/pi-ca-leash/config.json` or `~/.config/pi-ca-leash/config.json`
2. `.pi-ca-leash/config.json` in the repository
3. `PI_CA_LEASH_CONFIG`

Example:

```json
{
  "defaultDriver": "claude-cli",
  "drivers": {
    "claude-cli": {
      "executable": "/opt/homebrew/bin/claude",
      "permissionMode": "bypassPermissions"
    },
    "codex-cli": {
      "executable": "/opt/homebrew/bin/codex"
    }
  }
}
```

### Codex CLI permissions

- `codex-cli` now maps `permissionMode: "bypassPermissions"` to Codex's unsandboxed automation flag for fresh and resumed peer runs.
- Other accepted Codex permission modes keep the existing `--full-auto` behavior.

### Auth Caveat

The top-level README warning now distinguishes the two Claude-backed paths:

- `claude-sdk` sends messages through `@anthropic-ai/claude-agent-sdk`.
- `claude-cli` avoids importing that SDK package and shells out to `claude -p`.
- Both are still non-interactive Claude Code message-sending paths, so users must understand their authentication mode and applicable Anthropic terms before using them.
