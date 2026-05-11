Inspect available model ids for claude-sdk, claude-cli, and codex-cli before passing a model override to peer_start, peer_ask, subagent_run, or team_spawn.
- Use `runtime_models` before choosing a non-default model.
- Use `driver` to narrow results to `claude-sdk`, `claude-cli`, or `codex-cli`.
- Default output is a short recommended list with advisory use cases; pass `verbose: true` only when you need every bundled model id.
- The report includes supported shorthand aliases. For example, Claude aliases such as `sonnet`, `opus`, and `haiku` are resolved to concrete model ids before launch.
- Catalog entries are advisory; provider and CLI entitlements can drift, so unknown model ids are passed through to the runtime.
