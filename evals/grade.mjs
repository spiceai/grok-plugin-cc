import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { diffSnapshots, snapshotTree } from "./lib/fixture.mjs";
import { PROVIDERS } from "./providers.mjs";
import {
  argvHasSequence,
  assistantText,
  collectRunArtifacts,
  grokPrompt,
  toolResultText
} from "./lib/transcript.mjs";

/**
 * Grade one completed run against its eval's assertions.
 *
 * Every check is programmatic. Nothing here asks a model for an opinion, so a
 * pass rate moving between iterations means behaviour moved, not that a judge
 * felt differently that day.
 *
 * @param {object} evalDef
 * @param {object} run  result of runEval()
 */
export function gradeRun(evalDef, run) {
  const provider = PROVIDERS[run.providerId ?? "grok"] ?? PROVIDERS.grok;
  const artifacts = collectRunArtifacts(run.sessionId, run.traceLogPath, provider.isCliInvocation);
  const afterSnapshot = fs.existsSync(run.repoRoot) ? snapshotTree(run.repoRoot) : {};
  const fileDiff = diffSnapshots(run.snapshot ?? {}, afterSnapshot);
  const responseText = [run.result ?? "", assistantText(artifacts.main)].join("\n");
  const helperText = toolResultText(artifacts.main);

  const context = { evalDef, run, artifacts, fileDiff, responseText, helperText };

  const expectations = (evalDef.assertions ?? []).map((assertion) => {
    let outcome;
    try {
      outcome = runCheck(assertion, context);
    } catch (error) {
      outcome = { passed: false, evidence: `Check errored: ${error.message}` };
    }
    return {
      id: assertion.id,
      text: assertion.text,
      passed: outcome.passed,
      evidence: outcome.evidence
    };
  });

  const passed = expectations.filter((e) => e.passed).length;

  return {
    eval_id: evalDef.id,
    eval_name: evalDef.name,
    dimension: evalDef.dimension,
    config: run.config,
    passed,
    total: expectations.length,
    pass_rate: expectations.length ? passed / expectations.length : 0,
    expectations,
    observations: observe(context)
  };
}

/**
 * Numbers worth watching that are not pass/fail. Main-thread pre-work is the
 * big one: the plugin only forbids the *subagent* from digging through the
 * repo, but if the main thread reads half the codebase before delegating, the
 * user still pays for it twice.
 */
function observe({ artifacts, run, fileDiff }) {
  const mainReadish = artifacts.mainToolCalls.filter((t) =>
    ["Read", "Grep", "Glob"].includes(t.name)
  ).length;
  const rescue = artifacts.subagents.filter((s) => s.agentType === "grok:grok-rescue");

  return {
    main_thread_read_calls_before_delegating: mainReadish,
    main_thread_tool_calls: artifacts.mainToolCalls.map((t) => t.name),
    subagents_spawned: artifacts.subagents.map((s) => s.agentType),
    rescue_subagent_tool_calls: rescue.flatMap((s) => s.toolCalls.map((t) => t.name)),
    grok_invocations_total: artifacts.grokCalls.length,
    grok_turns: artifacts.grokTurns.length,
    grok_argv: artifacts.grokTurns.map((c) => redactPrompt(c.argv)),
    grok_prompts: artifacts.grokTurns.map((c) => grokPrompt(c)),
    files_changed: fileDiff.changed,
    claude_turns: run.numTurns ?? null,
    claude_cost_usd: run.costUsd ?? null,
    duration_ms: run.durationMs ?? null,
    transcript_path: artifacts.transcriptPath
  };
}

/** Keep argv readable in reports: prompts can be thousands of characters. */
function redactPrompt(argv) {
  return argv.map((token, i) =>
    (argv[i - 1] === "-p" || argv[i - 1] === "--single") && token.length > 120
      ? `${token.slice(0, 120)}… (${token.length} chars)`
      : token
  );
}

function runCheck(assertion, context) {
  const { artifacts, fileDiff, responseText, helperText, run } = context;
  const turns = artifacts.grokTurns;

  switch (assertion.check) {
    case "subagent_spawned": {
      const found = artifacts.subagents.filter((s) => s.agentType === assertion.agentType);
      return {
        passed: found.length > 0,
        evidence: found.length
          ? `Spawned ${found.length} × ${assertion.agentType}`
          : `Subagents spawned: ${JSON.stringify(artifacts.subagents.map((s) => s.agentType))}`
      };
    }

    case "subagent_absent": {
      const found = artifacts.subagents.filter((s) => s.agentType === assertion.agentType);
      return {
        passed: found.length === 0,
        evidence: found.length
          ? `Unexpectedly spawned ${assertion.agentType}`
          : `No ${assertion.agentType} subagent (subagents: ${JSON.stringify(artifacts.subagents.map((s) => s.agentType))})`
      };
    }

    case "grok_turns": {
      const n = turns.length;
      const ok =
        (assertion.equals === undefined || n === assertion.equals) &&
        (assertion.min === undefined || n >= assertion.min) &&
        (assertion.max === undefined || n <= assertion.max);
      return {
        passed: ok,
        evidence: `${n} Grok turn(s); ${artifacts.grokCalls.length} total grok invocation(s) including --version probes`
      };
    }

    case "grok_argv_sequence": {
      if (turns.length === 0) {
        return { passed: false, evidence: "No Grok turn to inspect" };
      }
      const failing = turns.filter((t) => !argvHasSequence(t.argv, assertion.tokens));
      return {
        passed: failing.length === 0,
        evidence:
          failing.length === 0
            ? `Every turn passed ${assertion.tokens.join(" ")}`
            : `Missing ${assertion.tokens.join(" ")} in argv: ${JSON.stringify(redactPrompt(failing[0].argv))}`
      };
    }

    case "grok_argv_absent": {
      if (turns.length === 0) {
        return { passed: false, evidence: "No Grok turn to inspect" };
      }
      const hits = [];
      for (const turn of turns) {
        for (const token of assertion.tokens) {
          if (turn.argv.includes(token)) {
            hits.push(token);
          }
        }
      }
      return {
        passed: hits.length === 0,
        evidence: hits.length
          ? `Found forbidden flag(s): ${[...new Set(hits)].join(", ")}`
          : `None of ${assertion.tokens.join(", ")} present`
      };
    }

    case "grok_prompt_matches":
    case "grok_prompt_not_matches": {
      if (turns.length === 0) {
        return { passed: false, evidence: "No Grok turn to inspect" };
      }
      const re = new RegExp(assertion.pattern, assertion.flags ?? "i");
      const matched = turns.filter((t) => re.test(grokPrompt(t)));
      const wantMatch = assertion.check === "grok_prompt_matches";
      const passed = wantMatch ? matched.length === turns.length : matched.length === 0;
      return {
        passed,
        evidence: wantMatch
          ? `${matched.length}/${turns.length} prompt(s) matched /${assertion.pattern}/`
          : matched.length
            ? `Prompt leaked /${assertion.pattern}/: …${excerpt(grokPrompt(matched[0]), re)}…`
            : `No prompt matched /${assertion.pattern}/`
      };
    }

    case "subagent_tools": {
      const agents = artifacts.subagents.filter((s) => s.agentType === assertion.agentType);
      if (agents.length === 0) {
        return { passed: false, evidence: `No ${assertion.agentType} subagent ran` };
      }
      const problems = [];
      for (const agent of agents) {
        const names = agent.toolCalls.map((t) => t.name);
        if (assertion.forbidden) {
          const bad = names.filter((n) => assertion.forbidden.includes(n));
          if (bad.length) {
            problems.push(`used forbidden tool(s): ${[...new Set(bad)].join(", ")}`);
          }
        }
        if (assertion.allowed) {
          const bad = names.filter((n) => !assertion.allowed.includes(n));
          if (bad.length) {
            problems.push(`used non-allowed tool(s): ${[...new Set(bad)].join(", ")}`);
          }
        }
        if (assertion.maxCalls !== undefined && names.length > assertion.maxCalls) {
          problems.push(`made ${names.length} tool calls (max ${assertion.maxCalls})`);
        }
      }
      const allNames = agents.flatMap((a) => a.toolCalls.map((t) => t.name));
      return {
        passed: problems.length === 0,
        evidence: problems.length ? problems.join("; ") : `Tool calls: ${JSON.stringify(allNames)}`
      };
    }

    case "main_tools_absent": {
      const used = artifacts.mainToolCalls.map((t) => t.name).filter((n) => assertion.tools.includes(n));
      return {
        passed: used.length === 0,
        evidence: used.length
          ? `Main thread used: ${[...new Set(used)].join(", ")}`
          : `No ${assertion.tools.join("/")} calls in the main thread`
      };
    }

    case "files_unchanged": {
      return {
        passed: fileDiff.changed.length === 0,
        evidence: fileDiff.changed.length
          ? `Changed: ${fileDiff.changed.join(", ")}`
          : "Working tree byte-identical to the pre-run snapshot"
      };
    }

    case "files_changed": {
      if (assertion.paths) {
        const missing = assertion.paths.filter((p) => !fileDiff.changed.includes(p));
        return {
          passed: missing.length === 0,
          evidence: missing.length
            ? `Expected changes to ${missing.join(", ")}; actually changed: ${fileDiff.changed.join(", ") || "nothing"}`
            : `Changed: ${fileDiff.changed.join(", ")}`
        };
      }
      return {
        passed: fileDiff.changed.length > 0,
        evidence: `Changed: ${fileDiff.changed.join(", ") || "nothing"}`
      };
    }

    case "response_matches": {
      const re = new RegExp(assertion.pattern, assertion.flags ?? "i");
      return {
        passed: re.test(responseText),
        evidence: re.test(responseText)
          ? `Matched /${assertion.pattern}/: …${excerpt(responseText, re)}…`
          : `No match for /${assertion.pattern}/ in ${responseText.length} chars of response`
      };
    }

    case "helper_output_matches":
    case "helper_output_not_matches": {
      const re = new RegExp(assertion.pattern, assertion.flags ?? "i");
      const hit = re.test(helperText);
      const wantMatch = assertion.check === "helper_output_matches";
      return {
        passed: wantMatch ? hit : !hit,
        evidence: hit
          ? `Matched /${assertion.pattern}/ in helper output: …${excerpt(helperText, re)}…`
          : `No match for /${assertion.pattern}/ in ${helperText.length} chars of helper output`
      };
    }

    /**
     * Write capability is not readable from any single flag. The companion
     * passes `--always-approve` on both paths and expresses read-only by adding
     * `--disallowed-tools search_replace,write,...`. Grading the mechanism
     * rather than one convenient token is what keeps this honest — checking
     * `--always-approve` alone reports a read-only violation on every run.
     */
    case "grok_write_capability": {
      if (turns.length === 0) {
        return { passed: false, evidence: "No Grok turn to inspect" };
      }
      const seen = turns.map((turn) => classifyWriteCapability(turn.argv));
      const mismatched = seen.filter((s) => s.mode !== assertion.expect);
      return {
        passed: mismatched.length === 0,
        evidence:
          `expected ${assertion.expect}; observed ` +
          seen.map((s) => `${s.mode} (${s.reason})`).join(", ")
      };
    }

    case "tests_pass":
    case "tests_fail": {
      const outcome = runFixtureTests(run.repoRoot);
      const wantPass = assertion.check === "tests_pass";
      return {
        passed: wantPass ? outcome.ok : !outcome.ok,
        evidence: `node --test exited ${outcome.code}: ${outcome.summary}`
      };
    }

    case "any_of": {
      const results = assertion.checks.map((sub) => runCheck({ ...sub, id: sub.id ?? "sub" }, context));
      const passed = results.some((r) => r.passed);
      return {
        passed,
        evidence: results.map((r, i) => `[${r.passed ? "pass" : "fail"}] ${r.evidence}`).join(" | ")
      };
    }

    default:
      throw new Error(`Unknown check: ${assertion.check}`);
  }
}

/**
 * @param {string[]} argv
 * @returns {{mode: "read-only" | "write", reason: string}}
 */
function classifyWriteCapability(argv) {
  const index = argv.indexOf("--disallowed-tools");
  const blocked = index >= 0 ? argv[index + 1] ?? "" : "";
  if (/\bwrite\b|search_replace/.test(blocked)) {
    return { mode: "read-only", reason: "edit tools disallowed" };
  }
  if (argv.includes("--always-approve")) {
    return { mode: "write", reason: "--always-approve with no edit-tool block" };
  }
  return { mode: "read-only", reason: "no approval flag" };
}

function runFixtureTests(repoRoot) {
  if (!repoRoot || !fs.existsSync(path.join(repoRoot, "package.json"))) {
    return { ok: false, code: -1, summary: "no fixture package.json" };
  }
  try {
    const out = execFileSync("node", ["--test"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 120_000
    });
    return { ok: true, code: 0, summary: summarizeTestOutput(out) };
  } catch (error) {
    const out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    return { ok: false, code: error.status ?? -1, summary: summarizeTestOutput(out) };
  }
}

function summarizeTestOutput(out) {
  const pass = /^# pass (\d+)/m.exec(out) ?? /ℹ pass (\d+)/.exec(out);
  const fail = /^# fail (\d+)/m.exec(out) ?? /ℹ fail (\d+)/.exec(out);
  if (pass || fail) {
    return `pass=${pass?.[1] ?? "?"} fail=${fail?.[1] ?? "?"}`;
  }
  return out.trim().split("\n").slice(-2).join(" ").slice(0, 200) || "no output";
}

function excerpt(text, re) {
  const m = re.exec(text);
  if (!m) {
    return "";
  }
  const start = Math.max(0, m.index - 40);
  return text.slice(start, m.index + m[0].length + 60).replace(/\s+/g, " ");
}
