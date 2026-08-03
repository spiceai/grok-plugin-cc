/**
 * Grok Build CLI runtime for the Claude Code companion plugin.
 * Uses headless mode (`grok -p`) with streaming-json for progress and session resume.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable } from "./process.mjs";

const SERVICE_PREFIX = "Grok Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";
const DEFAULT_GROK_BIN = "grok";

/**
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 */

function resolveGrokBinary(env = process.env) {
  return env.GROK_BIN || env.GROK_PATH || DEFAULT_GROK_BIN;
}

function resolveGrokHome(env = process.env) {
  return path.resolve(env.GROK_HOME || path.join(os.homedir(), ".grok"));
}

function cleanStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !/auto.?update/i.test(line))
    .join("\n");
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }
  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${SERVICE_PREFIX}: ${excerpt}` : SERVICE_PREFIX;
}

function toolCallPhase(event) {
  const kind = String(event.kind ?? event.toolName ?? "").toLowerCase();
  const title = String(event.title ?? event.toolName ?? "");
  if (kind.includes("edit") || kind.includes("write") || /search_replace|write_file|edit/i.test(title)) {
    return "editing";
  }
  if (kind.includes("execute") || kind.includes("bash") || /run_terminal|bash|shell/i.test(title)) {
    const command = event.rawInput?.command ?? event.rawInput?.cmd ?? title;
    return looksLikeVerificationCommand(String(command)) ? "verifying" : "running";
  }
  if (kind.includes("search") || kind.includes("read") || kind.includes("grep")) {
    return "investigating";
  }
  return "investigating";
}

function describeToolCall(event) {
  const title = event.title || event.toolName || "tool";
  const command = event.rawInput?.command ?? event.rawInput?.cmd;
  if (command) {
    return `Running command: ${shorten(command, 96)}`;
  }
  const filePath = event.rawInput?.path ?? event.rawInput?.target_file ?? event.rawInput?.file_path;
  if (filePath) {
    return `${title}: ${shorten(filePath, 96)}`;
  }
  return `Tool: ${shorten(title, 96)}`;
}

function collectTouchedFilesFromEvents(events) {
  const paths = new Set();
  for (const event of events) {
    if (event.type !== "tool_call" && event.type !== "tool_call_update") {
      continue;
    }
    const kind = String(event.kind ?? event.toolName ?? "").toLowerCase();
    if (!/edit|write|search_replace|write_file/.test(kind) && !/search_replace|write_file|edit/i.test(String(event.toolName ?? ""))) {
      continue;
    }
    const filePath = event.rawInput?.path ?? event.rawInput?.target_file ?? event.rawInput?.file_path;
    if (filePath) {
      paths.add(filePath);
    }
    for (const location of event.locations ?? []) {
      if (location?.path) {
        paths.add(location.path);
      }
    }
  }
  return [...paths];
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: "xai",
    ...fields
  };
}

function readAuthFile(env = process.env) {
  const authPath = path.join(resolveGrokHome(env), "auth.json");
  if (!fs.existsSync(authPath)) {
    return null;
  }
  try {
    return readJsonFile(authPath);
  } catch {
    return null;
  }
}

export function getGrokAvailability(cwd, env = process.env) {
  const bin = resolveGrokBinary(env);
  const versionStatus = binaryAvailable(bin, ["--version"], { cwd, env });
  if (!versionStatus.available) {
    return versionStatus;
  }

  return {
    available: true,
    detail: versionStatus.detail,
    binary: bin
  };
}

export function getSessionRuntimeStatus(_env = process.env, _cwd = process.cwd()) {
  return {
    mode: "headless",
    label: "headless CLI",
    detail: "Each review or task runs through Grok Build headless mode (`grok -p`).",
    endpoint: null
  };
}

export async function getGrokAuthStatus(cwd, options = {}) {
  const env = options.env ?? process.env;
  const availability = getGrokAvailability(cwd, env);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  if (env.XAI_API_KEY && String(env.XAI_API_KEY).trim()) {
    return buildAuthStatus({
      loggedIn: true,
      detail: "XAI_API_KEY is set",
      source: "env",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth: false
    });
  }

  const auth = readAuthFile(env);
  if (!auth || typeof auth !== "object") {
    return buildAuthStatus({
      loggedIn: false,
      detail: "No Grok credentials found. Run `!grok login` or set XAI_API_KEY.",
      source: "auth-file",
      requiresOpenaiAuth: false
    });
  }

  const hasToken =
    Boolean(auth.access_token) ||
    Boolean(auth.accessToken) ||
    Boolean(auth.refresh_token) ||
    Boolean(auth.refreshToken) ||
    Boolean(auth.token) ||
    Boolean(auth.session) ||
    Object.keys(auth).length > 0;

  if (!hasToken) {
    return buildAuthStatus({
      loggedIn: false,
      detail: "Grok auth file is empty. Run `!grok login` or set XAI_API_KEY.",
      source: "auth-file",
      requiresOpenaiAuth: false
    });
  }

  const email =
    (typeof auth.email === "string" && auth.email.trim()) ||
    (typeof auth.user?.email === "string" && auth.user.email.trim()) ||
    null;

  return buildAuthStatus({
    loggedIn: true,
    detail: email ? `Logged in as ${email}` : "Grok credentials present",
    source: "auth-file",
    authMethod: "oauth",
    verified: true,
    requiresOpenaiAuth: false
  });
}

/**
 * Build argv for a headless Grok invocation.
 */
export function buildGrokHeadlessArgs(prompt, options = {}) {
  const args = ["-p", prompt, "--output-format", options.outputFormat ?? "streaming-json"];

  if (options.cwd) {
    args.push("--cwd", options.cwd);
  }
  if (options.model) {
    args.push("-m", String(options.model));
  }
  if (options.effort) {
    args.push("--effort", String(options.effort));
  }
  if (options.resumeSessionId) {
    args.push("--resume", String(options.resumeSessionId));
  }
  if (options.sessionId) {
    args.push("--session-id", String(options.sessionId));
  }
  if (options.write) {
    args.push("--always-approve");
  } else {
    // Read-only: allow investigation tools but block edits.
    args.push(
      "--always-approve",
      "--disallowed-tools",
      "search_replace,write,image_gen,image_edit,image_to_video,reference_to_video"
    );
  }
  if (options.sandbox) {
    args.push("--sandbox", String(options.sandbox));
  }
  if (options.maxTurns != null) {
    args.push("--max-turns", String(options.maxTurns));
  }
  if (options.outputSchema) {
    args.push("--json-schema", typeof options.outputSchema === "string" ? options.outputSchema : JSON.stringify(options.outputSchema));
  }
  if (options.rules) {
    args.push("--rules", String(options.rules));
  }
  if (options.verbatim) {
    args.push("--verbatim");
  }
  args.push("--no-auto-update");

  return args;
}

/**
 * Run a headless Grok turn and stream progress from streaming-json events.
 *
 * @returns {Promise<{
 *   status: number,
 *   threadId: string | null,
 *   turnId: string | null,
 *   finalMessage: string,
 *   reasoningSummary: string[],
 *   error: { message: string } | null,
 *   stderr: string,
 *   fileChanges: unknown[],
 *   touchedFiles: string[],
 *   commandExecutions: unknown[],
 *   events: object[],
 *   pid: number | null
 * }>}
 */
export async function runGrokTurn(cwd, options = {}) {
  const env = options.env ?? process.env;
  const availability = getGrokAvailability(cwd, env);
  if (!availability.available) {
    throw new Error(
      "Grok Build CLI is not installed. Install it with `curl -fsSL https://x.ai/cli/install.sh | bash`, then rerun `/grok:setup`."
    );
  }

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Grok run.");
  }

  const bin = resolveGrokBinary(env);
  const args = buildGrokHeadlessArgs(prompt, {
    cwd,
    model: options.model,
    effort: options.effort,
    resumeSessionId: options.resumeSessionId ?? options.resumeThreadId ?? null,
    sessionId: options.sessionId ?? null,
    write: Boolean(options.write ?? (options.sandbox && options.sandbox !== "read-only")),
    sandbox: options.sandbox,
    maxTurns: options.maxTurns,
    outputSchema: options.outputSchema,
    rules: options.rules,
    verbatim: options.verbatim,
    outputFormat: "streaming-json"
  });

  emitProgress(options.onProgress, options.resumeSessionId || options.resumeThreadId ? `Resuming Grok session ${options.resumeSessionId || options.resumeThreadId}.` : "Starting Grok headless run.", "starting");

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    options.onSpawn?.(child);

    let stderr = "";
    let sessionId = options.resumeSessionId ?? options.resumeThreadId ?? null;
    let finalMessage = "";
    let textChunks = [];
    /** @type {string[]} */
    let reasoningSummary = [];
    /** @type {object[]} */
    const events = [];
    let errorMessage = null;
    let settled = false;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const line = String(chunk).trim();
      if (line) {
        emitLogEvent(options.onProgress, {
          message: shorten(line, 120),
          stderrMessage: line,
          phase: null
        });
      }
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    rl.on("line", (line) => {
      if (!line.trim()) {
        return;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      events.push(event);

      switch (event.type) {
        case "text": {
          const data = event.data ?? "";
          textChunks.push(data);
          finalMessage = textChunks.join("");
          break;
        }
        case "thought": {
          const thought = String(event.data ?? "").trim();
          if (thought && !reasoningSummary.includes(thought)) {
            reasoningSummary.push(thought);
            emitLogEvent(options.onProgress, {
              message: `Reasoning: ${shorten(thought, 96)}`,
              phase: "investigating",
              logTitle: "Reasoning",
              logBody: thought
            });
          }
          break;
        }
        case "tool_call": {
          const phase = toolCallPhase(event);
          emitProgress(options.onProgress, describeToolCall(event), phase);
          break;
        }
        case "tool_call_update": {
          if (event.status === "completed" || event.status === "failed") {
            const title = event.title || event.toolName || event.toolCallId || "tool";
            emitProgress(
              options.onProgress,
              `Tool ${event.status}: ${shorten(title, 96)}`,
              toolCallPhase(event)
            );
          }
          break;
        }
        case "plan": {
          emitProgress(options.onProgress, "Plan updated.", "investigating");
          break;
        }
        case "end": {
          if (event.sessionId) {
            sessionId = event.sessionId;
          }
          if (event.result && typeof event.result === "string" && !finalMessage) {
            finalMessage = event.result;
          }
          if (event.stopReason && event.stopReason !== "end_turn" && event.stopReason !== "stop") {
            // keep message; status decided by exit code
          }
          emitProgress(options.onProgress, "Grok turn completed.", "finalizing", {
            threadId: sessionId
          });
          break;
        }
        case "error": {
          errorMessage = event.message ?? "Grok reported an error.";
          emitProgress(options.onProgress, `Grok error: ${errorMessage}`, "failed");
          break;
        }
        default:
          break;
      }
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      rl.close();

      const cleaned = cleanStderr(stderr);
      const status = code === 0 && !errorMessage ? 0 : 1;
      if (!finalMessage && errorMessage) {
        finalMessage = errorMessage;
      }

      // Prefer last complete text if streaming left fragments.
      if (!finalMessage) {
        const endEvent = [...events].reverse().find((e) => e.type === "end");
        if (endEvent?.result) {
          finalMessage = String(endEvent.result);
        }
      }

      resolve({
        status,
        threadId: sessionId,
        turnId: null,
        finalMessage,
        reviewText: finalMessage,
        reasoningSummary,
        error: errorMessage ? { message: errorMessage } : code && code !== 0 ? { message: cleaned || `grok exited with code ${code}` } : null,
        stderr: cleaned,
        fileChanges: [],
        touchedFiles: collectTouchedFilesFromEvents(events),
        commandExecutions: events.filter((e) => e.type === "tool_call" && /run_terminal|bash|shell|execute/i.test(String(e.toolName ?? e.kind ?? ""))),
        events,
        pid: child.pid ?? null
      });
    });
  });
}

/** @deprecated Prefer runGrokTurn — kept for companion call sites that used app-server naming. */
export async function runAppServerTurn(cwd, options = {}) {
  return runGrokTurn(cwd, {
    ...options,
    write: options.write ?? (options.sandbox != null && options.sandbox !== "read-only"),
    resumeSessionId: options.resumeThreadId ?? options.resumeSessionId
  });
}

/** Native-style review: headless review prompt over git changes. */
export async function runAppServerReview(cwd, options = {}) {
  const target = options.target;
  let reviewPrompt;
  if (target?.type === "baseBranch") {
    reviewPrompt = [
      "Perform a thorough code review of the changes on this branch compared to the base branch.",
      `Base branch: ${target.branch}`,
      "Use git to inspect the diff against the base branch.",
      "Report concrete findings with severity, file paths, and line ranges when possible.",
      "Do not modify any files."
    ].join("\n");
  } else {
    reviewPrompt = [
      "Perform a thorough code review of the current uncommitted working tree changes.",
      "Use git status and git diff (staged and unstaged) to inspect the changes.",
      "Report concrete findings with severity, file paths, and line ranges when possible.",
      "Do not modify any files."
    ].join("\n");
  }

  if (options.extraFocus) {
    reviewPrompt += `\n\nAdditional focus: ${options.extraFocus}`;
  }

  const result = await runGrokTurn(cwd, {
    prompt: reviewPrompt,
    model: options.model,
    effort: options.effort,
    write: false,
    onProgress: options.onProgress,
    env: options.env,
    onSpawn: options.onSpawn
  });

  return {
    status: result.status,
    threadId: result.threadId,
    sourceThreadId: result.threadId,
    turnId: result.turnId,
    reviewText: result.finalMessage,
    reasoningSummary: result.reasoningSummary,
    turn: null,
    error: result.error,
    stderr: result.stderr
  };
}

/**
 * Transfer a Claude session by seeding a new Grok session with transcript context.
 * Grok does not import Claude JSONL natively; we seed context via headless prompt.
 */
export async function importExternalAgentSession(cwd, options = {}) {
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }

  const raw = fs.readFileSync(options.sourcePath, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const excerpts = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const role = entry.type === "user" || entry.message?.role === "user" ? "user" : entry.type === "assistant" || entry.message?.role === "assistant" ? "assistant" : null;
      const content =
        typeof entry.message?.content === "string"
          ? entry.message.content
          : Array.isArray(entry.message?.content)
            ? entry.message.content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("")
            : typeof entry.content === "string"
              ? entry.content
              : "";
      if (role && content.trim()) {
        excerpts.push(`[${role}] ${content.trim()}`);
      }
    } catch {
      // skip malformed lines
    }
  }

  const maxChars = 120_000;
  let body = excerpts.join("\n\n");
  if (body.length > maxChars) {
    body = `…(truncated)…\n\n${body.slice(-maxChars)}`;
  }

  const prompt = [
    "You are continuing work transferred from a Claude Code session.",
    "Below is the prior conversation context. Absorb it; do not restate it in full.",
    "Reply with a short confirmation that you have the context and are ready to continue.",
    "",
    "<claude_session_context>",
    body || "(empty transcript)",
    "</claude_session_context>"
  ].join("\n");

  const result = await runGrokTurn(cwd, {
    prompt,
    write: false,
    onProgress: options.onProgress,
    env: options.env,
    maxTurns: 2
  });

  if (!result.threadId) {
    throw new Error(
      `Grok finished the transfer seed but did not return a session ID.${result.stderr ? `\n${result.stderr}` : ""}`
    );
  }

  return {
    threadId: result.threadId,
    stderr: result.stderr
  };
}

export async function interruptAppServerTurn(_cwd, { threadId, turnId } = {}) {
  // Headless Grok has no shared turn interrupt RPC; cancellation is process-tree kill.
  return {
    attempted: false,
    interrupted: false,
    transport: "headless",
    detail: threadId || turnId ? "Headless runs are cancelled by stopping the companion process." : "missing threadId or turnId"
  };
}

export async function findLatestTaskThread(_cwd) {
  // Session discovery is tracked via companion job state, not Grok's thread list API.
  return null;
}

export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Grok did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  const text = String(rawOutput).trim();

  // Prefer fenced JSON or a whole-string JSON object.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fenced?.[1]) {
    candidates.push(fenced[1].trim());
  }
  candidates.push(text);

  // Also try first { ... } block.
  const braceStart = text.indexOf("{");
  const braceEnd = text.lastIndexOf("}");
  if (braceStart !== -1 && braceEnd > braceStart) {
    candidates.push(text.slice(braceStart, braceEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      return {
        parsed: JSON.parse(candidate),
        parseError: null,
        rawOutput,
        ...fallback
      };
    } catch {
      // try next
    }
  }

  return {
    parsed: null,
    parseError: "Could not parse structured JSON from Grok output.",
    rawOutput,
    ...fallback
  };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

// Back-compat aliases used by companion/hooks during rename.
export const getCodexAvailability = getGrokAvailability;
export const getCodexAuthStatus = getGrokAuthStatus;

export { DEFAULT_CONTINUE_PROMPT, SERVICE_PREFIX as TASK_THREAD_PREFIX, resolveGrokBinary, resolveGrokHome };
