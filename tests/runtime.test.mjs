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

test("adversarial review returns structured findings when schema is used", () => {
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

  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-grok-state.json"), "utf8"));
  assert.ok(state.lastArgs.includes("--resume"), "the retry must resume the same grok session");
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
  const index = state.lastArgs.indexOf("-p");
  return index === -1 ? "" : state.lastArgs[index + 1];
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
