import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

/**
 * Transparent tracing shim shared by every provider's fake-named binary.
 *
 * The harness puts the shim directory at the front of PATH so whatever the
 * plugin shells out to (`grok`, `codex`) lands here first. Each invocation is
 * appended to $EVAL_TRACE_LOG as one JSON line and then handed straight to the
 * real binary with stdio passed through untouched — the provider still does all
 * the real work, we only get to see the exact argv the plugin built.
 *
 * @param {string} realBinEnvVar env var naming the real binary's absolute path
 * @param {string} fallbackBin   used when that env var is unset
 */
export function runTraceShim(realBinEnvVar, fallbackBin) {
  const argv = process.argv.slice(2);
  const traceLog = process.env.EVAL_TRACE_LOG;
  const realBin = process.env[realBinEnvVar] || fallbackBin;

  // A prompt handed over as a file is deleted by the companion once the run
  // ends, so its text has to be captured now for the grader to see it.
  let promptFileText = null;
  const promptFileIndex = argv.indexOf("--prompt-file");
  if (promptFileIndex !== -1 && argv[promptFileIndex + 1]) {
    try {
      promptFileText = fs.readFileSync(argv[promptFileIndex + 1], "utf8");
    } catch {
      // Best effort, like the trace itself.
    }
  }

  if (traceLog) {
    try {
      fs.appendFileSync(
        traceLog,
        `${JSON.stringify({
          argv,
          cwd: process.cwd(),
          startedAt: new Date().toISOString(),
          ...(promptFileText !== null ? { promptFileText } : {})
        })}\n`
      );
    } catch {
      // Tracing is best-effort. Never break the run being graded.
    }
  }

  const child = spawn(realBin, argv, { stdio: "inherit" });

  child.on("error", (error) => {
    process.stderr.write(`trace-shim: could not exec ${realBin}: ${error.message}\n`);
    process.exit(127);
  });

  child.on("close", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}
