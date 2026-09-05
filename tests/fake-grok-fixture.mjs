import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import os from "node:os";

import { writeExecutable } from "./helpers.mjs";

/**
 * Install a fake `grok` binary that implements headless streaming-json.
 * @param {string} binDir
 * @param {string} [behavior]
 */
export function installFakeGrok(binDir, behavior = "review-ok") {
  const statePath = path.join(binDir, "fake-grok-state.json");
  const scriptPath = path.join(binDir, "grok");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { runs: 0, lastArgs: [], sessions: [] };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

function parseArgs(argv) {
  const out = { flags: {}, positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-p" || arg === "--single") {
      out.flags.prompt = argv[++i];
    } else if (arg === "--prompt-file") {
      out.flags.prompt = fs.readFileSync(argv[++i], "utf8");
      out.flags.promptFile = true;
    } else if (arg === "--cwd") {
      out.flags.cwd = argv[++i];
    } else if (arg === "-m" || arg === "--model") {
      out.flags.model = argv[++i];
    } else if (arg === "--effort" || arg === "--reasoning-effort") {
      out.flags.effort = argv[++i];
    } else if (arg === "--resume" || arg === "-r") {
      out.flags.resume = argv[++i] ?? true;
    } else if (arg === "--output-format") {
      out.flags.outputFormat = argv[++i];
    } else if (arg === "--json-schema") {
      out.flags.jsonSchema = argv[++i];
    } else if (arg === "--always-approve" || arg === "--yolo" || arg === "--no-auto-update" || arg === "--verbatim") {
      out.flags[arg.replace(/^--/, "")] = true;
    } else if (arg === "--disallowed-tools") {
      out.flags.disallowedTools = argv[++i];
    } else if (arg === "--sandbox") {
      out.flags.sandbox = argv[++i];
    } else if (arg === "--max-turns") {
      out.flags.maxTurns = argv[++i];
    } else if (arg === "--version" || arg === "-v") {
      out.flags.version = true;
    } else if (arg.startsWith("-")) {
      // skip unknown flags / values
      if (!arg.includes("=") && argv[i + 1] && !argv[i + 1].startsWith("-")) {
        i += 1;
      }
    } else {
      out.positionals.push(arg);
    }
  }
  return out;
}

const argv = process.argv.slice(2);
const parsed = parseArgs(argv);
const state = loadState();
state.runs += 1;
state.lastArgs = argv;
// The prompt as received, whether it came on argv or through --prompt-file
// (which the companion deletes once the run ends).
state.lastPrompt = parsed.flags.prompt;
// Every headless prompt run, in order. The companion probes grok --version
// before each run, and those probes are not turns.
if (parsed.flags.prompt !== undefined) {
  state.argsHistory = [...(state.argsHistory || []), argv];
}
saveState(state);

// The real CLI appends to $GROK_HOME/sandbox-events.jsonl whether the requested
// profile was applied; the companion reads that log after a run.
function recordSandboxEvent(eventType, extra) {
  const home = process.env.GROK_HOME;
  if (!home) {
    return;
  }
  fs.mkdirSync(home, { recursive: true });
  fs.appendFileSync(
    path.join(home, "sandbox-events.jsonl"),
    JSON.stringify(Object.assign(
      { timestamp: new Date().toISOString(), event_type: eventType, profile: parsed.flags.sandbox, workspace: parsed.flags.cwd || process.cwd() },
      extra
    )) + "\\n"
  );
}
if (parsed.flags.sandbox && parsed.flags.prompt !== undefined) {
  const workspace = parsed.flags.cwd || process.cwd();
  if (BEHAVIOR === "review-sandbox-unapplied" || (BEHAVIOR === "review-sandbox-unapplied-first-turn" && !parsed.flags.resume)) {
    recordSandboxEvent("ApplyFailed", { error: "seatbelt unavailable in this environment" });
  } else if (BEHAVIOR === "review-sandbox-writable-workspace") {
    // Enforced, but the tree sits inside a path the profile keeps writable —
    // what a checkout under /tmp gets from the real read-only profile.
    recordSandboxEvent("ProfileApplied", { platform: "fake/none", enforced: true, restrict_network: true, read_write_paths: [path.dirname(workspace)] });
  } else {
    recordSandboxEvent("ProfileApplied", { platform: "fake/none", enforced: true, restrict_network: true });
  }
}

if (parsed.flags.version || argv.includes("version")) {
  process.stdout.write("grok 0.0.0-fake\\n");
  process.exit(0);
}

if (BEHAVIOR === "missing") {
  process.stderr.write("not found\\n");
  process.exit(127);
}

if (BEHAVIOR === "logged-out") {
  emit({ type: "error", message: "Not authenticated. Run grok login." });
  process.exit(1);
}

const sessionId = typeof parsed.flags.resume === "string" && parsed.flags.resume !== "true"
  ? parsed.flags.resume
  : crypto.randomUUID();

const prompt = parsed.flags.prompt || "";
const isReview = /code review|adversarial|Review the provided repository/i.test(prompt) || /uncommitted|base branch/i.test(prompt);
const isStopGate = /stop-gate review/i.test(prompt);
const isTransfer = /transferred from a Claude/i.test(prompt);

let finalText;
if (BEHAVIOR === "task-ok" || (!isReview && !isStopGate && BEHAVIOR === "review-ok" && !isTransfer)) {
  finalText = "Task completed successfully. Fixed the failing test.";
}
if (isTransfer) {
  finalText = "Context absorbed. Ready to continue.";
} else if (isStopGate) {
  finalText = BEHAVIOR === "stop-block" ? "BLOCK: leftover debug assert in main.ts" : "ALLOW: no blocking issues in the last turn";
} else if (isReview || BEHAVIOR === "review-ok") {
  // The companion carries the schema in the prompt for the investigative turn
  // and pins --json-schema only on a re-emit; either one asks for JSON.
  if (parsed.flags.jsonSchema || /<output_schema>/.test(prompt)) {
    finalText = JSON.stringify({
      verdict: "needs-attention",
      summary: "Found one material issue in the change set.",
      findings: [
        {
          severity: "high",
          title: "Missing null check",
          body: "The new parser assumes input is always present.",
          file: "src/main.ts",
          line_start: 12,
          line_end: 18,
          confidence: 0.9,
          recommendation: "Guard against null input before parsing."
        }
      ],
      next_steps: ["Add a unit test for empty input."]
    });
  } else {
    finalText = [
      "## Review",
      "",
      "Target reviewed successfully.",
      "",
      "Findings:",
      "- [high] Missing null check (src/main.ts:12-18)",
      "  The new parser assumes input is always present."
    ].join("\\n");
  }
} else if (BEHAVIOR === "fail") {
  emit({ type: "error", message: "Simulated Grok failure." });
  process.exit(1);
} else {
  finalText = finalText || "OK";
}

if (parsed.flags.outputFormat === "json") {
  process.stdout.write(
    JSON.stringify({
      text: finalText,
      stopReason: "end_turn",
      sessionId,
      requestId: "req-fake"
    }) + "\\n"
  );
  process.exit(0);
}

// streaming-json
const REVIEW_OBJECT = {
  verdict: "needs-attention",
  summary: "Found one material issue in the change set.",
  findings: [
    {
      severity: "high",
      title: "Missing null check",
      body: "The new parser assumes input is always present.",
      file: "src/main.ts",
      line_start: 12,
      line_end: 18,
      confidence: 0.9,
      recommendation: "Guard against null input before parsing."
    }
  ],
  next_steps: ["Add a unit test for empty input."]
};

function emitDraftedReview() {
  // Grok narrates between tool calls; under a JSON schema that narration is
  // itself JSON, so the run emits several complete objects before the real one.
  const drafts = [
    { verdict: "needs-attention", summary: "Review in progress.", findings: [], next_steps: [] },
    { verdict: "needs-attention", summary: "Still digging into the diff.", findings: [], next_steps: [] }
  ];
  drafts.forEach((draft, index) => {
    emit({ type: "text", data: JSON.stringify(draft) });
    emit({
      type: "tool_call",
      toolCallId: "draft_" + index,
      title: "Grep",
      kind: "search",
      status: "in_progress",
      toolName: "grep",
      rawInput: { pattern: "parse" }
    });
    emit({ type: "tool_call_update", toolCallId: "draft_" + index, status: "completed", toolName: "grep" });
  });
  const serialized = JSON.stringify(REVIEW_OBJECT);
  emit({ type: "text", data: serialized.slice(0, 40) });
  emit({ type: "text", data: serialized.slice(40) });
  emit({ type: "end", stopReason: "end_turn", sessionId, requestId: "req-fake" });
}

if (BEHAVIOR === "review-drafts") {
  emitDraftedReview();
  state.sessions.push(sessionId);
  saveState(state);
  process.exit(0);
}

if (BEHAVIOR === "review-structured") {
  // The text stream is unusable, but grok validated the answer itself.
  emit({ type: "text", data: "Working on it..." });
  emit({ type: "tool_call", toolCallId: "c1", title: "Read", kind: "read", status: "in_progress", toolName: "read_file", rawInput: { path: "src/main.ts" } });
  emit({ type: "tool_call_update", toolCallId: "c1", status: "completed", toolName: "read_file" });
  emit({ type: "text", data: "{ this is not valid json at all" });
  emit({ type: "end", stopReason: "end_turn", sessionId, requestId: "req-fake", structuredOutput: REVIEW_OBJECT });
  state.sessions.push(sessionId);
  saveState(state);
  process.exit(0);
}

if (BEHAVIOR === "review-truncated") {
  const serialized = JSON.stringify(REVIEW_OBJECT);
  emit({ type: "text", data: serialized.slice(0, serialized.indexOf("Guard against") + 8) });
  emit({ type: "end", stopReason: "max_tokens", sessionId, requestId: "req-fake" });
  state.sessions.push(sessionId);
  saveState(state);
  process.exit(0);
}

if (BEHAVIOR === "review-truncated-allclear") {
  // Cut off before a single finding was written. Repair can only close the
  // empty array, which would read as a clean approval the model never gave.
  if (parsed.flags.resume) {
    emit({ type: "text", data: JSON.stringify(REVIEW_OBJECT) });
    emit({ type: "end", stopReason: "end_turn", sessionId, requestId: "req-fake" });
  } else {
    emit({ type: "text", data: '{"verdict":"approve","summary":"No issues","findings":[' });
    emit({ type: "end", stopReason: "end_turn", sessionId, requestId: "req-fake" });
  }
  state.sessions.push(sessionId);
  saveState(state);
  process.exit(0);
}

// The failure seen in the wild: the run ends cleanly, the object validates
// against the schema, and it says nothing at all. Rendered naively it reads as
// "needs-attention / No material findings" — a broken run wearing a clean bill.
const PLACEHOLDER_REVIEW = { verdict: "needs-attention", summary: "PLACEHOLDER", findings: [], next_steps: [] };

// The other shape of the same failure: the model narrating the review it has
// not finished, with nothing to act on.
const NARRATED_REVIEW = {
  verdict: "needs-attention",
  summary: "Adversarial review of branch vs trunk: investigating those paths for data-correctness hazards before any ship call.",
  findings: [],
  next_steps: []
};

if (BEHAVIOR === "review-placeholder" || BEHAVIOR === "review-narrated") {
  // Emits the stub on every turn, so the restate retry cannot rescue it either.
  const stub = BEHAVIOR === "review-placeholder" ? PLACEHOLDER_REVIEW : NARRATED_REVIEW;
  emit({ type: "text", data: JSON.stringify(stub) });
  emit({ type: "end", stopReason: "end_turn", sessionId, requestId: "req-fake" });
  state.sessions.push(sessionId);
  saveState(state);
  process.exit(0);
}

if (BEHAVIOR === "review-sandbox-unapplied-first-turn") {
  // The turn that ran the tools ran unfenced; the restate that produced the
  // review ran fenced. The report has to carry the first.
  if (parsed.flags.resume) {
    emit({ type: "tool_call", toolCallId: "c1", title: "Shell", kind: "execute", status: "in_progress", toolName: "run_terminal_command", rawInput: { command: "git diff" } });
    emit({ type: "tool_call_update", toolCallId: "c1", status: "completed", toolName: "run_terminal_command" });
    emit({ type: "text", data: JSON.stringify(REVIEW_OBJECT) });
  } else {
    emit({ type: "text", data: JSON.stringify(PLACEHOLDER_REVIEW) });
  }
  emit({ type: "end", stopReason: "end_turn", sessionId, requestId: "req-fake" });
  state.sessions.push(sessionId);
  saveState(state);
  process.exit(0);
}

if (BEHAVIOR === "review-placeholder-restated") {
  // A stub first, then the real review once asked to restate it.
  if (parsed.flags.resume) {
    emit({ type: "text", data: JSON.stringify(REVIEW_OBJECT) });
  } else {
    emit({ type: "text", data: JSON.stringify(PLACEHOLDER_REVIEW) });
  }
  emit({ type: "end", stopReason: "end_turn", sessionId, requestId: "req-fake" });
  state.sessions.push(sessionId);
  saveState(state);
  process.exit(0);
}

if (BEHAVIOR === "killed-mid-run") {
  // A process that dies from a signal reports a null exit code, which must not
  // read as success — /grok:cancel kills the tree exactly this way.
  emit({ type: "text", data: '{"verdict":"approve","summary":"partial' });
  process.kill(process.pid, "SIGTERM");
  setTimeout(() => process.exit(0), 1000);
  return;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A review that fails outright. The generic "fail" behavior is unreachable for
// reviews, because a review-shaped prompt is answered before the failure branch
// is ever reached — so without this the background failure path is untestable.
if (BEHAVIOR === "review-fail") {
  emit({ type: "thought", data: "Collecting the diff." });
  emit({ type: "error", message: "Simulated Grok review failure." });
  process.exit(1);
}

// Stays in flight until killed, announcing itself first so a test can wait for
// the job to genuinely be running instead of racing it.
if (BEHAVIOR === "hang") {
  emit({ type: "thought", data: "Starting a long review." });
  if (process.env.FAKE_GROK_STARTED_FILE) {
    fs.writeFileSync(process.env.FAKE_GROK_STARTED_FILE, String(process.pid), "utf8");
  }
  sleepSync(Number(process.env.FAKE_GROK_HANG_MS || 600000));
  process.exit(0);
}

if (BEHAVIOR === "slow-review") {
  emit({ type: "thought", data: "Working through the diff." });
  sleepSync(Number(process.env.FAKE_GROK_SLEEP_MS || 1200));
}

if (BEHAVIOR === "review-schema-blind") {
  // Grok 1.0.13 with grok-4.6, as observed: a turn run under --json-schema
  // never calls a tool. The model reasons about inspecting the diff, then its
  // message is forced into the schema shape and the turn ends with a stub — on
  // every turn, a resumed one included, so no retry under the flag can rescue
  // it. Left unconstrained, the same prompt inspects the diff and answers.
  if (parsed.flags.jsonSchema) {
    emit({ type: "thought", data: "Let me start by inspecting the git diff as instructed." });
    emit({
      type: "text",
      data: JSON.stringify({
        verdict: "needs-attention",
        summary: "Review in progress; inspecting the working-tree diff before emitting findings.",
        findings: [],
        next_steps: []
      })
    });
  } else {
    emit({ type: "text", data: "Inspecting the diff first." });
    emit({ type: "tool_call", toolCallId: "c1", title: "Shell", kind: "execute", status: "in_progress", toolName: "run_terminal_command", rawInput: { command: "git diff" } });
    emit({ type: "tool_call_update", toolCallId: "c1", status: "completed", toolName: "run_terminal_command" });
    emit({ type: "text", data: JSON.stringify(REVIEW_OBJECT) });
  }
  emit({ type: "end", stopReason: "end_turn", sessionId, requestId: "req-fake" });
  state.sessions.push(sessionId);
  saveState(state);
  process.exit(0);
}

const BLIND_APPROVAL = { verdict: "approve", summary: "Nothing here looks risky.", findings: [], next_steps: [] };

if (BEHAVIOR === "review-sandbox-unapplied" || BEHAVIOR === "review-writes-file" || BEHAVIOR === "review-sandbox-writable-workspace") {
  if (BEHAVIOR === "review-writes-file") {
    // What an unfenced shell makes possible: the review wrote into the tree.
    fs.writeFileSync(path.join(parsed.flags.cwd || process.cwd(), "leaked.txt"), "written by the review\\n");
  }
  emit({ type: "tool_call", toolCallId: "c1", title: "Shell", kind: "execute", status: "in_progress", toolName: "run_terminal_command", rawInput: { command: "git diff" } });
  emit({ type: "tool_call_update", toolCallId: "c1", status: "completed", toolName: "run_terminal_command" });
  emit({ type: "text", data: JSON.stringify(REVIEW_OBJECT) });
  emit({ type: "end", stopReason: "end_turn", sessionId, requestId: "req-fake" });
  state.sessions.push(sessionId);
  saveState(state);
  process.exit(0);
}

if (BEHAVIOR === "review-blind-approve" || BEHAVIOR === "review-blind-always") {
  // An approval written from the file list: no tool call, then a clean bill.
  // "blind-approve" looks properly once sent back; "blind-always" never does.
  if (parsed.flags.resume && BEHAVIOR === "review-blind-approve") {
    emit({ type: "tool_call", toolCallId: "c1", title: "Shell", kind: "execute", status: "in_progress", toolName: "run_terminal_command", rawInput: { command: "git diff" } });
    emit({ type: "tool_call_update", toolCallId: "c1", status: "completed", toolName: "run_terminal_command" });
    emit({ type: "text", data: JSON.stringify(REVIEW_OBJECT) });
  } else {
    emit({ type: "text", data: JSON.stringify(BLIND_APPROVAL) });
  }
  emit({ type: "end", stopReason: "end_turn", sessionId, requestId: "req-fake" });
  state.sessions.push(sessionId);
  saveState(state);
  process.exit(0);
}

if (BEHAVIOR === "review-wrong-shape") {
  // Unconstrained, the model answers with an object that is not a review; the
  // schema-constrained re-emit is what fixes the shape.
  if (parsed.flags.jsonSchema) {
    emit({ type: "text", data: JSON.stringify(REVIEW_OBJECT) });
    emit({ type: "end", stopReason: "end_turn", sessionId, requestId: "req-fake", structuredOutput: REVIEW_OBJECT });
  } else {
    emit({ type: "tool_call", toolCallId: "c1", title: "Read", kind: "read", status: "in_progress", toolName: "read_file", rawInput: { path: "src/main.ts" } });
    emit({ type: "tool_call_update", toolCallId: "c1", status: "completed", toolName: "read_file" });
    emit({ type: "text", data: JSON.stringify({ notes: "Looked at the parser; the null path is unguarded.", verdict: "needs changes" }) });
    emit({ type: "end", stopReason: "end_turn", sessionId, requestId: "req-fake" });
  }
  state.sessions.push(sessionId);
  saveState(state);
  process.exit(0);
}

if (BEHAVIOR === "review-reemit") {
  // First run emits nothing parseable at all; the resumed run emits the object.
  if (parsed.flags.resume) {
    emit({ type: "text", data: JSON.stringify(REVIEW_OBJECT) });
    emit({ type: "end", stopReason: "end_turn", sessionId, requestId: "req-fake" });
  } else {
    emit({ type: "text", data: "I could not finish formatting the answer." });
    emit({ type: "end", stopReason: "end_turn", sessionId, requestId: "req-fake" });
  }
  state.sessions.push(sessionId);
  saveState(state);
  process.exit(0);
}

if (BEHAVIOR === "stop-gate-narrated") {
  // The verdict is not the first thing said — narration comes first.
  emit({ type: "text", data: "Let me check what the previous turn changed." });
  emit({ type: "tool_call", toolCallId: "c1", title: "Shell", kind: "execute", status: "in_progress", toolName: "run_terminal_cmd", rawInput: { command: "git diff" } });
  emit({ type: "tool_call_update", toolCallId: "c1", status: "completed", toolName: "run_terminal_cmd" });
  emit({ type: "text", data: "ALLOW: the previous turn only reported status" });
  emit({ type: "end", stopReason: "end_turn", sessionId, requestId: "req-fake" });
  state.sessions.push(sessionId);
  saveState(state);
  process.exit(0);
}

emit({ type: "thought", data: "Inspecting the repository state." });
emit({
  type: "tool_call",
  toolCallId: "call_1",
  title: "Read",
  kind: "read",
  status: "in_progress",
  toolName: "read_file",
  rawInput: { path: "src/main.ts" }
});
emit({
  type: "tool_call_update",
  toolCallId: "call_1",
  status: "completed",
  toolName: "read_file"
});
if (BEHAVIOR === "task-ok" || /fix|write|--write/i.test(prompt) || argv.includes("--always-approve")) {
  // still emit a shell-ish tool for progress coverage
  emit({
    type: "tool_call",
    toolCallId: "call_2",
    title: "Shell",
    kind: "execute",
    status: "in_progress",
    toolName: "run_terminal_cmd",
    rawInput: { command: "npm test" }
  });
  emit({
    type: "tool_call_update",
    toolCallId: "call_2",
    status: "completed",
    toolName: "run_terminal_cmd"
  });
}
// stream text in chunks
const mid = Math.ceil(finalText.length / 2);
emit({ type: "text", data: finalText.slice(0, mid) });
emit({ type: "text", data: finalText.slice(mid) });
emit({
  type: "end",
  stopReason: "end_turn",
  sessionId,
  requestId: "req-fake",
  result: finalText
});

state.sessions.push(sessionId);
saveState(state);
process.exit(0);
`;

  writeExecutable(scriptPath, source);
  return { binDir, scriptPath, statePath };
}

export function buildEnv(binDir, extra = {}) {
  const home = extra.GROK_HOME || fs.mkdtempSync(path.join(os.tmpdir(), "fake-grok-home-"));
  if (!extra.skipAuthFile) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, "auth.json"),
      JSON.stringify({ access_token: "fake-token", email: "test@example.com" }, null, 2)
    );
  }

  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    GROK_HOME: home,
    ...extra.env
  };
}
