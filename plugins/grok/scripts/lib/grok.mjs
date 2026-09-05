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
// Reasoning arrives as deltas; accumulate at least this many characters before
// surfacing a progress line so the log reads as thoughts rather than tokens.
const THOUGHT_FLUSH_CHARS = 160;
// How much prior conversation to seed into a transferred Grok session.
const TRANSFER_CONTEXT_MAX_CHARS = 120_000;
// First tail window tried when reading a Claude transcript. JSONL carries heavy
// per-record metadata, so this comfortably covers the text budget above in one
// read for typical transcripts; buildTransferContext widens it when it does not.
const TRANSFER_TAIL_INITIAL_BYTES = 1024 * 1024;
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";
const DEFAULT_GROK_BIN = "grok";
// Windows caps the whole command line at 32,767 characters, and an inline
// review diff alone can run to 256 KB. Past this length the prompt goes over
// as a file instead of on argv.
const PROMPT_FILE_THRESHOLD_CHARS = 24_000;

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
  // A prompt file stands in for `-p` when the prompt is too long for argv.
  const args = options.promptFile
    ? ["--prompt-file", options.promptFile, "--output-format", options.outputFormat ?? "streaming-json"]
    : ["-p", prompt, "--output-format", options.outputFormat ?? "streaming-json"];

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
    // Grok constrains every assistant message with this, not only the final
    // one, and a constrained grok-4.6 turn does not call tools: it emits a
    // schema-shaped stub and stops. Only pass a schema for turns that need no
    // tools — a re-emit of an answer the session already holds.
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
  // `--verbatim` still applies to a prompt file, so nothing is truncated.
  let promptDir = null;
  let promptFile = null;
  if (prompt.length > PROMPT_FILE_THRESHOLD_CHARS) {
    promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-companion-prompt-"));
    promptFile = path.join(promptDir, "prompt.txt");
    fs.writeFileSync(promptFile, prompt, "utf8");
  }
  const discardPromptFile = () => {
    if (!promptDir) {
      return;
    }
    try {
      fs.rmSync(promptDir, { recursive: true, force: true });
    } catch {
      // Best effort; the CLI has already read it.
    }
    promptDir = null;
  };
  const args = buildGrokHeadlessArgs(prompt, {
    cwd,
    promptFile,
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
    // A single agent turn emits many assistant messages: narration before a tool
    // call, then the real answer after it. Each message is one segment; `text`
    // deltas append to the open segment and a tool call closes it. Gluing them
    // all into one string is what produced runs of back-to-back JSON objects
    // that no parser could accept.
    /** @type {string[]} */
    const messageSegments = [];
    let openSegment = "";
    /** @type {string[]} */
    let reasoningSummary = [];
    /** @type {object[]} */
    const events = [];
    let structuredOutput = null;
    let stopReason = null;
    let errorMessage = null;
    let settled = false;
    let streamEnded = false;
    // `exitCode` is null for a signalled process, so it cannot double as the
    // "has the child closed yet" flag.
    let childClosed = false;
    let exitCode = null;
    let exitSignal = null;
    let pendingThought = "";

    const closeSegment = () => {
      const segment = openSegment.trim();
      openSegment = "";
      if (segment) {
        messageSegments.push(segment);
      }
    };

    /** Emit whatever reasoning has accumulated as one readable progress line. */
    const flushThought = () => {
      const thought = pendingThought.trim();
      pendingThought = "";
      if (!thought || reasoningSummary.includes(thought)) {
        return;
      }
      reasoningSummary.push(thought);
      emitLogEvent(options.onProgress, {
        message: `Reasoning: ${shorten(thought, 96)}`,
        phase: "investigating",
        logTitle: "Reasoning",
        logBody: thought
      });
    };

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

      // Any other event ends the current run of reasoning deltas, so flush what
      // has accumulated before reporting it — otherwise a trailing partial
      // thought is dropped and progress lines arrive out of order.
      if (event.type !== "thought") {
        flushThought();
      }

      switch (event.type) {
        case "text": {
          openSegment += String(event.data ?? "");
          break;
        }
        case "thought": {
          // Grok streams reasoning as deltas, often a single token per event.
          // Emitting one progress line each would bury the actual output under
          // hundreds of one-word lines, so deltas are accumulated and flushed
          // only once they amount to something a human can read.
          pendingThought += String(event.data ?? "");
          if (pendingThought.length >= THOUGHT_FLUSH_CHARS) {
            flushThought();
          }
          break;
        }
        case "tool_call": {
          // A tool call ends the assistant message that preceded it.
          closeSegment();
          const phase = toolCallPhase(event);
          emitProgress(options.onProgress, describeToolCall(event), phase);
          break;
        }
        case "tool_call_update": {
          closeSegment();
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
          closeSegment();
          emitProgress(options.onProgress, "Plan updated.", "investigating");
          break;
        }
        case "end": {
          closeSegment();
          if (event.sessionId) {
            sessionId = event.sessionId;
          }
          if (event.stopReason) {
            stopReason = String(event.stopReason);
          }
          // Grok parses and schema-validates the structured answer itself when
          // `--json-schema` is set. That object is authoritative — re-deriving it
          // from the text stream is what made well-formed runs look malformed.
          if (event.structuredOutput && typeof event.structuredOutput === "object") {
            structuredOutput = event.structuredOutput;
          }
          if (typeof event.result === "string" && event.result.trim() && messageSegments.length === 0) {
            messageSegments.push(event.result.trim());
          }
          emitProgress(options.onProgress, "Grok turn completed.", "finalizing", {
            threadId: sessionId
          });
          break;
        }
        case "error": {
          closeSegment();
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
      discardPromptFile();
      reject(error);
    });

    // The last stdout line carries the session id and the structured answer, so
    // resolving the moment the process exits can drop the very thing the caller
    // came for. Settle only once the process has exited *and* readline has
    // drained every buffered line.
    const settle = () => {
      if (settled || !streamEnded || !childClosed) {
        return;
      }
      settled = true;
      discardPromptFile();
      // A run can end mid-thought or mid-message; keep those fragments.
      flushThought();
      closeSegment();

      const cleaned = cleanStderr(stderr);
      // A signalled process reports a null exit code, so anything that is not a
      // clean 0 is a failure. Treating null as success would make a cancelled
      // run — /grok:cancel kills the process tree — look like it completed, and
      // store whatever partial output it had managed to emit as the result.
      const status = exitCode === 0 && !errorMessage ? 0 : 1;
      const finalSegment = messageSegments.length > 0 ? messageSegments[messageSegments.length - 1] : "";
      // Segments are separate assistant messages. Joining them bare ran the last
      // word of one into the first word of the next; a blank line keeps the
      // transcript readable and keeps adjacent JSON objects distinguishable.
      const finalMessage = messageSegments.join("\n\n") || (errorMessage ?? "");

      resolve({
        status,
        threadId: sessionId,
        turnId: null,
        finalMessage,
        finalSegment,
        messageSegments,
        structuredOutput,
        stopReason,
        reviewText: finalMessage,
        reasoningSummary,
        error: errorMessage
          ? { message: errorMessage }
          : exitSignal
            ? { message: cleaned || `grok was terminated by signal ${exitSignal}` }
            : exitCode !== 0
              ? { message: cleaned || `grok exited with code ${exitCode}` }
              : null,
        exitCode,
        exitSignal,
        stderr: cleaned,
        fileChanges: [],
        touchedFiles: collectTouchedFilesFromEvents(events),
        commandExecutions: events.filter((e) => e.type === "tool_call" && /run_terminal|bash|shell|execute/i.test(String(e.toolName ?? e.kind ?? ""))),
        events,
        pid: child.pid ?? null
      });
    };

    rl.on("close", () => {
      streamEnded = true;
      settle();
    });

    child.on("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      childClosed = true;
      settle();
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
// Enough of the file list to pin scope without swamping the prompt.
const MAX_SCOPE_FILES_IN_PROMPT = 40;

function formatScopeFiles(files) {
  const listed = files.slice(0, MAX_SCOPE_FILES_IN_PROMPT).join(", ");
  const remaining = files.length - MAX_SCOPE_FILES_IN_PROMPT;
  return remaining > 0 ? `${listed}, and ${remaining} more` : listed;
}

export async function runAppServerReview(cwd, options = {}) {
  const target = options.target;
  let reviewPrompt;
  if (target?.type === "baseBranch") {
    // Naming only the base branch leaves the range to the model, and `git diff
    // <base>` or the diff of a merge commit sweeps in upstream work the branch
    // merely merged in. The caller already resolved the range; state it.
    const range = target.commitRange ?? `${target.branch}...HEAD`;
    reviewPrompt = [
      "Perform a thorough code review of the changes on this branch compared to the base branch.",
      `Base branch: ${target.branch}`,
      `Review exactly this range: \`git diff ${range}\`. Run that range verbatim.`,
      `Do not use \`git diff ${target.branch}\`, \`git show HEAD\`, or the diff of a merge commit: this branch may have merged the base branch in, and those include unrelated upstream changes.`,
      ...(target.changedFiles?.length
        ? [
            `Only these ${target.changedFiles.length} file(s) are in scope: ${formatScopeFiles(target.changedFiles)}.`,
            "Do not report findings against any file outside that list."
          ]
        : []),
      "Report concrete findings with severity, file paths, and line ranges when possible.",
      "Do not modify any files."
    ].join("\n");
  } else {
    reviewPrompt = [
      "Perform a thorough code review of the current uncommitted working tree changes.",
      "Use git status and git diff (staged and unstaged) to inspect the changes.",
      "Review only uncommitted work. Do not review committed history.",
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
    // Match the adversarial-review path, which has always run under the
    // read-only profile. Grok can still reach a shell here, so this is defence
    // in depth rather than a hard guarantee — see runGrokTurn's note on
    // read-only enforcement.
    sandbox: "read-only",
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
 * Pull the conversational text out of Claude transcript JSONL lines.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractTranscriptExcerpts(text) {
  const excerpts = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
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
  return excerpts;
}

/**
 * Read the last `window` bytes of a file as UTF-8.
 *
 * The read always ends at EOF, so only the leading edge can land mid-character —
 * and the caller discards that partial line anyway.
 */
function readTailUtf8(sourcePath, size, window) {
  const start = Math.max(0, size - window);
  const length = size - start;
  if (length === 0) {
    return "";
  }
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(sourcePath, "r");
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  return buffer.toString("utf8");
}

/**
 * Build the transfer prompt's context block from the tail of a Claude transcript.
 *
 * Only the last `maxChars` of conversation survive into the prompt, so reading
 * and parsing the whole file to throw nearly all of it away is wasted work —
 * real transcripts reach tens of megabytes. Instead this reads a tail window and
 * widens it only if the window did not yield enough conversation, which keeps
 * the common case to a single small read while still producing exactly what a
 * full read would have produced.
 */
function buildTransferContext(sourcePath, maxChars) {
  const { size } = fs.statSync(sourcePath);
  let window = Math.min(TRANSFER_TAIL_INITIAL_BYTES, size);

  for (;;) {
    const readWholeFile = window >= size;
    const text = readTailUtf8(sourcePath, size, window);

    // A tail read almost always starts mid-record; that fragment is not valid
    // JSON and must not be mistaken for a real turn.
    let usable = text;
    if (!readWholeFile) {
      const firstBreak = text.indexOf("\n");
      usable = firstBreak === -1 ? "" : text.slice(firstBreak + 1);
    }

    const body = extractTranscriptExcerpts(usable).join("\n\n");
    if (body.length > maxChars) {
      return `…(truncated)…\n\n${body.slice(-maxChars)}`;
    }
    if (readWholeFile) {
      return body;
    }
    window = Math.min(window * 4, size);
  }
}

/**
 * Transfer a Claude session by seeding a new Grok session with transcript context.
 * Grok does not import Claude JSONL natively; we seed context via headless prompt.
 */
export async function importExternalAgentSession(cwd, options = {}) {
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }

  const body = buildTransferContext(options.sourcePath, TRANSFER_CONTEXT_MAX_CHARS);

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
    // Without this the CLI keeps only the first 20 KB of the seed and offloads
    // the rest to a file — most of the transferred context, silently.
    verbatim: true,
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

/**
 * Walk `text` as JSON, tracking string state so braces inside string literals
 * are not mistaken for structure.
 *
 * @returns {{ objects: string[], openStack: string[], openStart: number, inString: boolean }}
 */
function scanJsonStructure(text) {
  /** @type {string[]} */
  const objects = [];
  /** @type {string[]} */
  const stack = [];
  let openStart = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      if (stack.length === 0) {
        openStart = index;
      }
      stack.push(char);
    } else if (char === "}" || char === "]") {
      if (stack.length > 0) {
        stack.pop();
        if (stack.length === 0 && openStart !== -1) {
          objects.push(text.slice(openStart, index + 1));
          openStart = -1;
        }
      }
    }
  }

  return { objects, openStack: stack, openStart, inString };
}

/**
 * Close the containers a truncated JSON fragment left open.
 *
 * A fragment can end anywhere — mid-string, after a dangling comma, or on a key
 * with no value yet — so the caller retries this over shrinking prefixes rather
 * than trusting any single close to parse.
 */
function closeOpenStructures(fragment) {
  const { openStack, inString } = scanJsonStructure(fragment);
  if (openStack.length === 0) {
    return fragment;
  }

  let text = inString ? `${fragment}"` : fragment;
  text = text.replace(/[,\s]+$/, "");
  // Drop a key whose value never arrived, then any comma it left behind.
  text = text.replace(/,?\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, "").replace(/[,\s]+$/, "");
  for (let index = openStack.length - 1; index >= 0; index -= 1) {
    text += openStack[index] === "{" ? "}" : "]";
  }
  return text;
}

// Bound the salvage search so a large malformed blob cannot spin for long.
const MAX_REPAIR_ATTEMPTS = 400;

/**
 * Recover the largest parseable prefix of a truncated JSON fragment.
 *
 * A review cut off by the output-token budget still contains every finding that
 * was emitted before the cut; discarding all of them because the last one is
 * half-written throws away the entire run.
 */
function repairTruncatedJson(fragment) {
  const boundaries = [fragment.length];
  for (let index = fragment.length - 1; index >= 0 && boundaries.length <= MAX_REPAIR_ATTEMPTS; index -= 1) {
    const char = fragment[index];
    if (char === "}" || char === "]") {
      boundaries.push(index + 1);
    }
  }

  for (const end of boundaries) {
    const candidate = closeOpenStructures(fragment.slice(0, end));
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // Shrink further and retry.
    }
  }
  return null;
}

function stripCodeFences(text) {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim()).filter(Boolean);
  return blocks;
}

/**
 * Collect every plausible JSON payload in one assistant message, newest first.
 *
 * Grok narrates between tool calls, and under a JSON schema that narration is
 * itself JSON — so a message can hold several complete objects. The last one is
 * the answer; earlier ones are drafts.
 */
function collectJsonCandidates(text) {
  const candidates = [];
  const trimmed = text.trim();
  if (!trimmed) {
    return candidates;
  }

  const fenced = stripCodeFences(trimmed);
  for (const block of [...fenced].reverse()) {
    candidates.push(...scanJsonStructure(block).objects.reverse(), block);
  }

  candidates.push(...scanJsonStructure(trimmed).objects.reverse());
  candidates.push(trimmed);
  return candidates;
}

function describeTruncation(stopReason) {
  if (!stopReason || stopReason === "end_turn" || stopReason === "stop") {
    return null;
  }
  if (/max.?tokens|length|truncat/i.test(stopReason)) {
    return `Grok stopped early (stopReason: ${stopReason}), so its JSON was cut off mid-object.`;
  }
  return `Grok stopped with stopReason: ${stopReason}.`;
}

/**
 * Turn a Grok run's output into the structured object a review expects.
 *
 * @param {string} rawOutput full assistant text, used for display and as a last resort
 * @param {{ structuredOutput?: object|null, segments?: string[], stopReason?: string|null, failureMessage?: string|null }} [fallback]
 */
export function parseStructuredOutput(rawOutput, fallback = {}) {
  const stopReason = fallback.stopReason ?? null;
  const truncationNote = describeTruncation(stopReason);

  // Grok already parsed and schema-validated this when `--json-schema` was set.
  if (fallback.structuredOutput && typeof fallback.structuredOutput === "object" && !Array.isArray(fallback.structuredOutput)) {
    return {
      parsed: fallback.structuredOutput,
      parseError: null,
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  const segments = Array.isArray(fallback.segments) ? fallback.segments.filter((segment) => String(segment ?? "").trim()) : [];
  const text = String(rawOutput ?? "").trim();

  if (!text && segments.length === 0) {
    return {
      parsed: null,
      parseError: fallback.failureMessage || truncationNote || "Grok did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  // The final assistant message first, then earlier ones, then the whole blob.
  const sources = [...[...segments].reverse(), text].filter(Boolean);
  const matchesShape = typeof fallback.shapeCheck === "function" ? fallback.shapeCheck : null;
  let looseMatch = null;

  for (const source of sources) {
    for (const candidate of collectJsonCandidates(source)) {
      let parsed;
      try {
        parsed = JSON.parse(candidate);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      if (!matchesShape || matchesShape(parsed)) {
        return { parsed, parseError: null, rawOutput, ...fallback };
      }
      // Keep the newest object that at least parsed, in case nothing matches the
      // expected shape — a wrong-shaped answer still beats no answer at all.
      looseMatch ??= parsed;
    }
  }

  if (looseMatch) {
    return { parsed: looseMatch, parseError: null, rawOutput, ...fallback };
  }

  // Nothing parsed cleanly — the output is most likely cut off. Salvage it.
  for (const source of sources) {
    const { openStack, openStart } = scanJsonStructure(source);
    if (openStack.length === 0 || openStart === -1) {
      continue;
    }
    const repaired = repairTruncatedJson(source.slice(openStart));
    if (repaired) {
      return {
        parsed: repaired,
        parseError: null,
        recovered: "truncated-json",
        rawOutput,
        ...fallback
      };
    }
  }

  return {
    parsed: null,
    parseError: truncationNote
      ? `${truncationNote} Could not recover a usable object from it.`
      : "Could not parse structured JSON from Grok output.",
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
