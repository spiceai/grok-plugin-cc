import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(HERE, "..");

/**
 * The two plugins under comparison.
 *
 * The Grok plugin is a retarget of OpenAI's Codex plugin, so Codex is the
 * natural control: same command surface, same forwarder design, same companion
 * structure — differing only in which CLI it drives. Anything Grok does worse
 * here is a retarget regression rather than an inherent limit of the design,
 * which is exactly the distinction the A/B is for.
 *
 * `cliInvocation` distinguishes a real model turn from a readiness probe. The
 * two CLIs are shaped differently: Grok takes a headless prompt (`grok -p …`)
 * while Codex drives a long-lived JSON-RPC process (`codex app-server`), so a
 * single argv rule cannot cover both.
 */
export const PROVIDERS = {
  grok: {
    id: "grok",
    label: "grok",
    pluginDir: path.join(REPO_ROOT, "plugins", "grok"),
    rescueAgent: "grok:grok-rescue",
    binName: "grok",
    realBinEnvVar: "GROK_REAL_BIN",
    defaultRealBin: path.join(os.homedir(), ".grok", "bin", "grok"),
    // Force resolution through the shim even if the developer's shell already
    // exports GROK_BIN pointing at the real binary.
    extraEnv: (shimDir) => ({ GROK_BIN: path.join(shimDir, "grok") }),
    progressMarker: "\\[grok\\]",
    isCliInvocation: (argv) => argv.includes("-p") || argv.includes("--single")
  },
  codex: {
    id: "codex",
    label: "codex",
    pluginDir: process.env.CODEX_PLUGIN_DIR || "/Users/lukim/.claude/plugins/cache/openai-codex/codex/1.0.6",
    rescueAgent: "codex:codex-rescue",
    binName: "codex",
    realBinEnvVar: "CODEX_REAL_BIN",
    defaultRealBin: path.join(os.homedir(), ".local", "bin", "codex"),
    extraEnv: () => ({}),
    progressMarker: "\\[codex\\]",
    isCliInvocation: (argv) => argv.includes("app-server") || argv.includes("exec")
  }
};

/**
 * Substitute provider-specific values into an eval definition so one suite can
 * be graded against either plugin.
 */
export function materializeEval(evalDef, provider) {
  const substitutions = {
    "{{RESCUE_AGENT}}": provider.rescueAgent,
    "{{PROGRESS_MARKER}}": provider.progressMarker,
    "{{PROVIDER}}": provider.label
  };

  // Walk the structure rather than substituting into serialized JSON: the
  // replacements include regex escapes like `\[grok\]`, which are not valid
  // JSON string escapes and would corrupt the document on reparse.
  const walk = (value) => {
    if (typeof value === "string") {
      let out = value;
      for (const [token, replacement] of Object.entries(substitutions)) {
        out = out.replaceAll(token, replacement);
      }
      return out;
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };

  return walk(evalDef);
}
