import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "grok-companion");
const STATE_FILE_NAME = "state.json";
const LOCK_FILE_NAME = "state.json.lock";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const LOCK_TIMEOUT_MS = 5000;
// The critical section is a small read and write — single-digit milliseconds.
// A lock file older than this belongs to a process that died holding it.
const LOCK_STALE_MS = 5000;
const LOCK_RETRY_MS = 10;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Background runs are separate processes sharing one index file, so every
 * read-modify-write has to be exclusive. Without this, two jobs starting at the
 * same moment each read an index that lacks the other and the second write
 * wins, dropping a job that is running perfectly well — or reducing it to an
 * id-only stub when its next progress patch lands on state it is missing from.
 *
 * Best effort by design: a lock that cannot be taken is abandoned rather than
 * throwing, because losing an index entry is a far smaller failure than
 * refusing to run a review.
 */
function withStateLock(cwd, fn) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, LOCK_FILE_NAME);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let held = false;

  while (!held && Date.now() <= deadline) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      held = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        break;
      }
      // A process killed mid-write leaves its lock behind forever otherwise.
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        // The holder released it between our open and our stat; just retry.
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Already released.
      }
    }
  }
}

/**
 * Rename is atomic, so a concurrent reader sees either the old index or the new
 * one and never a half-written file it would parse as empty and then overwrite.
 */
function writeFileAtomic(filePath, contents) {
  const tempPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  fs.writeFileSync(tempPath, contents, "utf8");
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);

function isActiveJob(job) {
  return ACTIVE_JOB_STATUSES.has(job?.status);
}

function byUpdatedAtDesc(left, right) {
  return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
}

/**
 * Every background run is its own process writing to one shared index, so the
 * snapshot a caller mutated is routinely stale by the time it saves. Union the
 * caller's jobs over whatever is on disk now — a job this caller has never
 * heard of belongs to a concurrent run and must survive, otherwise the two
 * background jobs delete each other.
 */
function mergeJobs(diskJobs, callerJobs) {
  const merged = new Map();
  for (const job of diskJobs) {
    if (job?.id) {
      merged.set(job.id, job);
    }
  }
  for (const job of callerJobs) {
    if (!job?.id) {
      continue;
    }
    const existing = merged.get(job.id);
    merged.set(job.id, existing ? { ...existing, ...job } : job);
  }
  return [...merged.values()];
}

/**
 * Active jobs are never evicted by the cap. Their worker is still appending to
 * the log and job file, so dropping one both orphans a run that is in flight
 * and deletes the artifacts it is still writing.
 */
function pruneJobs(jobs) {
  const sorted = [...jobs].sort(byUpdatedAtDesc);
  const active = sorted.filter(isActiveJob);
  const inactive = sorted.filter((job) => !isActiveJob(job));
  const inactiveBudget = Math.max(0, MAX_JOBS - active.length);
  return [...active, ...inactive.slice(0, inactiveBudget)].sort(byUpdatedAtDesc);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function saveStateLocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(mergeJobs(previousJobs, state.jobs ?? []));
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateLocked(cwd, state));
}

/**
 * Load, mutate and save as one critical section. Splitting them would reopen
 * the window this lock exists to close: a patch computed against state read
 * before another process wrote would silently revert that process's fields.
 */
export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateLocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  // Atomic so `/grok:status` polling a running job never reads a partial record.
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
