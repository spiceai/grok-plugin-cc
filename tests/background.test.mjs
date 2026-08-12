/**
 * Background-mode and adversarial-review coverage.
 *
 * The rest of the suite runs one companion process at a time, front to back,
 * and that is precisely the shape background mode does not have. Every
 * background run — `/grok:review`, `/grok:adversarial-review`, and
 * `/grok:rescue --background` — is a separate OS process writing into one
 * shared `state.json` and one shared `jobs/` directory, and it can be killed at
 * any moment without ever running its own cleanup. Nothing in a sequential
 * foreground test can observe either fact, which is why the suite stayed green
 * while concurrent jobs deleted each other's records.
 */
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "grok-companion.mjs");

function prepareRepo() {
  const cwd = makeTempDir("grok-bg-repo-");
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "main.ts"), "export const x = 1;\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "src", "main.ts"), "export const x = 2;\n");
  return cwd;
}

function prepareCompanion(behavior = "review-ok", extraEnv = {}) {
  const binDir = makeTempDir("grok-bg-bin-");
  installFakeGrok(binDir, behavior);
  const env = buildEnv(binDir);
  env.CLAUDE_PLUGIN_DATA = makeTempDir("grok-bg-data-");
  env.GROK_COMPANION_SESSION_ID = "claude-session-bg";
  Object.assign(env, extraEnv);
  return { binDir, env, cwd: prepareRepo() };
}

function grokArgv(binDir) {
  return JSON.parse(fs.readFileSync(path.join(binDir, "fake-grok-state.json"), "utf8")).lastArgs;
}

function grokPrompt(binDir) {
  const argv = grokArgv(binDir);
  const index = argv.indexOf("-p");
  return index === -1 ? "" : argv[index + 1];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 20000, intervalMs = 50, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// Shared state under concurrent background jobs
// ---------------------------------------------------------------------------

async function importState(pluginDataDir) {
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  return import(`../plugins/grok/scripts/lib/state.mjs?bg=${encodeURIComponent(pluginDataDir)}`);
}

/**
 * The exact interleaving two background jobs produce: A reads the index, B
 * starts and writes its own record, then A saves the snapshot it read before B
 * existed. A's save must not treat "absent from my snapshot" as "deleted".
 */
test("a background job's write does not erase a job that started after it read state", async () => {
  const dataDir = makeTempDir("grok-race-data-");
  const state = await importState(dataDir);
  const workspace = makeTempDir("grok-race-ws-");

  state.upsertJob(workspace, { id: "review-a", status: "running", jobClass: "review", pid: process.pid });
  const logA = state.resolveJobLogFile(workspace, "review-a");
  fs.writeFileSync(logA, "A progress\n");
  state.upsertJob(workspace, { id: "review-a", logFile: logA });

  // Job A reads the index, exactly as updateState() does before mutating.
  const snapshotTakenByA = state.loadState(workspace);

  // Job B starts in its own process while A is mid-update.
  const logB = state.resolveJobLogFile(workspace, "task-b");
  fs.writeFileSync(logB, "B progress\n");
  state.upsertJob(workspace, { id: "task-b", status: "running", jobClass: "task", pid: process.pid, logFile: logB });
  state.writeJobFile(workspace, "task-b", { id: "task-b", status: "running", logFile: logB });

  // A now saves the snapshot it took before B existed.
  snapshotTakenByA.jobs[0].phase = "reviewing";
  state.saveState(workspace, snapshotTakenByA);

  const ids = state.listJobs(workspace).map((job) => job.id);
  assert.ok(ids.includes("task-b"), `concurrent job was dropped from the index: ${JSON.stringify(ids)}`);
  assert.ok(ids.includes("review-a"));
  assert.equal(fs.existsSync(logB), true, "concurrent job's log was deleted");
  assert.equal(fs.existsSync(state.resolveJobFile(workspace, "task-b")), true, "concurrent job's record was deleted");
});

test("job pruning never evicts a job that is still in flight", async () => {
  const dataDir = makeTempDir("grok-prune-data-");
  const state = await importState(dataDir);
  const workspace = makeTempDir("grok-prune-ws-");

  // A long background review, started before a burst of quick jobs finished.
  const runningLog = state.resolveJobLogFile(workspace, "review-inflight");
  fs.writeFileSync(runningLog, "still reviewing\n");
  state.upsertJob(workspace, {
    id: "review-inflight",
    status: "running",
    jobClass: "review",
    pid: process.pid,
    logFile: runningLog,
    updatedAt: "2020-01-01T00:00:00.000Z"
  });
  state.writeJobFile(workspace, "review-inflight", { id: "review-inflight", status: "running" });

  for (let index = 0; index < 60; index += 1) {
    const id = `done-${index}`;
    const logFile = state.resolveJobLogFile(workspace, id);
    fs.writeFileSync(logFile, "done\n");
    state.upsertJob(workspace, {
      id,
      status: "completed",
      logFile,
      updatedAt: `2026-01-01T00:${String(index % 60).padStart(2, "0")}:00.000Z`
    });
  }

  const jobs = state.listJobs(workspace);
  assert.ok(
    jobs.some((job) => job.id === "review-inflight"),
    "an in-flight background job was evicted by the job cap"
  );
  assert.equal(fs.existsSync(runningLog), true, "an in-flight background job's log was deleted");
  assert.equal(fs.existsSync(state.resolveJobFile(workspace, "review-inflight")), true);
});

test("job pruning still evicts the oldest finished jobs once the cap is reached", async () => {
  const dataDir = makeTempDir("grok-prune2-data-");
  const state = await importState(dataDir);
  const workspace = makeTempDir("grok-prune2-ws-");

  for (let index = 0; index < 60; index += 1) {
    const id = `done-${String(index).padStart(2, "0")}`;
    const logFile = state.resolveJobLogFile(workspace, id);
    fs.writeFileSync(logFile, "done\n");
    state.upsertJob(workspace, {
      id,
      status: "completed",
      logFile,
      updatedAt: `2026-01-01T00:${String(index).padStart(2, "0")}:00.000Z`
    });
  }

  const jobs = state.listJobs(workspace);
  assert.equal(jobs.length, 50, "the cap must still bound the index");
  assert.ok(!jobs.some((job) => job.id === "done-00"), "the oldest finished job should have been pruned");
  assert.equal(fs.existsSync(state.resolveJobLogFile(workspace, "done-00")), false);
});

// ---------------------------------------------------------------------------
// Killed background jobs
// ---------------------------------------------------------------------------

const DEAD_PID = 0x7ffffff0; // Far above any live pid on the platforms we target.

function jobControl() {
  return import("../plugins/grok/scripts/lib/job-control.mjs");
}

test("a background job whose process died is no longer reported as running", async () => {
  const { reconcileJob, isOrphanedJob } = await jobControl();
  const killed = { id: "review-1", status: "running", phase: "reviewing", jobClass: "review", pid: DEAD_PID };

  assert.equal(isOrphanedJob(killed), true);
  const reconciled = reconcileJob(killed);
  assert.equal(reconciled.status, "failed");
  assert.equal(reconciled.phase, "orphaned");
  assert.equal(reconciled.pid, null);
  assert.match(reconciled.errorMessage, /killed|exited/i);
});

/**
 * The guard on the fix above: a job that really is running must keep running.
 * Reconciling too eagerly would be worse than not reconciling at all, because
 * it would report live reviews as dead and hand `/grok:result` half a run.
 */
test("a background job whose process is alive keeps its running status", async () => {
  const { reconcileJob, isOrphanedJob } = await jobControl();
  const live = { id: "review-2", status: "running", phase: "reviewing", jobClass: "review", pid: process.pid };

  assert.equal(isOrphanedJob(live), false);
  assert.deepEqual(reconcileJob(live), live);
});

test("a job with no recorded pid is left alone rather than presumed dead", async () => {
  const { isOrphanedJob } = await jobControl();
  assert.equal(isOrphanedJob({ id: "review-3", status: "running", pid: null }), false);
  assert.equal(isOrphanedJob({ id: "review-4", status: "running" }), false);
  assert.equal(isOrphanedJob({ id: "review-5", status: "completed", pid: DEAD_PID }), false);
});

test("a killed background job is not a cancel target, so cancel cannot signal a recycled pid", async () => {
  const dataDir = makeTempDir("grok-cancel-data-");
  const state = await importState(dataDir);
  const { resolveCancelableJob } = await jobControl();
  const workspace = makeTempDir("grok-cancel-ws-");
  const env = { GROK_COMPANION_SESSION_ID: "claude-session-bg" };

  state.upsertJob(workspace, {
    id: "review-killed",
    status: "running",
    jobClass: "review",
    pid: DEAD_PID,
    sessionId: "claude-session-bg"
  });

  assert.throws(
    () => resolveCancelableJob(workspace, "", { env }),
    /No active Grok jobs to cancel/,
    "a dead job stayed cancelable, so /grok:cancel would SIGTERM whatever now owns that pid"
  );
});

test("a killed background job stops shadowing the live one in cancel selection", async () => {
  const dataDir = makeTempDir("grok-cancel2-data-");
  const state = await importState(dataDir);
  const { resolveCancelableJob } = await jobControl();
  const workspace = makeTempDir("grok-cancel2-ws-");
  const env = { GROK_COMPANION_SESSION_ID: "claude-session-bg" };

  state.upsertJob(workspace, {
    id: "review-killed",
    status: "running",
    jobClass: "review",
    pid: DEAD_PID,
    sessionId: "claude-session-bg"
  });
  state.upsertJob(workspace, {
    id: "review-live",
    status: "running",
    jobClass: "review",
    pid: process.pid,
    sessionId: "claude-session-bg"
  });

  // Previously this threw "Multiple Grok jobs are active", forcing the user to
  // hunt for an id because of a job that ended hours ago.
  assert.equal(resolveCancelableJob(workspace, "", { env }).job.id, "review-live");
});

test("a killed background task no longer blocks the next rescue from resuming", async () => {
  const { env, cwd } = prepareCompanion("task-ok");

  const first = run("node", [SCRIPT, "task", "--json", "inspect the repo"], { cwd, env });
  assert.equal(first.status, 0, first.stderr);

  // Freeze a killed background task on top of the finished one.
  const workspaceState = JSON.parse(first.stdout);
  assert.ok(workspaceState.threadId);

  const stateDir = fs
    .readdirSync(path.join(env.CLAUDE_PLUGIN_DATA, "state"))
    .map((entry) => path.join(env.CLAUDE_PLUGIN_DATA, "state", entry))[0];
  const stateFile = path.join(stateDir, "state.json");
  const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  parsed.jobs.unshift({
    id: "task-killed",
    status: "running",
    jobClass: "task",
    pid: DEAD_PID,
    sessionId: env.GROK_COMPANION_SESSION_ID,
    updatedAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2099-01-01T00:00:00.000Z"
  });
  fs.writeFileSync(stateFile, JSON.stringify(parsed, null, 2));

  const resumed = run("node", [SCRIPT, "task", "--resume-last", "--json"], { cwd, env });
  assert.equal(
    resumed.status,
    0,
    `a killed background task blocked resume forever: ${resumed.stderr}`
  );
});

test("a killed background review becomes retrievable through /grok:result", async () => {
  const dataDir = makeTempDir("grok-result-data-");
  const state = await importState(dataDir);
  const { resolveResultJob } = await jobControl();
  const workspace = makeTempDir("grok-result-ws-");

  state.upsertJob(workspace, {
    id: "review-killed",
    status: "running",
    jobClass: "review",
    pid: DEAD_PID,
    sessionId: "claude-session-bg"
  });

  const { job } = resolveResultJob(workspace, "review-killed");
  assert.equal(job.status, "failed");
  assert.match(job.errorMessage, /killed|exited/i);
});

// ---------------------------------------------------------------------------
// End-to-end background runs
// ---------------------------------------------------------------------------

test("a background adversarial review killed mid-flight is reported as failed, not running", async () => {
  const startedFile = path.join(makeTempDir("grok-hang-"), "started");
  const { env, cwd } = prepareCompanion("hang", { FAKE_GROK_STARTED_FILE: startedFile });

  const child = spawn("node", [SCRIPT, "adversarial-review", "--json"], {
    cwd,
    env,
    detached: true,
    stdio: "ignore"
  });

  try {
    await waitFor(() => fs.existsSync(startedFile), { label: "the background review to start" });

    const midFlight = run("node", [SCRIPT, "status", "--json"], { cwd, env });
    assert.equal(midFlight.status, 0, midFlight.stderr);
    const inFlight = JSON.parse(midFlight.stdout).running;
    assert.equal(inFlight.length, 1, "an in-flight background review should be reported as running");
    // Progress is the entire point of a detached run: without it `/grok:status`
    // can only say "running", which is what the user already knew.
    assert.ok(
      inFlight[0].progressPreview.length > 0,
      "a running background review exposed no progress to /grok:status"
    );

    process.kill(-child.pid, "SIGKILL");
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, {
      label: "the background review process to die"
    });

    const afterKill = run("node", [SCRIPT, "status", "--json"], { cwd, env });
    assert.equal(afterKill.status, 0, afterKill.stderr);
    const snapshot = JSON.parse(afterKill.stdout);
    assert.equal(
      snapshot.running.length,
      0,
      "a killed background review kept reporting as running, so /grok:status never settles"
    );
    assert.equal(snapshot.latestFinished?.status, "failed");
    assert.equal(snapshot.latestFinished?.phase, "orphaned");
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

test("/grok:cancel stops a running background adversarial review", async () => {
  const startedFile = path.join(makeTempDir("grok-cancel-e2e-"), "started");
  const { env, cwd } = prepareCompanion("hang", { FAKE_GROK_STARTED_FILE: startedFile });

  const child = spawn("node", [SCRIPT, "adversarial-review", "--json"], {
    cwd,
    env,
    detached: true,
    stdio: "ignore"
  });

  try {
    await waitFor(() => fs.existsSync(startedFile), { label: "the background review to start" });

    const cancelled = run("node", [SCRIPT, "cancel", "--json"], { cwd, env });
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");

    await waitFor(() => child.exitCode !== null || child.signalCode !== null, {
      label: "the cancelled review process to exit"
    });

    const status = run("node", [SCRIPT, "status", "--json"], { cwd, env });
    assert.equal(status.status, 0, status.stderr);
    const snapshot = JSON.parse(status.stdout);
    assert.equal(snapshot.running.length, 0, "a cancelled review is still listed as running");
    assert.equal(snapshot.latestFinished?.status, "cancelled");
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

test("concurrent background reviews all survive in the job index", async () => {
  const { env, cwd } = prepareCompanion("review-ok");
  const CONCURRENT = 3;

  const children = Array.from({ length: CONCURRENT }, (_, index) =>
    spawn("node", [SCRIPT, "adversarial-review", "--json", `focus ${index}`], { cwd, env, stdio: "ignore" })
  );

  await Promise.all(
    children.map(
      (child) =>
        new Promise((resolve, reject) => {
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`review exited ${code}`))));
          child.on("error", reject);
        })
    )
  );

  const status = run("node", [SCRIPT, "status", "--all", "--json"], { cwd, env });
  assert.equal(status.status, 0, status.stderr);
  const snapshot = JSON.parse(status.stdout);
  const finished = [snapshot.latestFinished, ...snapshot.recent].filter(Boolean);

  assert.equal(
    finished.length,
    CONCURRENT,
    `expected ${CONCURRENT} background reviews in the index, found ${finished.length} — concurrent runs deleted each other`
  );
  for (const job of finished) {
    assert.equal(job.status, "completed");
  }
});

test("a failing background adversarial review is recorded as failed and its error is retrievable", async () => {
  const { env, cwd } = prepareCompanion("review-fail");

  const review = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.notEqual(review.status, 0, "a failed Grok review must not exit 0");

  const status = run("node", [SCRIPT, "status", "--json"], { cwd, env });
  assert.equal(status.status, 0, status.stderr);
  const snapshot = JSON.parse(status.stdout);
  assert.equal(snapshot.running.length, 0);
  assert.equal(snapshot.latestFinished?.status, "failed");

  const result = run("node", [SCRIPT, "result", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.status, "failed");
});

test("status --wait blocks until a slow background review finishes", async () => {
  const { env, cwd } = prepareCompanion("slow-review", { FAKE_GROK_SLEEP_MS: "1500" });

  const child = spawn("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env, stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", resolve));

  let jobId = null;
  await waitFor(
    () => {
      const status = run("node", [SCRIPT, "status", "--json"], { cwd, env });
      if (status.status !== 0) {
        return false;
      }
      jobId = JSON.parse(status.stdout).running[0]?.id ?? null;
      return Boolean(jobId);
    },
    { label: "the slow background review to register" }
  );

  const waited = run("node", [SCRIPT, "status", jobId, "--wait", "--poll-interval-ms", "100", "--json"], {
    cwd,
    env
  });
  assert.equal(waited.status, 0, waited.stderr);
  const snapshot = JSON.parse(waited.stdout);
  assert.equal(snapshot.waitTimedOut, false, "--wait returned while the review was still running");
  assert.equal(snapshot.job.status, "completed");

  await exited;
});

// ---------------------------------------------------------------------------
// Adversarial review: flags, hostile focus text, and degenerate targets
// ---------------------------------------------------------------------------

/**
 * `--background` is consumed by the companion but deliberately does nothing —
 * Claude Code's `Bash(run_in_background: true)` is what detaches the run. The
 * flag still has to be swallowed, because focus text is positional: a
 * `--background` that stops being a known boolean silently becomes part of the
 * review instructions Grok reads.
 */
test("adversarial review consumes --background without leaking it into the prompt", () => {
  const { binDir, env, cwd } = prepareCompanion("review-ok");

  const result = run("node", [SCRIPT, "adversarial-review", "--background focus on auth"], { cwd, env });
  assert.equal(result.status, 0, result.stderr);

  const prompt = grokPrompt(binDir);
  assert.ok(!prompt.includes("--background"), "--background leaked into the review prompt");
  assert.ok(prompt.includes("focus on auth"), "focus text was lost");
});

test("adversarial review runs under the read-only sandbox even with focus text", () => {
  const { binDir, env, cwd } = prepareCompanion("review-ok");

  const result = run("node", [SCRIPT, "adversarial-review", "--json rewrite the auth module"], { cwd, env });
  assert.equal(result.status, 0, result.stderr);

  const argv = grokArgv(binDir);
  const sandbox = argv[argv.indexOf("--sandbox") + 1];
  assert.equal(sandbox, "read-only", "a review must never be able to write to the user's tree");
  assert.ok(argv.includes("--disallowed-tools"));
  assert.match(argv[argv.indexOf("--disallowed-tools") + 1], /search_replace/);
});

/**
 * Focus text is user input spliced into a `{{PLACEHOLDER}}` template. If it
 * were expanded, a focus string naming a placeholder could inject or blank out
 * the review instructions around it.
 */
test("template placeholders inside focus text are passed through literally", () => {
  const { binDir, env, cwd } = prepareCompanion("review-ok");

  const result = run("node", [SCRIPT, "adversarial-review", "--json {{REVIEW_INPUT}} {{USER_FOCUS}}"], { cwd, env });
  assert.equal(result.status, 0, result.stderr);

  const prompt = grokPrompt(binDir);
  assert.ok(prompt.includes("{{REVIEW_INPUT}}"), "placeholder in focus text was expanded");
  assert.ok(prompt.includes("<operating_stance>"), "review instructions were damaged by the focus text");
});

test("quoted, escaped and unicode focus text survives argument splitting", () => {
  const { binDir, env, cwd } = prepareCompanion("review-ok");

  const focus = `"tenant isolation" and 'race conditions' — 日本語 \\--not-a-flag`;
  const result = run("node", [SCRIPT, "adversarial-review", `--json ${focus}`], { cwd, env });
  assert.equal(result.status, 0, result.stderr);

  const prompt = grokPrompt(binDir);
  assert.ok(prompt.includes("tenant isolation"));
  assert.ok(prompt.includes("race conditions"));
  assert.ok(prompt.includes("日本語"));
  assert.ok(prompt.includes("--not-a-flag"), "escaped flag-like focus text was swallowed");
});

test("unknown flag-shaped focus text stays focus text instead of being parsed away", () => {
  const { binDir, env, cwd } = prepareCompanion("review-ok");

  const result = run("node", [SCRIPT, "adversarial-review", "--json --check-idempotency"], { cwd, env });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(grokPrompt(binDir).includes("--check-idempotency"));
});

test("adversarial review outside a git repository fails with an actionable message", () => {
  const { env } = prepareCompanion("review-ok");
  const cwd = makeTempDir("grok-nogit-");

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must run inside a Git repository/i);
});

test("a review target with no changes still completes rather than crashing", () => {
  const { env } = prepareCompanion("review-ok");
  const cwd = makeTempDir("grok-clean-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.txt"), "hi\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const result = run("node", [SCRIPT, "adversarial-review", "--json"], { cwd, env });
  assert.equal(result.status, 0, result.stderr);
});

/**
 * The prompt tells Grok which verdict strings to use and the schema constrains
 * what it may emit. If the two drift apart the CLI rejects the model's output
 * and the review comes back empty — a failure that only shows up against the
 * live CLI, never against a fixture.
 */
test("verdicts named in the adversarial prompt match the shipped output schema", () => {
  const prompt = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", "adversarial-review.md"), "utf8");
  const schema = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"), "utf8")
  );
  const allowed = new Set(schema.properties.verdict.enum);

  const instructed = [...prompt.matchAll(/Use `([a-z-]+)`/g)].map((match) => match[1]);
  assert.ok(instructed.length > 0, "prompt no longer names any verdict");
  for (const verdict of instructed) {
    assert.ok(allowed.has(verdict), `prompt instructs verdict "${verdict}", which the schema rejects`);
  }
  for (const verdict of allowed) {
    assert.ok(prompt.includes(`\`${verdict}\``), `schema allows "${verdict}" but the prompt never mentions it`);
  }
});

test("an ambiguous job id prefix is rejected instead of resolved to the wrong job", async () => {
  const dataDir = makeTempDir("grok-ambig-data-");
  const state = await importState(dataDir);
  const { buildSingleJobSnapshot } = await jobControl();
  const workspace = makeTempDir("grok-ambig-ws-");

  state.upsertJob(workspace, { id: "review-abc123", status: "completed", jobClass: "review" });
  state.upsertJob(workspace, { id: "review-abc456", status: "completed", jobClass: "review" });

  assert.throws(() => buildSingleJobSnapshot(workspace, "review-abc"), /ambiguous/i);
  assert.equal(buildSingleJobSnapshot(workspace, "review-abc123").job.id, "review-abc123");
});
