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
saveState(state);

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
  if (parsed.flags.jsonSchema) {
    finalText = JSON.stringify({
      verdict: "needs changes",
      summary: "Found one material issue in the change set.",
      findings: [
        {
          severity: "high",
          title: "Missing null check",
          body: "The new parser assumes input is always present.",
          file: "src/main.ts",
          line_start: 12,
          line_end: 18,
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
