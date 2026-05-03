Start a long-lived runtime-backed peer for delegated work. Returns peer name, state, session id, driver, model, cwd, and latest visible peer reply when available.
- Use `peer_start` when you want a reusable long-lived peer instead of solving the task in the current turn.
- Pass `name` only when you need a stable explicit peer name; otherwise let the tool auto-name from prompt.
- Pass `driver` when you need to force `claude-sdk` or `codex-cli` for this peer instead of using the extension default.
- Call `runtime_models` first when you need the supported model ids for a driver.
- Pass `model` and `cwd` when you need a specific model and working directory.
