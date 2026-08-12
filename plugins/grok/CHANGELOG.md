# Changelog

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
