---
description: Show active and recent Grok jobs for this repository, including review-gate status. Use whenever the user asks how a Grok run is going, whether Grok finished, what Grok is doing, or to check on a background Grok review or rescue job.
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" status "$ARGUMENTS"`

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the command output, including job ID, kind, status, phase, elapsed or duration, summary, and follow-up commands.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
