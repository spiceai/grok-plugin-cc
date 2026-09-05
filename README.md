# Grok plugin for Claude Code

Use [Grok Build](https://x.ai) from inside Claude Code for code reviews or to delegate tasks to Grok.

This plugin is for Claude Code users who want an easy way to start using Grok Build from the workflow
they already have.

## What You Get

- `/grok:review` for a normal read-only Grok review
- `/grok:adversarial-review` for a steerable challenge review
- `/grok:rescue`, `/grok:transfer`, `/grok:status`, `/grok:result`, and `/grok:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **Grok account (browser login) or `XAI_API_KEY`.**
  - Usage follows your Grok / xAI plan limits.
- **Node.js 18.18 or later**
- **Grok Build CLI** (`grok`) installed on your PATH

## Install

Add the marketplace in Claude Code (when published), or install from a local checkout:

```bash
/plugin marketplace add <owner>/grok-plugin-cc
```

Install the plugin:

```bash
/plugin install grok@xai-grok
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/grok:setup
```

`/grok:setup` will tell you whether Grok is ready. If Grok is missing, it can offer to install the CLI for you.

If you prefer to install Grok yourself:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
```

If Grok is installed but not logged in yet, run:

```bash
!grok login
```

Or set an API key:

```bash
export XAI_API_KEY="xai-..."
```

After install, you should see:

- the slash commands listed below
- the `grok:grok-rescue` subagent in `/agents`

One simple first run is:

```bash
/grok:review --background
/grok:status
/grok:result
```

## Usage

Every command below can be typed as a slash command, and Claude can also reach for
it on its own. Asking "have Grok review this" or "get Grok to fix the failing test"
routes to the right command without you naming it.

### `/grok:review`

Runs a normal Grok review on your current work.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/grok:adversarial-review`](#grokadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/grok:review
/grok:review --base main
/grok:review --background
```

This command is read-only and will not perform any changes: Grok runs under its `read-only` sandbox, and the companion checks afterwards that the sandbox was actually enforced and that the working tree is unchanged, warning above the output if either is not so. When run in the background you can use [`/grok:status`](#grokstatus) to check on the progress and [`/grok:cancel`](#grokcancel) to cancel the ongoing task.

### `/grok:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/grok:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/grok:review`, it can take extra focus text after the flags.

Examples:

```bash
/grok:adversarial-review
/grok:adversarial-review --base main challenge whether this was the right caching and retry design
/grok:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code. Grok runs under its `read-only` sandbox, and the companion checks afterwards that the sandbox was actually enforced and that the working tree is unchanged, warning above the findings if either is not so.

### `/grok:rescue`

Hands a task to Grok through the `grok:grok-rescue` subagent.

Use it when you want Grok to:

- investigate a bug
- try a fix
- continue a previous Grok task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue session for this repo.

Examples:

```bash
/grok:rescue investigate why the tests started failing
/grok:rescue fix the failing test with the smallest safe patch
/grok:rescue --resume apply the top fix from the last run
/grok:rescue --model grok-4.5 --effort medium investigate the flaky integration test
/grok:rescue --model build fix the issue quickly
/grok:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Grok:

```text
Ask Grok to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Grok chooses its own defaults.
- if you say `build` or `fast`, the plugin maps that to `grok-4.5`
- follow-up rescue requests can continue the latest Grok task in the repo

### `/grok:transfer`

Creates a Grok session seeded from the current Claude Code session and prints a `grok --resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that context in Grok.

Examples:

```bash
/grok:transfer
/grok:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. Transfer seeds context into a new Grok headless session (Grok does not natively import Claude JSONL). The source must be under `~/.claude/projects`.

### `/grok:status`

Shows running and recent Grok jobs for the current repository.

Examples:

```bash
/grok:status
/grok:status task-abc123
```

### `/grok:result`

Shows the final stored Grok output for a finished job.
When available, it also includes the Grok session ID so you can reopen that run with `grok --resume <session-id>`.

Examples:

```bash
/grok:result
/grok:result task-abc123
```

### `/grok:cancel`

Cancels an active background Grok job.

Examples:

```bash
/grok:cancel
/grok:cancel task-abc123
```

### `/grok:setup`

Checks whether Grok is installed and authenticated.
If Grok is missing, it can offer to install the CLI for you.

You can also use `/grok:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/grok:setup --enable-review-gate
/grok:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Grok review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Grok loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/grok:review
```

### Hand A Problem To Grok

```bash
/grok:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/grok:adversarial-review --background
/grok:rescue --background investigate the flaky test
```

Then check in with:

```bash
/grok:status
/grok:result
```

## Grok Integration

The plugin wraps the [Grok Build headless CLI](https://x.ai) (`grok -p`). It uses the global `grok` binary installed in your environment and applies the same configuration as interactive Grok.

### Common Configurations

If you want to change the default model that gets used by the plugin, define that in your user-level or project-level config. For example, to prefer `grok-4.5` for a project, add the following to `~/.grok/config.toml` or project config:

```toml
[models]
default = "grok-4.5"
```

Your configuration will be picked up based on:

- user-level config in `~/.grok/config.toml`
- project-level overrides discovered by Grok for the working directory

### Moving The Work Over To Grok

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be resumed inside Grok by running `grok --resume` with the session ID from `/grok:result` or `/grok:status`.

## FAQ

### Do I need a separate Grok account for this plugin?

If you are already signed into Grok on this machine, that account should work immediately here too. This plugin uses your local Grok CLI authentication.

If you only use Claude Code today and have not used Grok yet, sign in with `!grok login` or set `XAI_API_KEY`. Run `/grok:setup` to check readiness.

### Does the plugin use a separate Grok runtime?

No. This plugin delegates through your local Grok Build CLI on the same machine using headless mode (`grok -p`).

That means:

- it uses the same Grok install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Grok config I already have?

Yes. If you already use Grok, the plugin picks up the same configuration.

### Can I keep using my current API key setup?

Yes. Set `XAI_API_KEY` or use `grok login`. The plugin inherits that auth for headless runs.

## License and attribution

This project is licensed under the [Apache License, Version 2.0](LICENSE).

It is a **derivative work** of OpenAI's [Codex plugin for Claude Code](https://github.com/openai/codex-plugin-cc), which is also licensed under Apache License 2.0. The original copyright notices are retained in [`NOTICE`](NOTICE). This repository's modifications retarget that plugin to the Grok Build CLI; see `NOTICE` for a summary of those changes.

OpenAI, Codex, and related marks are trademarks of their respective owners. This project is not affiliated with or endorsed by OpenAI.
