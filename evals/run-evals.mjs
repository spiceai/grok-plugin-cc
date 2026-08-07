#!/usr/bin/env node
/**
 * Grok plugin eval harness.
 *
 * Each eval is a real `claude -p` session run inside a throwaway git repo, with
 * this repo's `evals/bin/grok` shim ahead of the real Grok CLI on PATH. The
 * shim records argv and then execs the real binary, so Grok genuinely does the
 * work while we still get to grade the exact arguments the plugin constructed.
 *
 * Usage:
 *   node evals/run-evals.mjs                          # all evals, with-plugin + baseline
 *   node evals/run-evals.mjs --eval slash-review-no-autofix
 *   node evals/run-evals.mjs --config with_plugin --iteration 2
 *   node evals/run-evals.mjs --model opus --concurrency 2
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildFixture } from "./lib/fixture.mjs";
import { gradeRun } from "./grade.mjs";
import { PROVIDERS, materializeEval } from "./providers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");
const SHIM_DIR = path.join(HERE, "bin");

const CONFIGS = {
  with_plugin: { label: "with_plugin", loadPlugin: true },
  baseline: { label: "baseline", loadPlugin: false }
};

/**
 * Settings that switch off every plugin the developer has installed, so a
 * session sees only what `--plugin-dir` gives it.
 *
 * Without this the harness silently measures the wrong thing. A `claude -p`
 * subprocess inherits user settings, so an installed copy of this same plugin
 * stays enabled even in the baseline config — which then runs the *released*
 * plugin rather than no plugin at all, and quietly reports a pass rate for it.
 * That also invalidates `no-hijack-trivial-task`, whose whole argument is that
 * the baseline cannot reach Grok.
 *
 * `--settings` wins over user settings and leaves auth alone, which is why this
 * is done here rather than by redirecting CLAUDE_CONFIG_DIR (that loses the
 * login and every session fails).
 */
function buildPluginIsolationSettings() {
  const disabled = {};
  // Known provider surfaces, in case the settings file cannot be read at all.
  for (const name of ["grok@spicehq", "codex@spicehq"]) {
    disabled[name] = false;
  }
  for (const dir of [process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), ".claude")].filter(Boolean)) {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
      for (const name of Object.keys(settings.enabledPlugins ?? {})) {
        disabled[name] = false;
      }
    } catch {
      // No readable settings file here; the defaults above still apply.
    }
  }
  return JSON.stringify({ enabledPlugins: disabled });
}

const PLUGIN_ISOLATION_SETTINGS = buildPluginIsolationSettings();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const provider = PROVIDERS[options.provider];
  if (!provider) {
    throw new Error(`Unknown provider: ${options.provider}. Known: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  const suite = JSON.parse(fs.readFileSync(path.resolve(HERE, options.suite), "utf8"));

  const rawSelected = options.evalIds.length
    ? suite.evals.filter((e) => options.evalIds.includes(e.id))
    : suite.evals;
  const selected = rawSelected.map((e) => materializeEval(e, provider));
  if (selected.length === 0) {
    throw new Error(`No evals matched ${JSON.stringify(options.evalIds)}`);
  }

  const configs = options.configs.map((name) => {
    if (!CONFIGS[name]) {
      throw new Error(`Unknown config: ${name}`);
    }
    return CONFIGS[name];
  });

  const iterationDir = path.join(
    options.workspace,
    options.provider === "grok" ? `iteration-${options.iteration}` : `iteration-${options.iteration}-${options.provider}`
  );
  fs.mkdirSync(iterationDir, { recursive: true });

  const jobs = [];
  for (const evalDef of selected) {
    for (const config of configs) {
      jobs.push({ evalDef, config });
    }
  }

  const realBin = options.realBin ?? provider.defaultRealBin;
  console.log(
    `Running ${jobs.length} job(s): ${selected.length} eval(s) × ${configs.length} config(s)\n` +
      `  provider:    ${provider.label}\n` +
      `  suite:       ${options.suite}\n` +
      `  model:       ${options.model}\n` +
      `  cli binary:  ${realBin}\n` +
      `  plugin:      ${provider.pluginDir}\n` +
      `  workspace:   ${iterationDir}\n` +
      `  concurrency: ${options.concurrency}\n`
  );

  const results = await runPool(jobs, options.concurrency, async (job) => {
    const runDir = path.join(iterationDir, job.evalDef.id, job.config.label);
    fs.mkdirSync(runDir, { recursive: true });
    process.stdout.write(`  ▶ ${job.evalDef.id} [${job.config.label}] …\n`);

    const run = await runOne(job.evalDef, job.config, runDir, { ...options, provider, realBin });
    const grading = gradeRun(job.evalDef, run);

    fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify(run, null, 2));
    fs.writeFileSync(path.join(runDir, "grading.json"), JSON.stringify(grading, null, 2));

    process.stdout.write(
      `  ${grading.passed === grading.total ? "✔" : "✘"} ${job.evalDef.id} [${job.config.label}] ` +
        `${grading.passed}/${grading.total} assertions in ${Math.round((run.durationMs ?? 0) / 1000)}s\n`
    );
    return grading;
  });

  const summary = summarize(suite, selected, results);
  fs.writeFileSync(path.join(iterationDir, "benchmark.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(iterationDir, "benchmark.md"), renderMarkdown(summary));
  console.log(`\n${renderMarkdown(summary)}`);
  console.log(`Wrote ${path.join(iterationDir, "benchmark.json")}`);
}

/**
 * Run a single `claude -p` session for one eval in one configuration.
 */
async function runOne(evalDef, config, runDir, options) {
  const repoRoot = path.join(runDir, "repo");
  const { snapshot } = buildFixture(evalDef.fixture, repoRoot);

  const traceLogPath = path.join(runDir, "grok-calls.jsonl");
  fs.writeFileSync(traceLogPath, "");

  const provider = options.provider;
  const baseArgs = [
    "--model",
    options.model,
    "--permission-mode",
    "bypassPermissions",
    "--output-format",
    "json",
    // Both configs, not just baseline: with an installed copy also enabled it is
    // ambiguous which one served the session, so the with-plugin column stops
    // being a measurement of the working tree.
    "--settings",
    PLUGIN_ISOLATION_SETTINGS
  ];
  if (config.loadPlugin) {
    baseArgs.push("--plugin-dir", provider.pluginDir);
  }

  const env = {
    ...process.env,
    PATH: `${SHIM_DIR}${path.delimiter}${process.env.PATH}`,
    EVAL_TRACE_LOG: traceLogPath,
    [provider.realBinEnvVar]: options.realBin,
    ...provider.extraEnv(SHIM_DIR)
  };
  delete env.ANTHROPIC_API_KEY;

  const started = Date.now();
  const proc = await spawnCapture("claude", ["-p", evalDef.prompt, ...baseArgs], {
    cwd: repoRoot,
    env,
    timeoutMs: options.timeoutMs
  });

  fs.writeFileSync(path.join(runDir, "stdout.json"), proc.stdout);
  if (proc.stderr.trim()) {
    fs.writeFileSync(path.join(runDir, "stderr.txt"), proc.stderr);
  }

  let payload = {};
  try {
    payload = JSON.parse(proc.stdout);
  } catch {
    payload = { result: proc.stdout, parse_error: true };
  }

  // Some behaviours only show up on the turn *after* the tool ran — most
  // importantly whether a review quietly applies fixes once the user invites
  // one. Resuming the same session is the only way to observe that.
  if (evalDef.followup && payload.session_id) {
    const followup = await spawnCapture(
      "claude",
      ["-p", evalDef.followup, "--resume", payload.session_id, ...baseArgs],
      { cwd: repoRoot, env, timeoutMs: options.timeoutMs }
    );
    fs.writeFileSync(path.join(runDir, "stdout-followup.json"), followup.stdout);
    try {
      const second = JSON.parse(followup.stdout);
      payload.result = `${payload.result ?? ""}\n\n--- follow-up turn ---\n\n${second.result ?? ""}`;
      payload.num_turns = (payload.num_turns ?? 0) + (second.num_turns ?? 0);
      payload.total_cost_usd = (payload.total_cost_usd ?? 0) + (second.total_cost_usd ?? 0);
    } catch {
      // Keep the first turn's payload; grading still sees the initial result.
    }
  }

  const durationMs = Date.now() - started;

  return {
    eval_id: evalDef.id,
    config: config.label,
    providerId: provider.id,
    prompt: evalDef.prompt,
    repoRoot,
    traceLogPath,
    snapshot,
    sessionId: payload.session_id ?? null,
    result: payload.result ?? "",
    numTurns: payload.num_turns ?? null,
    costUsd: payload.total_cost_usd ?? null,
    totalTokens: totalTokens(payload.usage),
    isError: payload.is_error ?? proc.code !== 0,
    exitCode: proc.code,
    timedOut: proc.timedOut,
    durationMs
  };
}

function totalTokens(usage) {
  if (!usage) {
    return null;
  }
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

function spawnCapture(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index]);
      } catch (error) {
        results[index] = {
          eval_id: items[index].evalDef.id,
          config: items[index].config.label,
          passed: 0,
          total: (items[index].evalDef.assertions ?? []).length,
          pass_rate: 0,
          expectations: [],
          error: error.message
        };
        process.stdout.write(`  ✘ ${items[index].evalDef.id} [${items[index].config.label}] errored: ${error.message}\n`);
      }
    }
  });
  await Promise.all(runners);
  return results;
}

function summarize(suite, selected, results) {
  const byConfig = {};
  for (const r of results) {
    const bucket = (byConfig[r.config] ??= { config: r.config, passed: 0, total: 0, evals: [] });
    bucket.passed += r.passed;
    bucket.total += r.total;
    bucket.evals.push(r);
  }
  for (const bucket of Object.values(byConfig)) {
    bucket.pass_rate = bucket.total ? bucket.passed / bucket.total : 0;
    bucket.evals_fully_passing = bucket.evals.filter((e) => e.total > 0 && e.passed === e.total).length;
  }

  const byDimension = {};
  for (const r of results.filter((r) => r.config === "with_plugin")) {
    const dim = r.dimension ?? "unknown";
    const bucket = (byDimension[dim] ??= { dimension: dim, passed: 0, total: 0 });
    bucket.passed += r.passed;
    bucket.total += r.total;
  }
  for (const bucket of Object.values(byDimension)) {
    bucket.pass_rate = bucket.total ? bucket.passed / bucket.total : 0;
  }

  return {
    plugin_name: suite.plugin_name,
    eval_count: selected.length,
    configs: Object.values(byConfig),
    dimensions: Object.values(byDimension),
    results
  };
}

function renderMarkdown(summary) {
  const lines = [`# Grok plugin eval results`, ""];

  lines.push("| Config | Assertions passed | Pass rate | Evals fully passing |", "|---|---|---|---|");
  for (const c of summary.configs) {
    lines.push(
      `| ${c.config} | ${c.passed}/${c.total} | ${(c.pass_rate * 100).toFixed(0)}% | ${c.evals_fully_passing}/${c.evals.length} |`
    );
  }

  lines.push("", "## With-plugin, by dimension", "", "| Dimension | Passed | Pass rate |", "|---|---|---|");
  for (const d of summary.dimensions) {
    lines.push(`| ${d.dimension} | ${d.passed}/${d.total} | ${(d.pass_rate * 100).toFixed(0)}% |`);
  }

  lines.push("", "## Per eval", "", "| Eval | Config | Passed | Failed assertions |", "|---|---|---|---|");
  for (const r of summary.results) {
    const failed = (r.expectations ?? []).filter((e) => !e.passed).map((e) => e.id);
    lines.push(
      `| ${r.eval_id} | ${r.config} | ${r.passed}/${r.total} | ${failed.length ? failed.join(", ") : "—"} |`
    );
  }

  return lines.join("\n");
}

function parseArgs(argv) {
  const options = {
    evalIds: [],
    configs: ["with_plugin", "baseline"],
    iteration: 1,
    model: "sonnet",
    concurrency: 3,
    timeoutMs: 900_000,
    provider: "grok",
    suite: "evals.json",
    realBin: null,
    workspace: path.join(REPO_ROOT, "evals", "runs")
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case "--eval":
        options.evalIds.push(next());
        break;
      case "--config":
        options.configs = next().split(",");
        break;
      case "--iteration":
        options.iteration = Number(next());
        break;
      case "--model":
        options.model = next();
        break;
      case "--concurrency":
        options.concurrency = Number(next());
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(next());
        break;
      case "--provider":
        options.provider = next();
        break;
      case "--suite":
        options.suite = next();
        break;
      case "--grok-bin":
      case "--cli-bin":
        options.realBin = next();
        break;
      case "--workspace":
        options.workspace = path.resolve(next());
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
