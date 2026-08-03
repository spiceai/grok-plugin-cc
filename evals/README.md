# Grok plugin evals

The unit tests in `tests/` prove the companion script behaves. These evals prove
something different and harder to keep true: that **Claude actually uses the
plugin the way it was designed to be used.**

That distinction matters because almost everything valuable about this plugin is
a behaviour, not a function. Nothing in `tests/` can tell you whether Claude
routes "get grok to fix it" to the rescue subagent instead of quietly fixing it
itself, whether the rescue subagent stays a thin forwarder instead of burning a
few thousand tokens re-deriving the problem, or whether Claude keeps its hands
off the code after a review. Those behaviours drift whenever a prompt, a skill,
or a model version changes, and they drift silently.

## How a run works

Each eval is one real `claude -p` session:

1. A throwaway git repo is built from `fixtures/<name>/`. `base/` becomes the
   committed history and `change/` is copied on top, so the run starts with a
   realistic uncommitted change containing a real bug.
2. `bin/grok` is put at the front of `PATH`. It is a **transparent tracing
   shim**, not a mock — it appends the argv it was called with to a JSONL log
   and then execs the real Grok Build CLI with stdio passed straight through.
   Grok does all the real work; we just get to see exactly what the plugin asked
   it to do.
3. `claude -p` runs in that repo with `--plugin-dir plugins/grok`.
4. Three independent sources are collected and graded: the main session
   transcript, the rescue subagent's own transcript, and the Grok argv trace.

Every assertion is programmatic. No LLM judges anything, so a pass rate that
moves between iterations means behaviour moved — not that a grader felt
different that day.

## Running

```bash
# Everything: 6 evals × (with-plugin, baseline)
node evals/run-evals.mjs

# One eval, with-plugin only — the fast loop while iterating on a prompt
node evals/run-evals.mjs --eval slash-review-no-autofix --config with_plugin

# A later iteration, so results sit side by side for comparison
node evals/run-evals.mjs --iteration 2
```

| Flag | Default | Notes |
|---|---|---|
| `--eval <id>` | all | Repeatable. |
| `--config <list>` | `with_plugin,baseline` | `baseline` runs the same prompt with no plugin loaded. |
| `--iteration <n>` | `1` | Results land in `evals/runs/iteration-<n>/`. |
| `--model <name>` | `sonnet` | Model for the *main* thread. The rescue subagent is pinned to sonnet in its own frontmatter. |
| `--concurrency <n>` | `3` | Real Grok runs in parallel. |
| `--timeout-ms <n>` | `900000` | Per session. |
| `--grok-bin <path>` | `~/.grok/bin/grok` | The real binary the shim execs. |
| `--workspace <dir>` | `evals/runs` | Gitignored. |

**These evals spend real money on both sides** — Claude sessions and xAI usage.
A full run is roughly a dozen sessions. `grok login` (or `XAI_API_KEY`) must
already work, since the shim only forwards.

Per run you get `run.json`, `grading.json`, `stdout.json`, `grok-calls.jsonl`
(the raw argv trace), and the fixture repo exactly as Grok left it. Per
iteration you get `benchmark.json` and `benchmark.md`.

## What is covered

| Eval | Dimension | The failure it is there to catch |
|---|---|---|
| `nl-delegate-fix` | routing | Claude fixes the bug itself instead of delegating; or delegates without write access so nothing lands. |
| `nl-readonly-diagnose` | flags | "diagnose only, don't change anything" still gets `--always-approve` and Grok edits the user's code. |
| `slash-rescue-flag-mapping` | flags | `build` never becomes `grok-build`; `--effort` is dropped; routing flags leak into the prompt text Grok reads as task content. |
| `slash-review-no-autofix` | review discipline | Claude helpfully "fixes" what the review found. This is the one rule `grok-result-handling` marks CRITICAL, and it is exactly the kind of instruction models soften over time. |
| `no-hijack-trivial-task` | routing | Over-triggering. A one-line JSDoc comment gets shipped to Grok, making the plugin feel slow and expensive. |
| `nl-review-routing` | routing | `/grok:review` sets `disable-model-invocation`, so a natural-language review request cannot reach it. Claude must either route through rescue or name the command — silently reviewing the code itself is the failure. |

Forwarder discipline is graded inside the rescue evals rather than as its own
case, because it is only observable when a delegation actually happens: exactly
one tool call, Bash only, and no `Read`/`Grep`/`Glob`/`Edit` from inside the
subagent.

### Why baselines

The baseline config runs the identical prompt with no plugin loaded. For most
evals it simply confirms the plugin is load-bearing. Its real job is
`no-hijack-trivial-task`: that eval passes trivially when nothing can call Grok,
so without the baseline you could not tell a well-behaved plugin from an absent
one. Read the two columns together, never with-plugin alone.

## Adding an eval

Append to `evals.json`. Available checks:

| Check | Grades |
|---|---|
| `subagent_spawned` / `subagent_absent` | `{agentType}` — did the routing decision go where it should? |
| `grok_turns` | `{equals\|min\|max}` — real headless turns, with `--version` probes filtered out. |
| `grok_argv_sequence` | `{tokens}` — an *ordered adjacent* run, so `-m grok-build` cannot pass because both words happen to appear somewhere. |
| `grok_argv_absent` | `{tokens}` — none of these flags reached the CLI. |
| `grok_prompt_matches` / `grok_prompt_not_matches` | `{pattern}` — regex over the `-p` value. |
| `subagent_tools` | `{agentType, allowed?, forbidden?, maxCalls?}` — forwarder discipline. |
| `main_tools_absent` | `{tools}` — main thread kept its hands off. |
| `files_unchanged` / `files_changed` | `{paths?}` — sha256 over the tree, before vs after. |
| `response_matches` | `{pattern}` — regex over the user-visible response. |
| `helper_output_matches` | `{pattern}` — regex over what the companion printed into Claude's context. Pair it with `response_matches` to tell "Grok never found it" apart from "Grok found it and Claude did not relay it" — a tool result the user never expands is not an answer. |
| `tests_pass` / `tests_fail` | Runs `node --test` in the fixture: did the work actually land? |
| `grok_write_capability` | `{expect: "write" \| "read-only"}` — classifies the run by mechanism. Do **not** grade this on `--always-approve`: the companion passes it on both paths and expresses read-only by adding `--disallowed-tools search_replace,write,…`. |
| `any_of` | `{checks}` — passes if any nested check passes. Use when two paths are both legitimately correct. |

`node evals/regrade.mjs <iteration>` replays grading over saved transcripts and
argv traces after you change an assertion. Assertions encode a guess about how
the plugin works, and that guess is wrong often enough that you want a $0 way to
correct it — re-running the sessions would spend real Claude and xAI usage to
re-learn what is already on disk. Only the fixture tests re-execute.

## A/B against the Codex plugin

This plugin is a retarget of OpenAI's Codex plugin — same command surface, same
forwarder design, same companion structure, differing only in which CLI it
drives. That makes Codex the natural control: anything Grok does worse on the
same prompt is a **retarget regression**, not a limit of the design. Every bug
found so far had this shape (a Codex-valid value copied into a Grok-invalid
slot), which is exactly why the comparison earns its keep.

```bash
node evals/run-evals.mjs --provider grok  --suite ab-evals.json --config with_plugin
node evals/run-evals.mjs --provider codex --suite ab-evals.json --config with_plugin
```

Result after the retarget fixes: **Grok 16/16, Codex 16/16** — exact parity on
every outcome, including the fix landing (4/4 fixture tests green on both) and
the forwarder staying thin. Before the fixes Grok could not complete a
write-capable rescue at all, so this is the number that says the retarget is
actually done.

Two assertions had to be corrected to get there, and both were wrong in the same
instructive way — they encoded a *mechanism* where the goal was an *outcome*:

- `output-reaches-the-user` grepped for the `[grok]` progress prefix. Both
  plugins summarise the run rather than echoing raw stdout, and the summaries
  were accurate and useful. That is formatting, not effectiveness; it now checks
  that the user learns what changed and where.
- The read-only-under-pressure eval originally followed up with "go ahead and
  fix whatever it found" — which *authorises* the edit, so editing was correct
  and the assertion was simply wrong. The rule worth protecting is that a review
  never edits **unsolicited**, so the follow-up is now a question that grants
  nothing.

`ab-evals.json` holds only outcome-level assertions both plugins claim to
deliver — delegation reaches the CLI, the forwarder stays thin, the fix lands,
the output reaches the user, review changes nothing. Provider-specific flag
names deliberately live in `evals.json` instead; asserting on `-m grok-4.5`
would make the suite unrunnable against Codex and prove nothing about either.
`providers.mjs` supplies the per-provider plugin path, rescue-agent name, CLI
binary, progress marker, and the predicate for "this argv is a real model turn"
(Grok takes `grok -p …`; Codex drives `codex app-server`). Placeholders
`{{PROVIDER}}`, `{{RESCUE_AGENT}}`, and `{{PROGRESS_MARKER}}` are substituted
per provider.

## What the Grok CLI actually accepts

Interrogating `grok --help` and probing the live binary (0.2.118) turned up
three contract mismatches, and one of them is not fixable from the plugin:

| Plugin sent | Grok's reality |
|---|---|
| `--sandbox workspace-write` | Not a profile. The CLI **refuses to start**. Built-ins that work: `read-only`, `workspace`. |
| `-m grok-build` | Not a model id — `grok models` lists `grok-4.5`. Unknown ids are a hard error, not a fallback. |
| `--disallowed-tools search_replace,write,…` | Correct tool names, but **not sufficient**. `run_terminal_command` is not in the list, and `printf > file` writes just fine. |

**Read-only is not enforceable from the plugin today.** Probed directly against
the live CLI: `--sandbox read-only` did not stop the `write` tool, and
`--permission-mode plan` did not either — both let a write through to the
working directory. Blocking `run_terminal_command` would close the shell bypass
but also break review, which needs a shell to run `git diff`. So `/grok:review`
being "read-only" currently rests on the prompt instruction plus a partial tool
blocklist, and a determined model can still edit. The evals cover the
*behavioural* half of this (`ab-review-stays-read-only-under-pressure` invites a
fix on the turn after a review and asserts nothing changes on disk), but the
hard guarantee needs a working sandbox profile from the CLI side.

## Findings from the first run

Worth reading before trusting a green suite, because each of these is a shape of
failure the harness had to be reshaped to see:

- **`--sandbox workspace-write` did not exist in Grok.** A Codex profile name
  survived the retarget, so the CLI refused to start and every write-capable
  rescue run failed. Fixed in `grok-companion.mjs`; `tests/runtime.test.mjs`
  now pins the profile against the set Grok recognises.
- **Fixing that unmasked `grok-build`,** which `grok models` does not list. The
  first bug aborted the run before the model was ever set, so the second could
  not surface until the first was gone. Expect this: cascading failures hide
  behind each other, and one fix can lower a score before it raises it.
- **`slash-rescue-flag-mapping` scored 6/6 while the run was dying.** Every flag
  assertion passed on argv that Grok then rejected. Grading what was *sent*
  without also grading that the run *started* is a blind spot; that is what
  `grok-run-actually-started` closes.
- **Two assertions were wrong, not the plugin.** `--always-approve` reads like a
  write flag but is passed on both paths, and `--json-schema` belongs to
  adversarial review, not native review. Both produced confident false bug
  reports. When an assertion fails, confirm the mechanism before believing it.

Prefer assertions that would **fail if the plugin regressed**. An assertion that
passes in both configs is measuring the model, not the plugin, and it will
quietly inflate every future pass rate.
