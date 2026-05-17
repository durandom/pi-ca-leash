# pi-ca-leash

> [!WARNING]
> **Claude Code auth caveat:** the default `claude-sdk` runtime path actively sends prompts and follow-up messages through `@anthropic-ai/claude-agent-sdk`, including resumed peer sessions. The optional `claude-cli` runtime path avoids that SDK package and shells out to `claude -p`, but it is still non-interactive Claude Code message sending. Anthropic's current Claude Code legal/authentication docs say OAuth subscription credentials are intended for ordinary Claude Code and native Anthropic app use, while developers building products or services with the Agent SDK should use API key authentication through Claude Console or a supported cloud provider. Do not use this extension to route Free, Pro, or Max subscription credentials on behalf of other users.
>
> Read-only/local features such as dashboard state, peer history browsing, local persistence, Git operations, and the experimental `codex-cli` runtime path are separate from Claude Agent SDK message sending.

Harness-aware Claude Code and Codex CLI extension for pi.

Claude Code and Codex CLI are more than model endpoints. They are coding harnesses with their own tool loops, session semantics, and increasingly harness-optimized models. `pi-ca-leash` treats them that way.

Pi stays in the brain seat — like a human coordinating multiple coding agents. It can start long-lived workers, hand them scoped tasks, wait for results, inspect what they did, and decide what happens next.

Claude is the default and most complete path today. `claude-cli` is available as an optional local CLI-backed Claude path. Codex works too, but is still experimental and not parity-complete.

## What it adds

After installation, pi gets:
- named long-lived peers with `/peer start`, `/peer ask`, `/peer send`, `/peer history`, and `/peer stop`
- a peer dashboard plus local attention state
- LLM-callable peer tools such as `peer_start`, `peer_ask`, `peer_send`, `peer_history`, and `runtime_models`
- a supported programmatic managed-peer API for downstream orchestrators via `@pi-claude-code-agent/intercom-bridge`
- optional local subagent-style runs and local persistent teammates behind advanced commands/tools
- optional live intercom transport when the broker is reachable

What this package does **not** claim:
- no real upstream `pi-subagents` integration
- no external `pi-teams` integration
- no real Claude fork/session-tree semantics
- no host-independent full pi extension smoke test

## Example session

Fictional but representative flow:

```text
You: /peer dashboard

You: Start a planner peer to understand the auth flow and propose the safest implementation plan.

You: Start an implementer peer too, but keep it waiting for my approved plan before editing anything.

Pi/main agent:
- uses peer tools to start both workers
- keeps control of the conversation
- receives planner output automatically when it is ready
- decides what plan to approve

Sample peer state:
- planner      idle      summarized auth flow and proposed scoped plan
- implementer  waiting   ready for approved implementation handoff

You: Send the approved plan to the implementer. Keep changes scoped. Report files changed, commands run, tests, and residual risk.

Pi/main agent:
- inspects the implementer result
- asks follow-up questions if needed
- gives the final answer to the user
```

That is core idea: pi is not replaced by child agents. Pi orchestrates them.

Once peer mode is active, you can often ask for this in natural language instead of manually driving every peer command.

## Install

Read the Claude Code auth caveat at the top of this README before using a Claude-backed runtime path.

Install from npm:

```bash
pi install npm:pi-ca-leash
```

Pin an explicit version when needed:

```bash
pi install npm:pi-ca-leash@0.16.0
```

Local checkout install:

Requirements for normal use:
- a working pi installation
- at least one configured runtime:
  - Claude Code configured for Claude-backed execution, or
  - `codex` on `PATH` for experimental Codex-backed runtime checks

Requirements for local development or source installs:
- Node.js 18 or newer
- npm

Try this checkout locally:

```bash
npm install
npm test
npm run build
pi install /absolute/path/to/pi-ca-leash
```

`npm install` runs the workspace build through `prepare`, so local development and git-based installs have package `dist/` files available.

Use another default runtime driver for newly started peers:

```bash
PI_CLAUDE_RUNTIME_DRIVER=claude-cli pi
PI_CLAUDE_RUNTIME_DRIVER=codex-cli pi
```

Persisted peers keep their recorded driver.

## Configuration

Driver choice can be set per call, by environment, or by config file. Precedence is:

1. explicit method/tool/command driver, such as `peer_start(..., driver: "claude-cli")` or `/peer start task | claude-cli`
2. `PI_CLAUDE_RUNTIME_DRIVER`
3. config file `defaultDriver`
4. built-in default `claude-sdk`

Config files are JSON and are merged in this order:

1. global XDG config: `$XDG_CONFIG_HOME/pi-ca-leash/config.json`, or `~/.config/pi-ca-leash/config.json`
2. repository-local config: `.pi-ca-leash/config.json`
3. explicit override path from `PI_CA_LEASH_CONFIG`

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

`claude-cli` runs local Claude Code in print mode (`claude -p --output-format stream-json`) and resumes follow-up peer messages with `--resume <session-id>`. `claude-sdk` remains available and is still the default unless you choose another driver.

## SDK Usage

This repo also ships reusable SDK packages for programmatic use:

- `@pi-claude-code-agent/runtime` for driver-backed sessions, status, events, transcripts, and normalized result usage
- `@pi-claude-code-agent/intercom-bridge` for named long-lived peers and managed-peer orchestration
- `@pi-claude-code-agent/subagents-backend` for persisted bounded local runs
- `@pi-claude-code-agent/teams-backend` for persistent local teammate records

Token usage is exposed as per-result-event data, not as an automatic session total. SDK consumers should sum selected `RuntimeEvent.type === "result"` events themselves when they need cumulative accounting. See `docs/token-usage-reporting.md` for the adapter/backend matrix and example SDK summing pattern.

## Try this first

Inside pi:

```text
/peer about
/peer init
/peer start reviewer | Review this repo briefly and report one concrete risk.
# keep working or wait; completion relays automatically
/peer ask reviewer | Reply with exactly: peer-ok
/peer dashboard advanced
```

If you want driver-specific peers, inspect the bundled catalog first:

```text
/peer models claude-cli
/peer models codex-cli
```

## How it works

After peer mode is active, the main agent can use the peer tools directly, and you can usually steer it in plain language.

Mental model:
- the main agent stays in charge; peers are delegated workers, not replacements for the orchestrator
- peers are long-lived sessions, so follow-up messages continue the same worker instead of starting from scratch
- most peers work in the same repository checkout; prefer short prompts plus file-based handoffs over pasting large context
- start bounded peer jobs, keep working in the main turn, and wait for the automatic completion/block/failure relay
- use `ask` when you need a reply now, `send` for fire-and-forget follow-up work, and `history` only when you need to scroll back for evidence
- do not babysit peers with repeated status polling

Primary slash-command surface:

```text
/peer
/peer help
/peer about
/peer init
/peer dashboard
/peer dashboard advanced
/peer dashboard hide
/peer dashboard show
/peer hide
/peer show
/peer start <prompt>
/peer start <prompt> | <driver> | <model>
/peer start <name> | <prompt>
/peer start <name> | <prompt> | <driver> | <model>
/peer ask <name> | <message>
/peer send <name> | <message>
/peer list
/peer models [claude-sdk|claude-cli|codex-cli] [all|advanced|verbose]
/peer history <name> [cursor] [limit]
/peer interrupt <name>
/peer stop <name>
/peer stop --all --confirm
```

LLM-callable tools:

```text
runtime_models(driver?, verbose?)
extension_log(category?, severity?, summary, observed?, expected?, reproduction?, suggestedFix?, relatedCommand?, relatedTool?, files?)
peer_start(prompt, name?, driver?, model?, cwd?)
peer_list()
peer_history(name, cursor?, limit?)
peer_ask(name, message, model?)
peer_send(name, message, model?)
peer_interrupt(name)
peer_stop(name?, all?, confirmAll?)
```

Advanced LLM-callable backend tools are hidden by default while their integration model is still being refined. Enable them only for development with `PI_CLAUDE_ENABLE_ADVANCED_COMMANDS=1`:

```text
subagent_run(task, name?, prompt?, driver?, model?, cwd?, async?)
subagent_list()
subagent_status(runId)
team_spawn(name, prompt, driver?, model?, cwd?)
team_task(name, title, details)
team_message(name, message)
team_list()
team_stop(name)
```

Legacy `/claude-*` commands are hidden by default. Re-enable old peer commands only for compatibility:

```bash
PI_CA_LEASH_ENABLE_LEGACY_COMMANDS=1 pi
```

Re-enable old internal diagnostics for development:

```bash
PI_CA_LEASH_ENABLE_LEGACY_COMMANDS=1 PI_CLAUDE_ENABLE_ADVANCED_COMMANDS=1 pi
```

## Behavior

The extension is lazy. Loading it registers commands and tools, but it does not start the Peers widget, background monitor, or intercom transport checks immediately. `/peer` with no args opens the dashboard and activates peer mode. `/peer init` also activates the peer workflow, adds the one-time orchestration guide to the main agent context, and shows the user a compact command cheat sheet as a user-only UI notification. The first actionable `/peer` command, such as `/peer models`, `/peer dashboard`, `/peer list`, or `/peer start`, also activates it and adds that agent guide once. `/peer help` and `/peer about` stay passive and show user-only UI notifications. `/peer about` reports the installed package version, package root, state root, default driver, and session mode. `/peer dashboard hide` (or `/peer hide`) clears the compact Peers widget for the current session without stopping peers or disabling completion relays; `/peer dashboard show` (or `/peer show`) restores it.

Peers are asynchronous workers. The main agent should start a peer, continue useful work, and wait for the automatic peer completion, blocked, or failure relay. It should not poll `peer_list`, `peer_history`, or repeated `peer_ask` just to see whether the peer is done. When a peer returns, the main agent still owns verification, synthesis, and the final answer.

The extension keeps peer output quiet by default:
- peer work does not stream child transcript spam into the main window
- peer command acknowledgments and reports are user-only UI notifications, not main-agent context
- peer completion is relayed back as one wrapped follow-up turn with the latest visible peer message
- detailed backend diagnostics live in `/peer dashboard advanced`

## Managed peers for downstream orchestrators

If another extension wants workers that behave like normal `pi-ca-leash` peers, use the supported managed-peer surface from `@pi-claude-code-agent/intercom-bridge`:

- `PiCaLeashManagedPeerApi`
- `piCaLeashStateDir(...)`
- `piCaLeashRuntimeStorageDir(...)`
- `piCaLeashBridgeStorageDir(...)`

That API gives downstream orchestrators the normal peer lifecycle (`launch`, `attach`, `list`, `status`, `send`, `ask`, `interrupt`, `stop`, `reconcile`) while writing to the same `.pi-ca-leash/{runtime,bridge}` state used by the extension.

Result: managed peers created by another extension can show up in the live `/peer dashboard` and `peer_list` without requiring a pi restart. The normal dashboard shows a compact `managed:owner` badge, and the advanced dashboard expands full managed-peer metadata.

Runtime driver notes:
- `claude-sdk` is the default and most complete path
- `claude-cli` shells out to local `claude -p --output-format stream-json`; it avoids importing the Agent SDK package, but still uses Claude Code non-interactively
- `codex-cli` is supported, but still experimental and not parity-complete
- `PI_CLAUDE_RUNTIME_DRIVER=claude-cli` or `PI_CLAUDE_RUNTIME_DRIVER=codex-cli` changes the default for newly started peers
- `/peer models` and LLM-callable `runtime_models` show a short recommended model list by default, including advisory use cases
- `/peer models ... all` and `runtime_models(verbose: true)` expose the full bundled Lanista-derived model catalog
- LLM-callable `peer_start`, `peer_ask`, and `peer_send` can pass explicit model ids
- `/peer start` can pass driver and model in pipe syntax
- common catalog aliases such as `sonnet`, `opus`, `haiku`, `mini`, and `spark` are resolved to exact model ids before runtime launch
- catalog validation is advisory; unknown model ids are still passed through to the runtime because provider and CLI availability is environment-dependent

## Repository Layout

```text
packages/
  runtime/            Claude/Codex runtime abstraction
  intercom-bridge/    named runtime-backed peers
  subagents-backend/  local subagent-style run backend
  teams-backend/      local persistent teammate backend
extensions/
  index.ts            pi extension wiring and command/tool surface
  prompts/            editable operator, tool, peer, and agent guidance text
```

Useful docs that should remain current:
- `ARCHITECTURE.md`
- `KNOWN_LIMITS.md`
- `CHANGELOG.md`
- `RELEASE_NOTES.md`
- `DEVELOPMENT.md`
- `AGENTS.md`

## Development

Start here:

```bash
npm test
npm run build
npm run smoke:dev
npm run smoke:last
npm run smoke:manual
```

For the full developer workflow, smoke-command reference, artifact/debugging guide, and manual release checklist, see [`DEVELOPMENT.md`](https://github.com/durandom/pi-ca-leash/blob/main/DEVELOPMENT.md).

## Persistence

Repository-local runtime state is written under:

```text
.pi-ca-leash/
  runtime/
  bridge/
  subagents/
  teams/
  extension/
  log.md
```

These paths are ignored by git. `log.md` is an append-only local feedback log for extension UX rough edges, confusing guidance, poor defaults, and repeated interaction problems. Remove `.pi-ca-leash/` when you need a clean local manual-test session.

Older local development state may also exist under ignored paths such as `.pi-claude-code-agent/`, `.claude-runtime/`, or `undefined/`. Those are not part of the package.

## Limits

The short version:
- full extension-host smoke testing still needs a real pi installation
- live intercom broker transport is optional
- Codex support is partial
- `runner=claude-code-agent` rejects real `fork`
- teams backend is local-only
- attention ack/snooze is local extension state

See `KNOWN_LIMITS.md` for the detailed version.
