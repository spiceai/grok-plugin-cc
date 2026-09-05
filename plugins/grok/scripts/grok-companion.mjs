#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
    buildPersistentTaskThreadName,
    DEFAULT_CONTINUE_PROMPT,
    findLatestTaskThread,
    getGrokAuthStatus,
    getGrokAvailability,
    getSessionRuntimeStatus,
    importExternalAgentSession,
    interruptAppServerTurn,
    parseStructuredOutput,
    readOutputSchema,
    runAppServerReview,
    runAppServerTurn
  } from "./lib/grok.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import {
  collectReviewContext,
  diffWorkingTreeFingerprints,
  ensureGitRepository,
  fingerprintWorkingTree,
  getBranchReviewRange,
  resolveReviewTarget
} from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  listReconciledJobs,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult,
  validateReviewResultShape
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
// Aliases must resolve to ids `grok models` actually lists. An unknown id is a
// hard error from the CLI, not a fallback to the default, so a stale alias here
// fails the whole run.
const MODEL_ALIASES = new Map([["build", "grok-4.5"], ["fast", "grok-4.5"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/grok-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/grok-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/grok-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/grok-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model|build|fast>] [--effort <none|minimal|low|medium|high|xhigh|max>] [prompt]",
      "  node scripts/grok-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/grok-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/grok-companion.mjs result [job-id] [--json]",
      "  node scripts/grok-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh, max.`
    );
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const grokStatus = getGrokAvailability(cwd);
  const authStatus = await getGrokAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!grokStatus.available) {
    nextSteps.push("Install Grok Build with `curl -fsSL https://x.ai/cli/install.sh | bash`.");
  }
  if (grokStatus.available && !authStatus.loggedIn) {
    nextSteps.push("Run `!grok login`.");
    nextSteps.push("If browser login is blocked, retry with `!grok login --device-auth` or set `XAI_API_KEY`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/grok:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready: nodeStatus.available && grokStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    grok: grokStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildAdversarialReviewPrompt(context, focusText, outputSchema) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    // The schema travels in the prompt rather than as `--json-schema`; see the
    // note where the review turn is launched.
    OUTPUT_SCHEMA: JSON.stringify(outputSchema, null, 2),
    REVIEW_INPUT: context.content
  });
}

function ensureGrokAvailable(cwd) {
  const availability = getGrokAvailability(cwd);
  if (!availability.available) {
    throw new Error("Grok Build CLI is not installed. Install it with `curl -fsSL https://x.ai/cli/install.sh | bash`, then rerun `/grok:setup`.");
  }
}

const REVIEW_REEMIT_PROMPT = [
  "Your previous answer could not be read as a single JSON object.",
  "Re-emit the completed review now as exactly one JSON object matching the schema.",
  "Output only that object: no prose, no code fences, no progress updates, and no second copy.",
  "Do not run any more tools — use the findings you already have."
].join("\n");

// Re-emitting is the wrong ask when the previous object parsed perfectly and
// simply said nothing; repeating "emit valid JSON" invites the same stub back.
// This turn runs with the tools available, because an unfinished review usually
// means the change was never looked at.
const REVIEW_RESTATE_PROMPT = [
  "Your previous answer was not a finished review: it was a placeholder, a description of work still in progress, or a verdict given without inspecting the change.",
  "If you have not yet inspected the change, do that now with your read-only tools: run git diff for the pinned scope, and read any listed file whose contents were not provided.",
  "Then emit the finished review as exactly one JSON object matching the schema.",
  "The summary must be your actual assessment of the change, not a placeholder token and not a description of what you are about to do.",
  "Every concern you have must appear as a finding. Use verdict `needs-attention` only when you list at least one finding; if the change is genuinely clean, use `approve` and say why in the summary.",
  "Make that object your final message: no code fences, no progress updates, and no second copy."
].join("\n");

// A review of a change that was not in the prompt, reached without a single
// tool call, was written from the file list. With the investigation no longer
// run under `--json-schema`, nothing else stops that from reading as a clean
// bill of health.
const UNINSPECTED_REVIEW_REASON =
  "Grok answered without inspecting the change: parts of it were not in the prompt and Grok called no tool, so the verdict cannot rest on the code. The run produced no assessment.";

/**
 * Whether a turn looked at the repository at all. Under the read-only profile
 * every tool Grok has left is an inspection tool, so any call counts.
 *
 * This is a coarse gate on purpose: it catches the answer given from the file
 * list, which is the failure that was shipping. It does not prove every file
 * left out of the prompt was read — tool arguments take too many shapes (a
 * shell `cat`, a file read, a grep) to pin each path reliably.
 */
function hasToolCalls(result) {
  return Array.isArray(result?.events) && result.events.some((event) => event?.type === "tool_call");
}

/**
 * Why a parsed object cannot be handed on as a review, or null.
 *
 * The investigation runs unconstrained, so nothing validated the object before
 * it got here: this is the shape gate `--json-schema` used to be. A miss is a
 * formatting problem, which the schema-constrained re-emit exists to fix.
 */
function findMalformedReviewReason(review, schema) {
  const shapeError = validateReviewResultShape(review);
  if (shapeError) {
    return `Grok's JSON was not a review. ${shapeError}`;
  }
  const verdicts = schema?.properties?.verdict?.enum ?? [];
  if (verdicts.length > 0 && !verdicts.includes(review.verdict)) {
    return `Grok's JSON used the verdict ${JSON.stringify(review.verdict)}; the schema allows ${verdicts.map((verdict) => `\`${verdict}\``).join(" or ")}.`;
  }
  const incomplete = review.findings.findIndex(
    (finding) =>
      !finding ||
      typeof finding !== "object" ||
      Array.isArray(finding) ||
      ["title", "body", "file"].some((field) => typeof finding[field] !== "string" || !finding[field].trim())
  );
  if (incomplete !== -1) {
    return `Grok's JSON finding ${incomplete + 1} is missing its title, body, or file.`;
  }
  return null;
}

/** A parsed object is only useful as a review if it carries the review fields. */
function looksLikeReviewResult(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof value.verdict === "string" &&
    typeof value.summary === "string" &&
    Array.isArray(value.findings)
  );
}

/**
 * A salvaged review is only worth keeping when the findings it reports were
 * genuinely emitted before the output was cut off.
 *
 * Closing the delimiters of `{"verdict":"approve","summary":"…","findings":[`
 * yields a clean approval with an empty findings list — an all-clear the model
 * never gave. Every other salvage reports findings that really were written, so
 * this rejects the one shape where repair invents the conclusion rather than
 * recovering it.
 */
function isFabricatedAllClear(parsed) {
  return (
    Array.isArray(parsed?.findings) &&
    parsed.findings.length === 0 &&
    !/needs.?attention|block|reject/i.test(String(parsed?.verdict ?? ""))
  );
}

// A summary that is a filler token rather than an assessment.
const PLACEHOLDER_SUMMARY =
  /^\W*(placeholder|tbd|to ?be ?(determined|filled|written)|todo|fixme|n\/?a|none|null|nil|pending|unknown|summary(?: here| goes here)?|xxx+|lorem ipsum|[.\-_*]+)\W*$/i;

// Present-tense narration: the model describing the review it has not finished.
const IN_PROGRESS_SUMMARY =
  /\b(investigating|analy[sz]ing|reviewing now|still (?:reviewing|investigating|checking)|will (?:now )?(?:review|inspect|check|examine|verify)|about to (?:review|inspect|check)|let me\b|i(?:'ll| will) (?:now )?(?:review|inspect|check|start)|review in progress|in progress)\b/i;

/**
 * Decide whether a schema-valid object is actually a review.
 *
 * Grok can end a turn with something that satisfies the schema but asserts
 * nothing: a literal `"PLACEHOLDER"` summary, or the narration it was writing
 * while it was still investigating. Both render as
 * `Verdict: needs-attention / No material findings`, which reads exactly like a
 * clean bill of health — the most dangerous way for a review tool to fail. A
 * broken run has to surface as broken, not as "nothing found".
 *
 * @returns {string | null} why the object is unusable, or null when it is a review
 */
function findUnusableReviewReason(review) {
  const summary = String(review?.summary ?? "").trim();
  const verdict = String(review?.verdict ?? "").trim().toLowerCase();
  const findings = Array.isArray(review?.findings) ? review.findings : [];

  if (PLACEHOLDER_SUMMARY.test(summary)) {
    return `Grok returned a placeholder summary (${JSON.stringify(summary)}) instead of a review. The run produced no assessment, so this is a failed review rather than a clean one.`;
  }

  if (findings.length === 0 && IN_PROGRESS_SUMMARY.test(summary)) {
    return "Grok's summary describes a review it was still working on rather than one it finished, and it reported no findings. The run ended before it reached a conclusion.";
  }

  // Only `approve` can carry an empty findings list. Flagging risk while
  // reporting nothing to act on means the answer was cut off or never written.
  if (findings.length === 0 && verdict && verdict !== "approve") {
    return `Grok returned the verdict "${review.verdict}" with no findings. A non-approving verdict with nothing to act on means the review did not finish, so it cannot be read as "no issues found".`;
  }

  return null;
}

/**
 * @param {{ schema?: object, requireInspection?: boolean }} [options]
 *   `requireInspection`: the prompt did not carry the whole change and the
 *   session has not called a tool, so any answer was given blind.
 */
function parseReviewOutput(result, options = {}) {
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    structuredOutput: result.structuredOutput,
    segments: result.messageSegments,
    stopReason: result.stopReason,
    shapeCheck: looksLikeReviewResult,
    failureMessage: result.error?.message ?? result.stderr
  });

  if (parsed.recovered && isFabricatedAllClear(parsed.parsed)) {
    return {
      ...parsed,
      parsed: null,
      parseError:
        "Grok's review was cut off before it reported anything, so the only thing left to recover was an empty approval. Treating that as 'no issues found' would be wrong."
    };
  }

  if (parsed.parsed) {
    // `next_steps` is not load-bearing: an answer cut off before it, or a model
    // that skipped it, still carries the review. Everything else missing is a
    // shape problem worth a re-emit.
    const review = { next_steps: [], ...parsed.parsed };
    const malformedReason = findMalformedReviewReason(review, options.schema);
    if (malformedReason) {
      return { ...parsed, parsed: null, parseError: malformedReason };
    }
    const unusableReason = findUnusableReviewReason(review) ?? (options.requireInspection ? UNINSPECTED_REVIEW_REASON : null);
    if (unusableReason) {
      return { ...parsed, parsed: null, parseError: unusableReason, unusableContent: true };
    }
    return { ...parsed, parsed: review };
  }

  return parsed;
}

function buildNativeReviewTarget(target, cwd = null) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    const nativeTarget = { type: "baseBranch", branch: target.baseRef };
    if (!cwd) {
      return nativeTarget;
    }
    try {
      const range = getBranchReviewRange(cwd, target.baseRef);
      return { ...nativeTarget, commitRange: range.commitRange, changedFiles: range.changedFiles };
    } catch {
      // An unresolvable base still reviews; it just cannot pin the range.
      return nativeTarget;
    }
  }

  return null;
}

function validateNativeReviewRequest(target, focusText, cwd = null) {
  if (focusText.trim()) {
    throw new Error(
      `\`/grok:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/grok:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target, cwd);
  if (!nativeTarget) {
    throw new Error("This `/grok:review` target is not supported by the built-in reviewer. Retry with `/grok:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  // Reconciled so a background task whose process was killed cannot block
  // every future `--resume-last` behind a run that is not actually going.
  const jobs = sortJobsNewestFirst(listReconciledJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && (job.status === "queued" || job.status === "running"));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /grok:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureGrokAvailable(request.cwd);
  const repoRoot = ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  // A review promises not to touch the tree. The sandbox that backs that
  // promise is a request the CLI drops silently when it cannot apply the
  // kernel policy, so the tree is fingerprinted here and compared afterwards;
  // any difference is reported above the findings.
  const treeBefore = fingerprintWorkingTree(repoRoot);
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText, request.cwd);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const workingTreeChanges = diffWorkingTreeFingerprints(treeBefore, fingerprintWorkingTree(repoRoot));
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      sandbox: result.sandbox ?? null,
      workingTreeChanges,
      grok: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      {
        reviewLabel: reviewName,
        targetLabel: target.label,
        reasoningSummary: result.reasoningSummary,
        sandbox: result.sandbox,
        workingTreeChanges
      }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: prefixIntegrityWarning(
        workingTreeChanges,
        result.sandbox,
        firstMeaningfulLine(result.reviewText, `${reviewName} completed.`)
      ),
      jobTitle: `Grok ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const schema = readOutputSchema(REVIEW_SCHEMA);
  const prompt = buildAdversarialReviewPrompt(context, focusText, schema);
  // The investigation runs without `--json-schema`. Grok applies that flag to
  // every assistant message, and under it grok-4.6 never calls a tool: it
  // reasons about inspecting the diff, then its message is forced into the
  // schema shape and the turn ends with a "review in progress" stub — on every
  // turn, so a resumed retry under the flag just repeats the stub. Every
  // adversarial review failed this way. With the schema in the prompt instead,
  // Grok can read the change and still answer in the requested shape; the flag
  // is kept for the tool-free re-emit below, where a constrained answer is
  // exactly what is wanted.
  //
  // `verbatim` keeps the prompt whole. Without it the CLI truncates anything
  // over roughly 32 KB to its first 20 KB and offloads the rest to a file the
  // model is told to read — which an inline diff regularly exceeds.
  let result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    verbatim: true,
    onProgress: request.onProgress
  });
  const sandboxOutcomes = [result.sandbox];
  const requireInspection = !context.inlinedEverything;
  let inspected = hasToolCalls(result);
  let parsed = parseReviewOutput(result, { schema, requireInspection: requireInspection && !inspected });

  // A stub, or an answer given without looking at a change that was not in the
  // prompt, means the investigation never finished. Ask again with the tools
  // still available: a schema-constrained turn cannot inspect anything (see
  // above), so it would only repeat the stub — which is exactly what the old
  // restate retry did.
  if ((parsed.unusableContent || (requireInspection && !inspected)) && result.threadId) {
    request.onProgress?.("Grok's answer was not a finished review. Asking it to inspect the change and restate its assessment.");
    const restated = await runAppServerTurn(context.repoRoot, {
      prompt: REVIEW_RESTATE_PROMPT,
      resumeThreadId: result.threadId,
      model: request.model,
      sandbox: "read-only",
      onProgress: request.onProgress
    });
    inspected = inspected || hasToolCalls(restated);
    sandboxOutcomes.push(restated.sandbox);
    result = { ...restated, reasoningSummary: [...result.reasoningSummary, ...restated.reasoningSummary] };
    parsed = parseReviewOutput(result, { schema, requireInspection: requireInspection && !inspected });
  }

  // Grok narrates between tool calls, so the answer can arrive wrapped in prose,
  // fenced, trailing an earlier draft, or missing a field. Parsing already
  // recovers the object from most of that, but if it still cannot be read the
  // session is warm and holds the findings — one short "re-emit the JSON" turn
  // is far cheaper than losing the review. That turn needs no tools, so it is
  // the one place `--json-schema` is safe: it guarantees the shape without
  // costing the investigation.
  //
  // A salvaged object counts as "still needs the retry". Closing the delimiters
  // of a half-written answer produces something that parses but was never
  // actually asserted: `{"verdict":"approve","summary":"No issues","findings":[`
  // repairs into a clean approval with no findings, which is the most dangerous
  // possible output for a review tool. Asking Grok to restate its answer costs
  // one cheap turn and yields something it actually said, so the salvage is only
  // kept when the retry cannot do better.
  if (!parsed.unusableContent && (!parsed.parsed || parsed.recovered) && result.threadId) {
    request.onProgress?.(
      parsed.recovered
        ? "Grok's JSON was incomplete and had to be repaired. Asking it to restate the review."
        : "Grok returned unusable JSON. Asking it to re-emit the final object."
    );
    const retry = await runAppServerTurn(context.repoRoot, {
      prompt: REVIEW_REEMIT_PROMPT,
      resumeThreadId: result.threadId,
      model: request.model,
      sandbox: "read-only",
      outputSchema: schema,
      maxTurns: 1,
      onProgress: request.onProgress
    });
    sandboxOutcomes.push(retry.sandbox);
    const retryParsed = parseReviewOutput(retry, { schema, requireInspection: requireInspection && !inspected });
    // Take the retry when it is a clean parse. When it also had to be salvaged
    // it is no more trustworthy than what we already had, so it only wins if the
    // first attempt produced nothing usable at all.
    const retryIsBetter = retryParsed.parsed && (!retryParsed.recovered || !parsed.parsed);
    if (retryIsBetter) {
      result = { ...retry, reasoningSummary: result.reasoningSummary };
      parsed = retryParsed;
    }
  }
  const workingTreeChanges = diffWorkingTreeFingerprints(treeBefore, fingerprintWorkingTree(repoRoot));
  const sandbox = worstSandboxOutcome(sandboxOutcomes);
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    sandbox,
    workingTreeChanges,
    grok: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    recovered: parsed.recovered ?? null,
    stopReason: result.stopReason ?? null,
    reasoningSummary: result.reasoningSummary
  };

  return {
    // A run that produced no usable review is a failed job, not a completed one
    // with nothing to report. Without this the record reads `completed` and
    // `/grok:status` presents a broken run as a finished review.
    exitStatus: result.status !== 0 ? result.status : parsed.parsed ? 0 : 1,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary,
      sandbox,
      workingTreeChanges
    }),
    summary: prefixIntegrityWarning(
      workingTreeChanges,
      sandbox,
      parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`)
    ),
    jobTitle: `Grok ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureGrokAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Grok task session was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    // Grok's built-in writable profile is `workspace`. `workspace-write` is a
    // Codex profile name and Grok refuses to start when it is passed, which
    // takes down every write-capable rescue run.
    sandbox: request.write ? "workspace" : "read-only",
    onProgress: request.onProgress,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

/**
 * `/grok:status` shows one line per job. A review that ran unfenced, or that
 * changed the tree, must not read as routine there.
 */
function prefixIntegrityWarning(workingTreeChanges, sandbox, summary) {
  if (workingTreeChanges.length > 0) {
    return `Warning: the working tree changed during the review. ${summary}`;
  }
  if (sandbox?.requested && sandbox.applied === false) {
    return `Warning: ran without the ${sandbox.requested} sandbox. ${summary}`;
  }
  if (sandbox?.requested && sandbox.workspaceWritable) {
    return `Warning: the ${sandbox.requested} sandbox did not cover this repository. ${summary}`;
  }
  return summary;
}

/**
 * Every turn of a review is its own process with its own sandbox outcome, and
 * the first turn is where the tools ran. Report the worst of them.
 */
function worstSandboxOutcome(outcomes) {
  const known = outcomes.filter(Boolean);
  if (known.length === 0) {
    return null;
  }
  return (
    known.find((outcome) => outcome.applied === false) ??
    known.find((outcome) => outcome.workspaceWritable) ??
    known.find((outcome) => outcome.applied == null) ??
    known[0]
  );
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Grok Review" : `Grok ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Grok Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Grok Resume" : "Grok Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /grok:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId
  };
}

function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Grok thread with visible turn history.",
    `Grok session ID: ${payload.threadId}`,
    `Resume in Grok: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `grok --resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "grok-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model: options.model,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureGrokAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        resumeLast,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { payload, rendered } = await executeTransfer(cwd, {
    source: options.source
  });
  outputCommandResult(payload, rendered, options.json);
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listReconciledJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};
  const threadId = existing.threadId ?? job.threadId ?? null;
  const turnId = existing.turnId ?? job.turnId ?? null;

  const interrupt = await interruptAppServerTurn(cwd, { threadId, turnId });
  if (interrupt.attempted) {
    appendLogLine(
      job.logFile,
      interrupt.interrupted
        ? `Requested Grok turn interrupt for ${turnId} on ${threadId}.`
        : `Grok turn interrupt failed${interrupt.detail ? `: ${interrupt.detail}` : "."}`
    );
  }

  terminateProcessTree(job.pid ?? Number.NaN);
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
