# Changelog

## 1.0.4

`/grok:adversarial-review` never reviewed anything. Every run came back as
"Review in progress" with no findings; the 1.0.3 integrity check correctly
reported that as a failed review, but it failed every time.

- The investigative turn no longer runs under `--json-schema`. Grok 1.0.13
  applies that flag to every assistant message, and under it grok-4.6 does not
  call a tool at all: it reasons about inspecting the diff, then its message is
  forced into the schema shape and the turn ends with a stub. Resuming the
  session under the same flag produced the same stub, so the restate retry could
  not help either. The review now runs with the output schema in the prompt and
  its tools free; `--json-schema` is used only for the tool-free re-emit turn,
  where a constrained answer is exactly what is wanted.
- With nothing constraining the investigation, the companion now does the
  checking the CLI used to do. An object that does not satisfy
  `review-output.schema.json` — a missing field, a verdict outside the enum, a
  finding without one of its eight required fields, a value out of range — goes
  to the schema-constrained re-emit instead of being rendered as a review, so
  the JSON payload keeps honoring the schema. And when the change was not carried in the prompt — the lightweight
  context for reviews over two files — an answer given without a single tool
  call is treated as unfinished rather than accepted: an `approve` written from
  the file list would otherwise read as a clean bill of health.
- An unfinished review (a stub, or an answer given blind) is now sent back with
  Grok's tools still available. The old restate retry ran under `--json-schema`
  and so could never inspect anything; it could only repeat the stub. The
  schema-constrained turn is reserved for re-emitting an answer the session
  already holds.
- Review prompts are sent with `--verbatim`. Without it the CLI truncates a
  prompt of roughly 32 KB or more to its first 20 KB and offloads the rest to a
  file the model is told to read — which an inline diff regularly exceeds, and
  which a schema-constrained turn could never read. The `/grok:transfer` seed
  is sent the same way; it was losing all but its first 20 KB.
- Reviews now verify their read-only promise instead of assuming it. The
  `read-only` sandbox is a request the CLI drops silently when the kernel
  policy cannot be applied, and headless stderr is quiet, so after every
  review the companion reads what the run appended to the sandbox event log
  to learn whether the profile was enforced and whether it actually covers the
  repository, and fingerprints the working tree — every changed tracked file
  content-hashed by `git hash-object`, untracked files, HEAD, and the hooks
  and config git would run from, in the common git directory of a linked
  worktree too — before and after the run. A review that ran unfenced, a
  repository the profile leaves writable, or a tree that changed while the
  review ran is reported above the findings, in the JSON payload, and in the
  `/grok:status` summary; a multi-turn review reports its worst turn, since
  the first turn is where the tools ran; an outcome the log did not record, or
  records that disagree, is said to be unconfirmed rather than implied clean;
  and a fingerprint that could not be completed is reported as an unverified
  tree, never as an unchanged one. Measured on grok 1.0.13: Seatbelt does block
  writes into a repository under `read-only`, but the profile keeps the system
  temp directories writable by design, so a checkout under `/tmp` is not
  fenced by it — and `--permission-mode dontAsk` does not stop shell writes on
  its own.
- A prompt longer than 24,000 characters is handed to Grok as a file
  (`--prompt-file`) instead of on argv. Windows caps the whole command line at
  32,767 characters, and an inline diff alone can run to 256 KB, so a review
  that size failed to spawn before Grok ever saw it.
- Lightweight working-tree context caps the untracked file contents it inlines
  at 64 KB in total. Untracked files are in no diff, so their contents still
  travel with the prompt, but a tree with dozens of untracked files (generated
  reports, runtime workspaces) was inlining several hundred kilobytes per
  review. Past the budget, files are listed with their size for Grok to read
  with its tools.

## 1.0.3

Review-integrity fixes. Both defects made a broken review run look like a
finished one, which is the worst way for a review tool to fail.

- A review that asserts nothing is now reported as failed instead of as "no
  findings". Grok can end a turn with an object that satisfies the schema and
  says nothing — a literal `PLACEHOLDER` summary, or the narration it was
  writing while still investigating — and that rendered as
  `Verdict: needs-attention / No material findings`, indistinguishable from a
  clean bill of health. Such a run is now retried once with an instruction to
  restate the real assessment, and if it still cannot, the job is recorded
  `failed` with the raw output shown. A non-approving verdict carrying no
  findings is rejected on the same grounds.
- Branch reviews no longer diff from a stale local base branch.
  `refs/remotes/origin/HEAD` was read for the default branch *name* and then
  resolved to the local branch of that name, which on a feature branch is
  usually months behind `origin/`. Once the branch merged the real base in,
  every upstream commit since then landed inside the review: one 8-file change
  was reviewed as 113 files of unrelated trunk work. The base is now whichever
  of `origin/<name>` and `<name>` forks from HEAD most recently, so a stale copy
  on either side cannot widen the scope. An explicit `--base` is still used
  verbatim.
- Review prompts now name the exact commit range and the in-scope file list
  instead of naming the base branch and leaving the command to the model.
  `git diff <base>`, `git show HEAD`, and the diff of a merge commit all sweep
  in merged-in upstream work, and a model given only a branch name reaches for
  them. This applies to both `/grok:review` and `/grok:adversarial-review`.

## 1.0.2

Background-mode fixes. Every background run is a separate process sharing one
job index, and none of the following was reachable from a foreground run, so the
test suite stayed green while the plugin misbehaved in real use.

- Concurrent background jobs no longer delete each other. Job state is now
  read-modify-written under an exclusive lock and published by atomic rename;
  previously a second job starting while the first was saving could drop the
  first from the index, reduce it to an id-only stub, and delete its job file
  and log.
- The job cap no longer evicts a job that is still running. A long background
  review could be pruned mid-flight, deleting the log it was still writing to.
- A background job whose process was killed is now reconciled to `failed`
  instead of reporting `running` forever. Previously that stuck record made
  `/grok:status` never settle, blocked every later `--resume-last`, forced an
  explicit job id on `/grok:cancel`, and let cancel signal a pid the OS may
  since have reassigned to an unrelated process.

## 1.0.1

- Fix reviews failing with "Grok did not return valid structured JSON". Grok narrates
  between tool calls, and under a JSON schema that narration is itself JSON, so the
  captured output was several complete objects glued together. Assistant messages are
  now tracked as separate segments and the final one is used as the answer.
- Prefer the schema-validated `structuredOutput` that Grok reports on its `end` event
  instead of re-parsing the text stream.
- Recover reviews whose JSON was cut off by the output-token budget, keeping every
  finding emitted before the cut and flagging the result as partial. A recovered
  review never reports a clean approval: when the cut lands before any finding,
  repair can only produce an empty findings list, and reporting that as "no issues
  found" would be an all-clear Grok never gave.
- Retry once, on the same Grok session, when a review produces nothing parseable or
  had to be repaired — a restated answer is something Grok actually said, where a
  repaired one is partly inferred.
- Tell Grok in the review prompt to emit its JSON exactly once, and bound findings and
  field lengths in the review schema so long reviews cannot blow the output budget.
- Fix the stop-time review gate reading Grok's opening narration as its verdict; it now
  uses the last `ALLOW:`/`BLOCK:` line.
- Let Claude invoke the Grok commands itself. `review`, `adversarial-review`, `status`,
  `result`, `cancel`, and `transfer` were marked `disable-model-invocation`, so Claude
  could only ask the user to type the slash command.
- Trim the reasoning section in rendered results to a readable tail.
- Stop `/grok:review` and `/grok:adversarial-review` blocking on a wait-vs-background
  question. They now size the change themselves, say which mode they picked, and run.
  Now that Claude can route a natural-language request to these commands, there is
  nobody to answer that question and the review never ran at all.
- Make the "your reply is the review" contract concrete in both review commands.
  Claude was replying "That's the full Grok review output above, reproduced verbatim"
  and delivering nothing, so the findings never reached the user.

## 1.0.0

- Initial release of the Grok Build plugin for Claude Code.
- Derivative of OpenAI's Codex plugin for Claude Code (Apache-2.0); retargeted to Grok Build headless CLI (`grok -p`), with plugin surface renamed to `/grok:*` and Codex app-server/broker integration removed.
