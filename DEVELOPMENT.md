# Development

This repository is a local runtime-first MVP. Keep development workflows honest:

- automated smoke covers the runtime-backed tool surface only
- manual smoke covers slash commands, dashboard, widget, and operator UX
- failing smoke runs are debug artifacts, not release notes

## Prerequisites

You need:

- a real `pi` installation
- working auth/provider setup for whichever runtime driver you use
- `npm install`

## Main commands

### Default driver

```bash
npm test
npm run build
npm run smoke:dev
npm run smoke:last
npm run smoke:manual
npm run smoke:clean
```

### Codex driver

```bash
npm run smoke:dev:codex
npm run smoke:manual:codex
```

### Lower-level commands

```bash
npm run smoke:pi:auto
npm run smoke:pi:auto:codex
npm run smoke:pi
npm run smoke:pi:codex
```

## Recommended loops

### Normal development loop

```bash
npm run smoke:dev
npm run smoke:last
```

Use this after meaningful runtime/tool changes.

### Manual slash-command follow-up

```bash
npm run smoke:manual
```

Use this when you changed:

- `/peer` command behavior
- dashboard/widget rendering
- attention UX
- startup/operator guidance
- anything where live interactive feel matters

### Codex-specific loop

```bash
npm run smoke:dev:codex
npm run smoke:manual:codex
```

Use this when changing driver threading or Codex-specific behavior.

## What the automated smoke actually tests

`npm run smoke:pi:auto` starts `pi` in JSON mode from this checkout with:

- `--no-extensions -e <repo-root>`
- no builtin tools
- no context files, skills, prompts, or themes

The prompt is fixed and runtime-only. It exercises:

- `peer_start`
- `peer_list`
- `peer_ask`
- `peer_history`
- `peer_stop`
- `subagent_run`
- `subagent_list`
- `subagent_status`
- `team_spawn`
- `team_list`
- `team_task`
- `team_message`
- `team_stop`

It does **not** try to validate:

- dashboard or widget rendering
- slash-command UX quality
- manual operator ergonomics
- broader TUI behavior

## Automated smoke artifacts

Each automated run writes artifacts under:

```text
.pi-ca-leash/smoke/auto/<timestamp-id>/
  prompt.md
  report.md
  events.jsonl
  stderr.log
```

And also refreshes:

```text
.pi-ca-leash/smoke/auto/latest.md
```

### How to read them

- `report.md` — human summary and pass/fail result
- `events.jsonl` — exact event timeline from pi JSON mode
- `stderr.log` — runtime/host stderr
- `prompt.md` — exact prompt used for that run

## Debugging with smoke artifacts

When `smoke:dev` or `smoke:pi:auto` fails:

1. read `npm run smoke:last`
2. inspect the matching run directory
3. check which tool step failed
4. inspect `events.jsonl` for sequencing or tool-result details
5. inspect `stderr.log` for host/runtime issues
6. fix the bug
7. rerun the smoke
8. add or adjust a focused test when the bug deserves permanent coverage

Good use of saved runs:

- keep interesting failing runs while debugging
- compare runs before/after behavior changes
- keep maybe one passing run during a release pass

Bad use:

- committing raw smoke artifacts
- treating broad smoke logs as a replacement for tests

## Cleanup

Remove saved automated smoke artifacts with:

```bash
npm run smoke:clean
```

The whole `.pi-ca-leash/` tree is already git-ignored.

## Manual smoke checklist

Use this before claiming the repo is ready to share:

1. `npm test`
2. `npm run build`
3. `npm run smoke:dev`
4. `npm run smoke:manual`
5. in pi, run `/peer`, `/peer start`, `/peer ask`, `/peer list`, `/peer stop`
6. run `/peer dashboard advanced`
7. confirm retained backend diagnostics are believable
8. when explicitly testing installed-package behavior rather than local `-e` loading, restart pi and confirm persisted peers/backends restore honestly

## Notes on persistence during development

Repository-local runtime state lives under:

```text
.pi-ca-leash/
  runtime/
  bridge/
  subagents/
  teams/
  extension/
  smoke/
```

Delete or move `.pi-ca-leash/` when you need a truly clean local state.
