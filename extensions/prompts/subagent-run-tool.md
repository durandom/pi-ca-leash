Run a delegated subagent task through the local backend. Supports driver, model, cwd, and optional async execution.
- Use `subagent_run` when you need a bounded delegated run instead of a reusable peer.
- Pass `driver` to force `claude-sdk`, `claude-cli`, or `codex-cli` for this run instead of using the extension default.
- Call `runtime_models` first when you need the supported model ids for a driver.
- Pass `async: true` when you want to launch a background run and inspect it later with `subagent_status` or `subagent_list`.
- Keep delegated tasks bounded. If the tool reports a prompt size warning, split the run into smaller slices.
