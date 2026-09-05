import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/grok/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "grok-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

function prepareRepo() {
  const cwd = makeTempDir("grok-repo-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "src-main.ts"), "export const x = 1;\n");
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "main.ts"), "export const x = 1;\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "main.ts"), "export const x = 2;\n");
  return cwd;
}

test("setup reports ready when fake grok is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.grok.available, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.sessionRuntime.mode, "headless");
});

test("setup reports not ready when grok is missing", () => {
  const emptyBin = makeTempDir();
  const home = makeTempDir("grok-home-");
  // Keep node/npm discoverable, but ensure no `grok` binary is on PATH.
  const nodeDir = path.dirname(process.execPath);
  const result = run(process.execPath, [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${emptyBin}${path.delimiter}${nodeDir}`,
      GROK_HOME: home,
      XAI_API_KEY: ""
    }
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.grok.available, false);
});

test("setup treats XAI_API_KEY as authenticated", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const home = makeTempDir("grok-home-");
  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      GROK_HOME: home,
      XAI_API_KEY: "xai-test-key"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.authMethod, "apiKey");
});

test("setup can enable and disable the review gate", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);
  const cwd = prepareRepo();
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");

  let result = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr);
  let payload = JSON.parse(result.stdout);
  assert.equal(payload.reviewGateEnabled, true);

  result = run("node", [SCRIPT, "setup", "--disable-review-gate", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr);
  payload = JSON.parse(result.stdout);
  assert.equal(payload.reviewGateEnabled, false);
});

test("native review returns grok output for working tree changes", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-ok");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review, "Review");
  assert.match(payload.grok.stdout, /Review|Findings|null check/i);
  assert.ok(payload.threadId);
});

test("adversarial review returns structured findings", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-ok");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json", "focus on auth"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review, "Adversarial Review");
  assert.ok(payload.result || payload.rawOutput);
});

/**
 * The failure that made `/grok:adversarial-review` unusable end to end: Grok
 * narrates between tool calls, and under a JSON schema that narration is itself
 * JSON. Concatenating every `text` event produced back-to-back objects, so a
 * review that had actually succeeded was reported as malformed output.
 */
test("adversarial review recovers the final object from interim JSON drafts", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-drafts");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.parseError, null, "drafted output must not surface as a parse failure");
  assert.equal(payload.result.summary, "Found one material issue in the change set.");
  assert.equal(payload.result.findings.length, 1);
});

test("adversarial review trusts grok's own structured output over the text stream", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-structured");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.parseError, null);
  assert.equal(payload.result.verdict, "needs-attention");
});

test("adversarial review salvages findings from output cut off by the token budget", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-truncated");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.parseError, null);
  assert.equal(payload.recovered, "truncated-json");
  assert.equal(payload.stopReason, "max_tokens");
  assert.equal(payload.result.verdict, "needs-attention");
});

/**
 * Repairing a half-written answer can only close the containers it was given.
 * When the cut lands before any finding, that produces a clean approval with an
 * empty findings list — an all-clear the model never gave, and the worst
 * possible thing for a review tool to report. It must never be the answer.
 */
test("adversarial review refuses a salvaged all-clear and restates the review instead", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-truncated-allclear");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);

  assert.notEqual(payload.result?.verdict, "approve", "a repaired empty approval must not be reported as the verdict");
  assert.equal(payload.result.findings.length, 1, "the restated review should have replaced the salvage");
  assert.equal(payload.parseError, null);
});

/**
 * The failure this guards against was observed three runs running: Grok ended
 * its turn with `{"verdict":"needs-attention","summary":"PLACEHOLDER",
 * "findings":[]}`. It parses, it validates against the schema, and it renders
 * as "No material findings" — a broken run presented as a clean bill of health.
 * A review that asserts nothing has to be reported as failed.
 */
test("a placeholder summary is reported as a failed review, not as no findings", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-placeholder");
  const env = buildEnv(binDir);
  const pluginData = makeTempDir("plugin-data-");
  env.CLAUDE_PLUGIN_DATA = pluginData;
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  const payload = JSON.parse(result.stdout);

  assert.notEqual(result.status, 0, "a review that asserted nothing must not exit clean");
  assert.equal(payload.result, null, "the stub must not be handed back as the review");
  assert.match(payload.parseError, /placeholder/i);

  const rendered = run("node", [SCRIPT, "adversarial-review"], { cwd, env });
  assert.doesNotMatch(rendered.stdout, /No material findings/, "a failed run must not read as a clean review");

  // The user reads /grok:status, not the exit code. The job has to say failed.
  const stateRoot = path.join(pluginData, "state");
  const stateDir = path.join(stateRoot, fs.readdirSync(stateRoot)[0]);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const reviewJobs = state.jobs.filter((job) => job.jobClass === "review");
  assert.ok(reviewJobs.length > 0, "the review should have been tracked");
  assert.ok(
    reviewJobs.every((job) => job.status === "failed"),
    `a review that asserted nothing must be recorded as failed, got ${reviewJobs.map((job) => job.status).join(", ")}`
  );
});

/**
 * Same failure, different shape: the model describing the review it is still
 * doing. Zero findings behind a non-approving verdict is never an all-clear.
 */
test("an unfinished narrated review is reported as a failure", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-narrated");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  const payload = JSON.parse(result.stdout);

  assert.notEqual(result.status, 0);
  assert.equal(payload.result, null);
  assert.ok(payload.parseError, "the run must carry a reason it failed");
});

/** The session is still warm, so a stub is worth one restate turn first. */
test("a placeholder review is restated rather than lost when grok can still answer", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-placeholder-restated");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.parseError, null);
  assert.notEqual(payload.result.summary, "PLACEHOLDER");
  assert.ok(payload.result.findings.length > 0);

  // A stub means the change was never looked at, and a turn under
  // `--json-schema` cannot look — so the restate has to run unconstrained.
  const [, restate] = grokRuns(binDir);
  assert.ok(restate.includes("--resume"));
  assert.ok(!restate.includes("--json-schema"), "the restate must leave grok free to inspect");
});

/**
 * Node reports a null exit code when a child dies from a signal, which is
 * exactly how /grok:cancel stops a run. Treating that as success would store the
 * partial output as a completed review.
 */
test("a grok process killed by a signal is reported as a failure, not a completed run", async () => {
  const { runGrokTurn } = await import("../plugins/grok/scripts/lib/grok.mjs");
  const binDir = makeTempDir();
  installFakeGrok(binDir, "killed-mid-run");
  const env = buildEnv(binDir);
  const cwd = prepareRepo();

  const result = await runGrokTurn(cwd, { prompt: "review this", env });

  assert.equal(result.status, 1, "a signalled run must not report success");
  assert.equal(result.exitCode, null, "signalled processes report a null exit code");
  assert.ok(result.exitSignal, "the signal should be retained");
  assert.match(result.error.message, /signal/i);
});

function grokRuns(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-grok-state.json"), "utf8")).argsHistory;
}

/** Three modified files: over the inline threshold, so the diff is not in the prompt. */
function prepareLightweightRepo() {
  const cwd = makeTempDir("grok-repo-lite-");
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v2";\n`);
  }
  return cwd;
}

/**
 * With the investigation unconstrained, an approval can be written from the
 * file list alone. When the change was not in the prompt, a review that never
 * called a tool has to be sent back to look — with its tools, not under the
 * schema flag that stops it from looking.
 */
test("a review answered without inspecting an uninlined change is sent back to look", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-blind-approve");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareLightweightRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.parseError, null);
  assert.equal(payload.result.verdict, "needs-attention", "the blind approval must not be the answer");
  assert.equal(payload.result.findings.length, 1);

  const [investigation, restate] = grokRuns(binDir);
  assert.ok(!investigation.includes("--json-schema"));
  assert.ok(restate.includes("--resume"), "the restate must continue the same session");
  assert.ok(!restate.includes("--json-schema"), "a turn that still has to inspect must not be schema-constrained");
  assert.ok(!restate.includes("--max-turns"), "a turn that still has to inspect must be free to call tools");
});

test("a review that never inspects an uninlined change is a failure, not an approval", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-blind-always");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareLightweightRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  const payload = JSON.parse(result.stdout);

  assert.notEqual(result.status, 0, "an approval given blind must not exit clean");
  assert.equal(payload.result, null);
  assert.match(payload.parseError, /without inspecting/i);
  assert.equal(grokRuns(binDir).length, 2, "one restate, then give up");
});

/** The guard must not fire when the prompt already carried the whole change. */
test("an approval given from an inline diff needs no tool call", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-blind-always");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.parseError, null);
  assert.equal(payload.result.verdict, "approve");
  assert.equal(grokRuns(binDir).length, 1);
});

/**
 * Windows caps a command line at 32,767 characters, and an inline review diff
 * alone can run to 256 KB — a prompt that size on argv fails to spawn before
 * Grok ever sees it. Past a threshold the prompt is handed over as a file.
 */
test("a review prompt too long for argv is handed to grok as a file", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-ok");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();
  // One tracked change plus one ~21 KB untracked file: still inline mode, and
  // still under the per-file cap, but the prompt now exceeds what a Windows
  // command line can carry.
  fs.writeFileSync(path.join(cwd, "generated.txt"), `${"x".repeat(80)}\n`.repeat(260));

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.parseError, null);
  assert.equal(payload.result.findings.length, 1);

  const [investigation] = grokRuns(binDir);
  assert.ok(!investigation.includes("-p"), "a prompt this long must not ride on argv");
  const promptFile = investigation[investigation.indexOf("--prompt-file") + 1];
  assert.ok(promptFile, "the prompt must be handed over as a file");
  assert.ok(investigation.includes("--verbatim"), "the file must still be sent whole");
  assert.ok(!fs.existsSync(promptFile), "the prompt file must be cleaned up after the run");
});

/**
 * `--sandbox read-only` is a request. When the kernel policy cannot be applied
 * the CLI logs a warning and runs unfenced, and headless stderr is quiet, so
 * the event log in $GROK_HOME is the only record. It is read after every
 * review and the outcome travels with the result.
 */
test("a review reports the sandbox it ran under and an unchanged tree", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-ok");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.sandbox.requested, "read-only");
  assert.equal(payload.sandbox.applied, true, "the event log said the profile was enforced");
  assert.equal(payload.sandbox.profile, "read-only");
  assert.deepEqual(payload.workingTreeChanges, []);
});

test("a review whose sandbox was not applied says so above its findings", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-sandbox-unapplied");
  const env = buildEnv(binDir);
  const pluginData = makeTempDir("plugin-data-");
  env.CLAUDE_PLUGIN_DATA = pluginData;
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, "the findings are still real; the warning is about what else may have happened");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sandbox.applied, false);
  assert.match(payload.sandbox.detail, /seatbelt unavailable/);
  assert.equal(payload.result.findings.length, 1);

  const rendered = run("node", [SCRIPT, "adversarial-review"], { cwd, env });
  assert.match(rendered.stdout, /Warning: Grok ran without the `read-only` sandbox \(seatbelt unavailable/);
  assert.match(rendered.stdout, /Verdict: needs-attention/, "the review itself is still shown");

  const stateRoot = path.join(pluginData, "state");
  const stateDir = path.join(stateRoot, fs.readdirSync(stateRoot)[0]);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.ok(
    state.jobs.every((job) => /^Warning: ran without the read-only sandbox\./.test(job.summary)),
    "the /grok:status line must carry the warning too"
  );
});

/**
 * Enforced is not the same as covering the tree: the real read-only profile
 * keeps the system temp directories writable, so a checkout under /tmp is
 * fenced by nothing at the OS level even though the profile applied.
 */
test("a sandbox that leaves the repository writable is reported as no fence", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-sandbox-writable-workspace");
  const env = buildEnv(binDir);
  const pluginData = makeTempDir("plugin-data-");
  env.CLAUDE_PLUGIN_DATA = pluginData;
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.sandbox.applied, true);
  assert.equal(payload.sandbox.workspaceWritable, true);
  assert.match(payload.sandbox.detail, /leaves .* writable and this repository is inside it/);

  const rendered = run("node", [SCRIPT, "adversarial-review"], { cwd, env });
  assert.match(rendered.stdout, /Warning: the `read-only` sandbox was enforced, but the read-only profile leaves .* writable/);

  const stateRoot = path.join(pluginData, "state");
  const stateDir = path.join(stateRoot, fs.readdirSync(stateRoot)[0]);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.ok(state.jobs.every((job) => /^Warning: the read-only sandbox did not cover this repository\./.test(job.summary)));
});

/** Each turn is its own process; the one that ran the tools is the one that matters. */
test("the sandbox outcome reported is the worst across a review's turns", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-sandbox-unapplied-first-turn");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);

  assert.equal(grokRuns(binDir).length, 2, "the stub must have been restated");
  assert.equal(payload.result.findings.length, 1, "the restated review is the answer");
  assert.equal(payload.sandbox.applied, false, "but the unfenced first turn is what the report must carry");
});

/** No record is not a clean bill: the reader says so instead of staying quiet. */
test("a review whose sandbox outcome was not recorded says it could not be confirmed", async () => {
  const { renderReviewResult } = await import("../plugins/grok/scripts/lib/render.mjs");
  const rendered = renderReviewResult(
    { parsed: { verdict: "approve", summary: "Fine.", findings: [], next_steps: [] }, parseError: null },
    { reviewLabel: "Adversarial Review", targetLabel: "working tree diff", sandbox: { requested: "read-only", applied: null } }
  );
  assert.match(rendered, /Note: Grok's sandbox event log has no record of whether the `read-only` sandbox was enforced/);
  assert.match(rendered, /Verdict: approve/);
});

/**
 * The tripwire behind the sandbox: the tree is fingerprinted before and after
 * a review, so a run that wrote into it is caught whatever the sandbox did.
 */
test("a review that modified the working tree is flagged", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-writes-file");
  const env = buildEnv(binDir);
  const pluginData = makeTempDir("plugin-data-");
  env.CLAUDE_PLUGIN_DATA = pluginData;
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.workingTreeChanges, ["leaked.txt"]);

  const rendered = run("node", [SCRIPT, "adversarial-review"], { cwd, env });
  assert.match(rendered.stdout, /Warning: the working tree changed while this review ran \(1 path: leaked\.txt\)/);

  const stateRoot = path.join(pluginData, "state");
  const stateDir = path.join(stateRoot, fs.readdirSync(stateRoot)[0]);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.ok(
    state.jobs.every((job) => /^Warning: the working tree changed during the review\./.test(job.summary)),
    "the /grok:status line must carry the warning too"
  );
});

/**
 * Nothing validates the unconstrained answer before the companion sees it, so
 * an object that parses but is not a review must go to the schema-constrained
 * re-emit instead of being rendered as one.
 */
test("a well-formed object that is not a review is re-emitted under the schema", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-wrong-shape");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.parseError, null);
  assert.equal(payload.result.findings.length, 1);

  const [, reemit] = grokRuns(binDir);
  assert.ok(reemit.includes("--json-schema"), "the shape fix is the schema-constrained re-emit");
});

test("adversarial review asks grok to re-emit when nothing parses", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-reemit");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.parseError, null, "the resumed re-emit run should have produced a usable object");
  assert.equal(payload.result.findings.length, 1);

  const [investigation, retry] = grokRuns(binDir);
  assert.ok(retry.includes("--resume"), "the retry must resume the same grok session");
  // The re-emit needs no tools, so it is the one turn where the schema flag is
  // safe — and the guarantee of shape is worth having there.
  assert.ok(!investigation.includes("--json-schema"), "the investigation must not be schema-constrained");
  assert.ok(retry.includes("--json-schema"), "the tool-free re-emit is where the schema is enforced");
  assert.equal(retry[retry.indexOf("--max-turns") + 1], "1");
});

/**
 * The failure that made every adversarial review come back empty: Grok 1.0.13
 * applies `--json-schema` to every assistant message, and under it grok-4.6
 * never calls a tool. It reasons about inspecting the diff, then its message is
 * forced into the schema shape and the turn ends with "review in progress" —
 * and a resumed turn under the same flag repeats the stub, so the restate retry
 * failed the same way. The investigation has to run unconstrained, with the
 * schema carried in the prompt.
 */
test("the investigative review turn runs unconstrained so grok can inspect the diff", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-schema-blind");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);

  assert.equal(payload.parseError, null);
  assert.equal(payload.result.findings.length, 1);

  const runs = grokRuns(binDir);
  assert.equal(runs.length, 1, "a review grok could finish must not need a retry");
  assert.ok(!runs[0].includes("--json-schema"), "the investigative turn must not be schema-constrained");
  // Without --verbatim the CLI truncates a prompt over ~32 KB to its first 20 KB
  // and offloads the rest to a file — which an inline diff regularly exceeds.
  assert.ok(runs[0].includes("--verbatim"), "the review prompt must reach grok whole");

  const prompt = runs[0][runs[0].indexOf("-p") + 1];
  assert.match(prompt, /<output_schema>/, "the schema has to travel in the prompt instead");
  assert.match(prompt, /"needs-attention"/, "the prompt must carry the schema's verdict values");
});

test("task run returns final message and session id", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "task-ok");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "task", "--write", "--json", "fix the failing test"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.rawOutput, /Task completed|Fixed/i);
  assert.ok(payload.threadId);
});

/**
 * Grok only accepts sandbox profiles it actually defines. Passing an unknown
 * one is not a soft failure — the CLI refuses to start, so a wrong name here
 * silently takes down every write-capable rescue run while the flag plumbing
 * still looks correct. `workspace-write` is Codex's name for this and was the
 * original regression; these profiles are the ones Grok recognises.
 */
const GROK_SANDBOX_PROFILES = new Set(["read-only", "workspace", "danger-full-access"]);

function sandboxProfileFrom(binDir) {
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-grok-state.json"), "utf8"));
  const index = state.lastArgs.indexOf("--sandbox");
  return index === -1 ? null : state.lastArgs[index + 1];
}

test("write-capable task requests a sandbox profile grok recognises", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "task-ok");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "task", "--write", "--json", "fix the failing test"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const profile = sandboxProfileFrom(binDir);
  assert.ok(
    GROK_SANDBOX_PROFILES.has(profile),
    `write-capable task passed --sandbox ${profile}, which grok would reject`
  );
  assert.notEqual(profile, "read-only", "a --write task must not run under the read-only profile");
});

test("read-only task requests the read-only sandbox profile", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "task-ok");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [SCRIPT, "task", "--json", "inspect the repo"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(sandboxProfileFrom(binDir), "read-only");
});

function seededTransferPrompt(binDir) {
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-grok-state.json"), "utf8"));
  // A transfer seed is far too long for argv, so it arrives as a file.
  return state.lastPrompt ?? "";
}

function writeTranscript(dir, turns) {
  const transcript = path.join(dir, "session-1.jsonl");
  fs.writeFileSync(transcript, turns.join("\n"));
  return transcript;
}

/**
 * Only the tail of a transcript is seeded into the transferred session, and real
 * Claude transcripts reach tens of megabytes — so the reader must not pull the
 * whole file in to discard nearly all of it. These pin the observable contract:
 * the newest turns survive, the oldest are dropped, and small transcripts still
 * transfer whole.
 */
test("transfer seeds the tail of a large transcript and drops the head", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-ok");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const home = makeTempDir("home-");
  const projectDir = path.join(home, ".claude", "projects", "test-proj");
  fs.mkdirSync(projectDir, { recursive: true });

  // Comfortably past the 120k-char context budget so truncation must kick in.
  const turns = [
    JSON.stringify({ type: "user", message: { role: "user", content: "OLDEST_TURN_MARKER" } })
  ];
  for (let i = 0; i < 400; i += 1) {
    turns.push(
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: `filler ${i} ${"z".repeat(500)}` } })
    );
  }
  turns.push(JSON.stringify({ type: "user", message: { role: "user", content: "NEWEST_TURN_MARKER" } }));
  const transcript = writeTranscript(projectDir, turns);

  const result = run("node", [SCRIPT, "transfer", "--source", transcript, "--json"], {
    cwd,
    env: { ...env, HOME: home }
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const prompt = seededTransferPrompt(binDir);
  assert.ok(prompt.includes("NEWEST_TURN_MARKER"), "most recent turn must be seeded");
  assert.ok(!prompt.includes("OLDEST_TURN_MARKER"), "oldest turn should have been truncated away");
  assert.match(prompt, /\(truncated\)/);
});

test("transfer seeds a small transcript in full", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-ok");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const home = makeTempDir("home-");
  const projectDir = path.join(home, ".claude", "projects", "test-proj");
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = writeTranscript(projectDir, [
    JSON.stringify({ type: "user", message: { role: "user", content: "OLDEST_TURN_MARKER" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "NEWEST_TURN_MARKER" } })
  ]);

  const result = run("node", [SCRIPT, "transfer", "--source", transcript, "--json"], {
    cwd,
    env: { ...env, HOME: home }
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const prompt = seededTransferPrompt(binDir);
  assert.ok(prompt.includes("OLDEST_TURN_MARKER"), "short transcript must be seeded whole");
  assert.ok(prompt.includes("NEWEST_TURN_MARKER"));
  assert.ok(!prompt.includes("(truncated)"));
});

test("status and result track finished jobs", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "task-ok");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  env.GROK_COMPANION_SESSION_ID = "claude-session-1";
  const cwd = prepareRepo();

  const task = run("node", [SCRIPT, "task", "--json", "inspect the repo"], { cwd, env });
  assert.equal(task.status, 0, task.stderr + task.stdout);

  const status = run("node", [SCRIPT, "status", "--json"], { cwd, env });
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.ok(statusPayload.latestFinished || statusPayload.recent?.length >= 0);

  const result = run("node", [SCRIPT, "result", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const resultPayload = JSON.parse(result.stdout);
  assert.ok(resultPayload.job);
});

test("transfer seeds a grok session from a claude transcript", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-ok");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const projects = path.join(env.HOME || process.env.HOME, ".claude", "projects", "test-proj");
  // Use a temp HOME so we control ~/.claude
  const home = makeTempDir("home-");
  const projectDir = path.join(home, ".claude", "projects", "test-proj");
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, "session-1.jsonl");
  fs.writeFileSync(
    transcript,
    [
      JSON.stringify({ type: "user", message: { role: "user", content: "Please fix the flaky test." } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "I will investigate." } })
    ].join("\n")
  );

  const result = run("node", [SCRIPT, "transfer", "--source", transcript, "--json"], {
    cwd,
    env: { ...env, HOME: home }
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.threadId);
  assert.match(payload.resumeCommand, /grok --resume /);
});

test("session lifecycle hook exports session id", () => {
  const envFile = path.join(makeTempDir(), "env.sh");
  fs.writeFileSync(envFile, "");
  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: ROOT,
    env: { ...process.env, CLAUDE_ENV_FILE: envFile },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-123",
      transcript_path: "/tmp/fake.jsonl"
    })
  });
  assert.equal(result.status, 0, result.stderr);
  const content = fs.readFileSync(envFile, "utf8");
  assert.match(content, /GROK_COMPANION_SESSION_ID/);
  assert.match(content, /sess-123/);
});

test("stop review gate allows when disabled", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  const result = run("node", [STOP_HOOK], {
    cwd,
    env,
    input: JSON.stringify({
      cwd,
      last_assistant_message: "I fixed the bug."
    })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
});

test("stop review gate blocks on BLOCK response when enabled", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "stop-block");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], { cwd, env });

  const result = run("node", [STOP_HOOK], {
    cwd,
    env,
    input: JSON.stringify({
      cwd,
      last_assistant_message: "I edited src/main.ts and added a debug assert."
    })
  });
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /BLOCK|debug|issues/i);
});

/**
 * Grok narrates before it answers, so the verdict is rarely the first line of a
 * run's captured output. Anchoring the gate on line one turned "let me check
 * the diff" into an unexpected answer and blocked the session on every pass.
 */
test("stop review gate reads the verdict grok settled on, not its opening narration", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "stop-gate-narrated");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");
  const cwd = prepareRepo();

  run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], { cwd, env });

  const result = run("node", [STOP_HOOK], {
    cwd,
    env,
    input: JSON.stringify({ cwd, last_assistant_message: "Here is the status you asked for." })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "", "a narrated ALLOW must not block the session");
});

/**
 * `grok models` is the source of truth for model ids, and an unrecognised id is
 * a hard CLI error rather than a fall back to the default. The alias table is
 * therefore a compatibility surface with the installed CLI, not a convenience:
 * `grok-build` was carried over from Codex and failed every aliased run.
 */
test("model aliases resolve to a concrete grok model id", async () => {
  const source = fs.readFileSync(path.join(PLUGIN_ROOT, "scripts", "grok-companion.mjs"), "utf8");
  const table = /const MODEL_ALIASES = new Map\(\[([\s\S]*?)\]\);/.exec(source);
  assert.ok(table, "MODEL_ALIASES table not found");

  const targets = [...table[1].matchAll(/\[\s*"[^"]+"\s*,\s*"([^"]+)"\s*\]/g)].map((m) => m[1]);
  assert.ok(targets.length > 0, "expected at least one alias");
  for (const target of targets) {
    assert.match(
      target,
      /^grok-\d/,
      `alias target "${target}" is not a concrete grok model id (check \`grok models\`)`
    );
  }
});

test("buildGrokHeadlessArgs includes resume and disallows writes for read-only", async () => {
  const { buildGrokHeadlessArgs } = await import("../plugins/grok/scripts/lib/grok.mjs");
  const args = buildGrokHeadlessArgs("hello", {
    cwd: "/tmp/project",
    model: "grok-4.5",
    effort: "high",
    resumeSessionId: "abc-123",
    write: false
  });
  assert.ok(args.includes("-p"));
  assert.ok(args.includes("hello"));
  assert.ok(args.includes("--resume"));
  assert.ok(args.includes("abc-123"));
  assert.ok(args.includes("--disallowed-tools"));
  assert.ok(args.includes("-m"));
  assert.ok(args.includes("grok-4.5"));
});

/**
 * The native reviewer builds its own prompt, so the range has to be pinned
 * there too. Handing it only a base branch name is what let it reach for
 * `git diff <base>` and review upstream work the branch merely merged in.
 */
test("native branch review pins the commit range and file list in its prompt", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "review-ok");
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("plugin-data-");

  const cwd = makeTempDir("grok-repo-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.js"), "export const base = 1;\n");
  run("git", ["add", "base.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd });
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd });
  run("git", ["checkout", "-b", "feature/native"], { cwd });
  fs.writeFileSync(path.join(cwd, "feature.js"), "export const feature = 1;\n");
  run("git", ["add", "feature.js"], { cwd });
  run("git", ["commit", "-m", "feature"], { cwd });

  const result = run("node", [SCRIPT, "review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr + result.stdout);

  const mergeBase = run("git", ["merge-base", "HEAD", "origin/main"], { cwd }).stdout.trim();
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-grok-state.json"), "utf8"));
  const prompt = state.lastPrompt;

  assert.match(prompt, new RegExp(`git diff ${mergeBase}\\.\\.HEAD`), "the exact range must be named");
  assert.match(prompt, /Only these 1 file\(s\) are in scope: feature\.js/);
  assert.doesNotMatch(prompt, /Use git to inspect the diff against the base branch\./);
});
