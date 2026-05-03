# AGENTS.md

Agent guidance for working in `pi-ca-leash`.

## Mission

Keep this repo honest.

This project is a **runtime-first package** for Claude Code and Codex CLI integration with pi. Do not rewrite it into a fake stateless provider integration and do not pretend upstream product integrations exist when they do not.

## Current scope

In scope:
- `packages/runtime` — Claude Code runtime abstraction
- `packages/intercom-bridge` — named peer bridge and optional live intercom transport
- `packages/subagents-backend` — local subagent backend package
- `packages/teams-backend` — local persistent teammate backend package
- `extensions/index.ts` — pi extension wiring, dashboard, transport monitoring, attention UX

Out of scope unless explicitly requested and proven possible:
- fake `pi-teams` integration
- claims of real upstream `pi-subagents` integration
- fake Claude fork/session-tree semantics
- broad architecture rewrites without tests

## Non-negotiable truths

- Claude Code is treated here as a **long-lived runtime**, not a normal stateless model provider.
- `runner=claude-code-agent` does **not** support real `fork`.
- Teams backend is **local-only** in this repo.
- Intercom broker transport is optional; local runtime-backed peers still work without it.
- If something is environment-dependent, say so plainly.

## Working style

- Prefer small, maintainable changes.
- Add or update tests before behavior changes when practical.
- Keep docs synchronized with reality.
- Remove stale docs instead of letting multiple contradictory docs survive.
- Do not add dependencies for imaginary integrations.

## Good commands

```bash
npm test
npm run build
npm run smoke -- "Reply with exactly: smoke-ok"
npm run demo:intercom -- "You are demo worker. Reply briefly."
npm run demo:subagent -- "Reply with exactly: subagent-ok"
npm run demo:teams -- "You are persistent teammate. Reply briefly."
```

## Files worth reading first

- `README.md`
- `ARCHITECTURE.md`
- `KNOWN_LIMITS.md`
- `CHANGELOG.md`

## Documentation policy

Keep documentation in English.

If you change behavior, update whichever of these are affected:
- `README.md` — public repo entrypoint
- `ARCHITECTURE.md` — how pieces fit together
- `KNOWN_LIMITS.md` — honest constraints
- `CHANGELOG.md` — notable user-visible changes

## Shareability standard

Before claiming the repo is ready to share:
- `npm test` must pass
- `npm run build` must pass
- README must match reality
- known limits must still be true
- no stale plan/session docs should remain
