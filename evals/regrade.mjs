#!/usr/bin/env node
/**
 * Re-grade an already-completed iteration against the current evals.json.
 *
 * Assertions are wrong more often than you would like — they encode a guess
 * about how the plugin works, and that guess can be off even when the plugin is
 * fine. Re-running the sessions to test a corrected assertion would cost real
 * Claude and xAI usage to re-learn something already captured on disk, so this
 * replays grading over the saved transcripts and argv traces instead. Only the
 * fixture tests actually re-execute.
 *
 * Usage:
 *   node evals/regrade.mjs evals/runs/iteration-1
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { gradeRun } from "./grade.mjs";
import { PROVIDERS, materializeEval } from "./providers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function main() {
  const iterationDir = path.resolve(process.argv[2] ?? "evals/runs/iteration-1");
  const suiteFile = process.argv[3] ?? "evals.json";
  const suite = JSON.parse(fs.readFileSync(path.resolve(HERE, suiteFile), "utf8"));
  const byId = new Map(suite.evals.map((e) => [e.id, e]));

  const results = [];
  for (const evalId of fs.readdirSync(iterationDir)) {
    const evalDir = path.join(iterationDir, evalId);
    if (!fs.statSync(evalDir).isDirectory() || !byId.has(evalId)) {
      continue;
    }
    for (const config of fs.readdirSync(evalDir)) {
      const runFile = path.join(evalDir, config, "run.json");
      if (!fs.existsSync(runFile)) {
        continue;
      }
      const run = JSON.parse(fs.readFileSync(runFile, "utf8"));
      const provider = PROVIDERS[run.providerId ?? "grok"] ?? PROVIDERS.grok;
      const grading = gradeRun(materializeEval(byId.get(evalId), provider), run);
      fs.writeFileSync(path.join(evalDir, config, "grading.json"), JSON.stringify(grading, null, 2));
      results.push(grading);
    }
  }

  for (const config of ["with_plugin", "baseline"]) {
    const subset = results.filter((r) => r.config === config);
    if (subset.length === 0) {
      continue;
    }
    const passed = subset.reduce((a, r) => a + r.passed, 0);
    const total = subset.reduce((a, r) => a + r.total, 0);
    console.log(
      `\n${config}: ${passed}/${total} (${((passed / total) * 100).toFixed(0)}%), ` +
        `${subset.filter((r) => r.passed === r.total).length}/${subset.length} evals fully passing`
    );
    for (const r of subset.sort((a, b) => a.eval_id.localeCompare(b.eval_id))) {
      const failed = r.expectations.filter((e) => !e.passed);
      console.log(`  ${failed.length ? "✘" : "✔"} ${r.eval_id}  ${r.passed}/${r.total}`);
      for (const f of failed) {
        console.log(`      ↳ ${f.id}: ${String(f.evidence).slice(0, 150)}`);
      }
    }
  }
  console.log(`\nRe-graded ${results.length} run(s). Run report.mjs to refresh the viewer artifacts.`);
}

main();
