---
description: Transfer the current Claude Code session into a resumable Grok session. Use when the user wants to hand this conversation over to Grok, continue this work in the Grok CLI, or move the session to Grok.
argument-hint: "[--source <claude-jsonl>]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Grok session ID and the `grok --resume <session-id>` command.
