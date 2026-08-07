---
description: Cancel an active background Grok job in this repository. Use when the user asks to stop, kill, abort, or cancel a running Grok review or rescue job.
argument-hint: '[job-id]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" cancel "$ARGUMENTS"`
