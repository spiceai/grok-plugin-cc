# Changelog

## 1.0.1

- Fix reviews failing with "Grok did not return valid structured JSON". Grok narrates
  between tool calls, and under a JSON schema that narration is itself JSON, so the
  captured output was several complete objects glued together. Assistant messages are
  now tracked as separate segments and the final one is used as the answer.
- Prefer the schema-validated `structuredOutput` that Grok reports on its `end` event
  instead of re-parsing the text stream.
- Recover reviews whose JSON was cut off by the output-token budget, keeping every
  finding emitted before the cut and flagging the result as partial.
- Retry once, on the same Grok session, when a review still produces nothing parseable.
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
