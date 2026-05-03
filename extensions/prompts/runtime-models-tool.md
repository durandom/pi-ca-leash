Inspect available model ids for claude-sdk and codex-cli before passing a model override to peer_start, peer_ask, subagent_run, or team_spawn.
- Use `runtime_models` before choosing a non-default model.
- Use `driver` to narrow results to `claude-sdk` or `codex-cli`.
- Catalog entries are advisory; provider and CLI entitlements can drift, so unknown model ids are passed through to the runtime.
