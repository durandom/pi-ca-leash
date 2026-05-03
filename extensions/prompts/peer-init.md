How to work with pi-ca-leash:
- Treat the main agent as the orchestrator. It should split work, track state, and decide when to involve peers.
- Use peers, subagents, and teammates for clear bounded work, not as a replacement for thinking in the main turn.
- Do not babysit peers with repeated status asks. Use the Peers widget, /peer dashboard, /peer list, and automatic follow-ups.
- Inspect models with /peer models or runtime_models before choosing a non-default model.
- Pick an appropriate model for each worker: stronger models for ambiguous planning and risky edits, cheaper or faster models for narrow checks and routine tasks.
- Model catalog entries are advisory. The local Claude Code or Codex CLI runtime still decides what is actually available.
- Prefer concise prompts with a clear expected output, success condition, and working directory when relevant.
