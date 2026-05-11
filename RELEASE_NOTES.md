# Release Notes

## Unreleased

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
