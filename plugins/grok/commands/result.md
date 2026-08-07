---
description: Show the stored final output for a finished Grok job in this repository. Use when the user asks what Grok found, wants the results of a finished Grok review or rescue run, or asks to see the output of a background Grok job.
argument-hint: '[job-id]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/grok:status <id>` and `/grok:review`
