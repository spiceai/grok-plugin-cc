#!/usr/bin/env node
/**
 * Turn a completed iteration into human-reviewable artifacts.
 *
 * `run-evals.mjs` writes machine-shaped output: JSON blobs and a raw argv
 * trace. That is the right shape for regression checking and the wrong shape
 * for a person deciding whether the plugin behaved sensibly. This walks an
 * iteration directory and writes, per run, an `outputs/` folder holding the
 * things a reviewer actually wants to read — what the user saw, exactly what
 * Grok was asked to do, who touched the repo — plus the metadata and benchmark
 * schema the skill-creator eval viewer expects.
 *
 * Usage:
 *   node evals/report.mjs evals/runs/iteration-1
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const VIEWER_CONFIG = { with_plugin: "with_skill", baseline: "without_skill" };

function main() {
  const iterationDir = path.resolve(process.argv[2] ?? "evals/runs/iteration-1");
  if (!fs.existsSync(iterationDir)) {
    throw new Error(`No such iteration directory: ${iterationDir}`);
  }

  const runs = [];
  for (const evalId of fs.readdirSync(iterationDir)) {
    const evalDir = path.join(iterationDir, evalId);
    if (!fs.statSync(evalDir).isDirectory()) {
      continue;
    }
    for (const config of fs.readdirSync(evalDir)) {
      const runDir = path.join(evalDir, config);
      const runFile = path.join(runDir, "run.json");
      const gradingFile = path.join(runDir, "grading.json");
      if (!fs.existsSync(runFile) || !fs.existsSync(gradingFile)) {
        continue;
      }
      const run = JSON.parse(fs.readFileSync(runFile, "utf8"));
      const grading = JSON.parse(fs.readFileSync(gradingFile, "utf8"));
      writeOutputs(runDir, run, grading);
      runs.push({ runDir, run, grading });
    }
  }

  const benchmark = buildViewerBenchmark(runs);
  fs.writeFileSync(path.join(iterationDir, "viewer-benchmark.json"), JSON.stringify(benchmark, null, 2));

  console.log(`Prepared ${runs.length} run(s) in ${iterationDir}`);
  console.log(`Wrote ${path.join(iterationDir, "viewer-benchmark.json")}`);
}

function writeOutputs(runDir, run, grading) {
  const outputs = path.join(runDir, "outputs");
  fs.mkdirSync(outputs, { recursive: true });

  fs.writeFileSync(
    path.join(runDir, "eval_metadata.json"),
    JSON.stringify(
      {
        eval_id: run.eval_id,
        eval_name: grading.eval_name,
        dimension: grading.dimension,
        config: run.config,
        prompt: run.prompt,
        assertions: (grading.expectations ?? []).map((e) => e.text)
      },
      null,
      2
    )
  );

  fs.writeFileSync(path.join(outputs, "01-response.md"), renderResponse(run, grading));
  fs.writeFileSync(path.join(outputs, "02-grok-invocations.md"), renderGrokCalls(grading));
  fs.writeFileSync(path.join(outputs, "03-what-claude-did.md"), renderBehaviour(grading));

  const diff = gitDiff(run.repoRoot);
  if (diff.trim()) {
    fs.writeFileSync(path.join(outputs, "04-repo-diff.txt"), diff);
  }
}

function renderResponse(run, grading) {
  const o = grading.observations ?? {};
  return [
    `# What the user saw`,
    ``,
    `**Eval:** ${grading.eval_name} (\`${run.eval_id}\`, ${grading.dimension})`,
    `**Config:** ${run.config}`,
    `**Prompt:** ${run.prompt}`,
    ``,
    `**Assertions passed:** ${grading.passed}/${grading.total} · ` +
      `${o.claude_turns ?? "?"} turns · ${Math.round((run.durationMs ?? 0) / 1000)}s · ` +
      `$${(run.costUsd ?? 0).toFixed(4)}`,
    ``,
    `---`,
    ``,
    run.result || "_(empty response)_"
  ].join("\n");
}

function renderGrokCalls(grading) {
  const o = grading.observations ?? {};
  const argvs = o.grok_argv ?? [];
  const lines = [`# What the plugin asked Grok to do`, ``];

  if (argvs.length === 0) {
    lines.push(`Grok was never invoked. (${o.grok_invocations_total ?? 0} total CLI calls including \`--version\` probes.)`);
    return lines.join("\n");
  }

  argvs.forEach((argv, i) => {
    lines.push(`## Turn ${i + 1}`, ``, `### Flags`, ``, "```");
    lines.push(argv.filter((t) => t.startsWith("-") || argv[argv.indexOf(t) - 1]?.startsWith("-")).join(" ").slice(0, 2000));
    lines.push("```", ``, `### Full argv`, ``, "```json", JSON.stringify(argv, null, 2), "```", ``);
    const prompt = (o.grok_prompts ?? [])[i];
    if (prompt) {
      lines.push(`### Prompt sent to Grok`, ``, "```", prompt, "```", ``);
    }
  });
  return lines.join("\n");
}

function renderBehaviour(grading) {
  const o = grading.observations ?? {};
  const rows = [
    ["Main-thread tool calls", JSON.stringify(o.main_thread_tool_calls ?? [])],
    ["Read/Grep/Glob before delegating", String(o.main_thread_read_calls_before_delegating ?? 0)],
    ["Subagents spawned", JSON.stringify(o.subagents_spawned ?? [])],
    ["Rescue subagent tool calls", JSON.stringify(o.rescue_subagent_tool_calls ?? [])],
    ["Grok turns", String(o.grok_turns ?? 0)],
    ["Files changed", JSON.stringify(o.files_changed ?? [])],
    ["Claude turns", String(o.claude_turns ?? "?")],
    ["Cost (USD)", String(o.claude_cost_usd ?? "?")]
  ];

  const lines = [`# What Claude did`, ``, `| Signal | Value |`, `|---|---|`];
  for (const [k, v] of rows) {
    lines.push(`| ${k} | \`${v}\` |`);
  }

  lines.push(``, `## Assertions`, ``, `| Result | Assertion | Evidence |`, `|---|---|---|`);
  for (const e of grading.expectations ?? []) {
    lines.push(`| ${e.passed ? "pass" : "**FAIL**"} | ${e.text} | ${String(e.evidence).replace(/\|/g, "\\|").slice(0, 300)} |`);
  }
  return lines.join("\n");
}

function gitDiff(repoRoot) {
  if (!repoRoot || !fs.existsSync(path.join(repoRoot, ".git"))) {
    return "";
  }
  try {
    return execFileSync("git", ["diff", "--stat", "--patch"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: 10 * 1024 * 1024
    });
  } catch {
    return "";
  }
}

/**
 * The eval viewer keys off `configuration: "with_skill" | "without_skill"`
 * exactly, so the plugin-native config names are translated here rather than
 * bent throughout the harness.
 */
function buildViewerBenchmark(runs) {
  const viewerRuns = runs.map(({ run, grading }) => ({
    eval_id: run.eval_id,
    eval_name: grading.eval_name,
    configuration: VIEWER_CONFIG[run.config] ?? run.config,
    run_number: 1,
    result: {
      pass_rate: grading.pass_rate ?? 0,
      passed: grading.passed ?? 0,
      failed: (grading.total ?? 0) - (grading.passed ?? 0),
      total: grading.total ?? 0,
      time_seconds: Number(((run.durationMs ?? 0) / 1000).toFixed(1)),
      tokens: run.totalTokens ?? 0,
      tool_calls: (grading.observations?.main_thread_tool_calls ?? []).length,
      errors: run.isError ? 1 : 0
    },
    expectations: grading.expectations ?? []
  }));

  const summary = {};
  for (const key of ["with_skill", "without_skill"]) {
    const subset = viewerRuns.filter((r) => r.configuration === key);
    if (subset.length === 0) {
      continue;
    }
    summary[key] = {
      pass_rate: stats(subset.map((r) => r.result.pass_rate)),
      time_seconds: stats(subset.map((r) => r.result.time_seconds)),
      tokens: stats(subset.map((r) => r.result.tokens))
    };
  }
  if (summary.with_skill && summary.without_skill) {
    summary.delta = {
      pass_rate: signed(summary.with_skill.pass_rate.mean - summary.without_skill.pass_rate.mean, 2),
      time_seconds: signed(summary.with_skill.time_seconds.mean - summary.without_skill.time_seconds.mean, 1),
      tokens: signed(summary.with_skill.tokens.mean - summary.without_skill.tokens.mean, 0)
    };
  }

  return {
    metadata: {
      skill_name: "grok-plugin",
      timestamp: new Date().toISOString(),
      evals_run: [...new Set(viewerRuns.map((r) => r.eval_id))],
      runs_per_configuration: 1
    },
    runs: viewerRuns,
    run_summary: summary
  };
}

function stats(values) {
  if (values.length === 0) {
    return { mean: 0, stddev: 0 };
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean: Number(mean.toFixed(4)), stddev: Number(Math.sqrt(variance).toFixed(4)) };
}

function signed(value, digits) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

main();
