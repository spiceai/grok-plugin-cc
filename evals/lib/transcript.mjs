import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

/**
 * Collect everything observable about a single `claude -p` run.
 *
 * Three independent sources, because each answers a different question:
 *  - the main transcript says what the top-level thread did (did it edit files?
 *    did it spawn the rescue subagent, or quietly do the work itself?)
 *  - the subagent transcripts say whether the rescue subagent stayed a thin
 *    forwarder or wandered off reading the repo
 *  - the grok trace says exactly which argv the plugin handed to Grok
 *
 * @param {string} sessionId
 * @param {string} traceLogPath
 */
export function collectRunArtifacts(sessionId, traceLogPath, isCliInvocation = isGrokTurn) {
  const mainPath = findSessionTranscript(sessionId);
  const main = mainPath ? readJsonl(mainPath) : [];
  const subagents = mainPath ? readSubagentTranscripts(mainPath, sessionId) : [];
  const grokCalls = readJsonl(traceLogPath);

  return {
    transcriptPath: mainPath,
    main,
    subagents,
    grokCalls,
    mainToolCalls: toolCalls(main),
    grokTurns: grokCalls.filter((call) => isCliInvocation(call.argv ?? []))
  };
}

/**
 * A Grok "turn" is a real headless run (`grok -p <prompt> ...`). The companion
 * also shells out to `grok --version` for readiness checks; those are noise for
 * every assertion we care about, so they are filtered out here rather than in
 * each individual check.
 *
 * @param {{argv: string[]}} call
 */
export function isGrokTurn(argv) {
  const args = Array.isArray(argv) ? argv : (argv?.argv ?? []);
  return args.includes("-p") || args.includes("--single");
}

/**
 * @param {{argv: string[]}} call
 * @returns {string}
 */
export function grokPrompt(call) {
  const argv = call?.argv ?? [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "-p" || argv[i] === "--single") {
      return argv[i + 1] ?? "";
    }
  }
  return "";
}

/**
 * Flags are graded as an ordered run of tokens (`-m grok-build`) rather than a
 * loose "both appear somewhere" test, so a stray occurrence of the value in the
 * prompt text cannot make a flag assertion pass by accident.
 *
 * @param {string[]} argv
 * @param {string[]} tokens
 */
export function argvHasSequence(argv, tokens) {
  if (tokens.length === 0) {
    return true;
  }
  for (let i = 0; i <= argv.length - tokens.length; i += 1) {
    if (tokens.every((token, offset) => argv[i + offset] === token)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {object[]} rows
 */
export function toolCalls(rows) {
  const out = [];
  for (const row of rows) {
    const content = row?.message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (block?.type === "tool_use") {
        out.push({ name: block.name, input: block.input ?? {} });
      }
    }
  }
  return out;
}

/**
 * Everything the plugin's own commands printed back into Claude's context.
 *
 * This is deliberately separate from the user-visible response. The companion
 * can return a perfect review inside a Bash tool result and Claude can still
 * relay none of it — and a user staring at a collapsed tool call sees nothing.
 * Grading the two separately is what tells those cases apart.
 *
 * @param {object[]} rows
 */
export function toolResultText(rows) {
  const chunks = [];
  for (const row of rows) {
    const content = row?.message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (block?.type !== "tool_result") {
        continue;
      }
      const inner = block.content;
      if (typeof inner === "string") {
        chunks.push(inner);
      } else if (Array.isArray(inner)) {
        for (const part of inner) {
          if (part?.type === "text" && part.text) {
            chunks.push(part.text);
          }
        }
      }
    }
  }
  return chunks.join("\n");
}

/**
 * @param {object[]} rows
 */
export function assistantText(rows) {
  const chunks = [];
  for (const row of rows) {
    if (row?.type !== "assistant") {
      continue;
    }
    const content = row?.message?.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (block?.type === "text" && block.text) {
        chunks.push(block.text);
      }
    }
  }
  return chunks.join("\n");
}

function readSubagentTranscripts(mainPath, sessionId) {
  const dir = path.join(path.dirname(mainPath), sessionId, "subagents");
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const rows = readJsonl(path.join(dir, name));
    const metaPath = path.join(dir, name.replace(/\.jsonl$/, ".meta.json"));
    let meta = {};
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      } catch {
        meta = {};
      }
    }
    out.push({ file: name, agentType: meta.agentType ?? null, meta, rows, toolCalls: toolCalls(rows) });
  }
  return out;
}

/**
 * Claude Code encodes the working directory into the projects folder name. We
 * scan for the session file instead of recomputing that encoding, so the
 * harness keeps working if the scheme ever changes.
 *
 * @param {string} sessionId
 */
function findSessionTranscript(sessionId) {
  if (!fs.existsSync(PROJECTS_ROOT)) {
    return null;
  }
  for (const project of fs.readdirSync(PROJECTS_ROOT)) {
    const candidate = path.join(PROJECTS_ROOT, project, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) {
    return [];
  }
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      out.push(JSON.parse(line));
    } catch {
      // Partial trailing line while a run is still flushing; skip it.
    }
  }
  return out;
}
