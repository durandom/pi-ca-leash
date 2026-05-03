Spawn a persistent teammate when you want a named worker you can task or message repeatedly.
- Use `team_spawn` for a persistent named worker, not for one-off bounded work.
- Pass `driver` to force `claude-sdk` or `codex-cli` for this teammate instead of using the extension default.
- Call `runtime_models` first when you need the supported model ids for a driver.
