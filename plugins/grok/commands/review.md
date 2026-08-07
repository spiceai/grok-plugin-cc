---
description: Run a Grok code review of the local git changes (working tree or branch diff). Use whenever the user asks for a Grok review, a second opinion from Grok, or wants Grok to look over the current changes, this branch, or a diff — including phrasings like "have grok review this", "get grok to check my changes", or "run a grok review".
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Grok review through the shared built-in reviewer.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and put Grok's output in front of the user.

Your reply is the only thing the user sees:
- Bash results are collapsed in the transcript. The user cannot read them.
- So a reply that refers to the output instead of containing it delivers nothing, and the review — which cost real time and money — is lost.
- Concretely, replies like "That's the full Grok review output above, reproduced verbatim", "the review is above", or "output shown above" are the failure. Claiming you reproduced it is not reproducing it.
- Your reply must literally begin with the first line of the companion's stdout and carry the whole thing through.

Execution mode rules:
- If the raw arguments include `--wait`, run the review in the foreground.
- If the raw arguments include `--background`, run the review in a Claude background task.
- Otherwise, size the review yourself and act on that judgement — do not stop to ask:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Run in the foreground when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, run it in the background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Say which mode you picked and how to override it, in one short line, then proceed in the same turn.
- Asking first and waiting for an answer strands the review: this command is reached both by a user typing it and by Claude routing a natural-language request to it, and in the routed case there is nobody to answer, so the review never runs at all. Picking the sensible default and saying so costs the user nothing and always produces a review.

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/grok:review` is native-review only. It does not support staged-only review, unstaged-only review, or extra focus text.
- If the user needs custom review instructions or more adversarial framing, they should use `/grok:adversarial-review`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review "$ARGUMENTS"
```
- Copy the command's stdout into your reply, exactly as-is. Start your reply with its first line.
- The user does not see Bash output, so this copy is the review as far as they are concerned. Re-read the "Your reply is the only thing the user sees" rules above before you answer.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review "$ARGUMENTS"`,
  description: "Grok review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Grok review started in the background. Check `/grok:status` for progress."
