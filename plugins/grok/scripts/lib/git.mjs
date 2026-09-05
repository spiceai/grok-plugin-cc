import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
// Lightweight context still inlines untracked files — they are in no diff — but
// only up to this much in total. The prompt reaches Grok whole, and a tree with
// dozens of untracked files (generated reports, runtime workspaces) otherwise
// inlines hundreds of kilobytes the model can read on demand instead.
const DEFAULT_LIGHTWEIGHT_UNTRACKED_MAX_BYTES = 64 * 1024;

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function normalizeMaxUntrackedInlineBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_LIGHTWEIGHT_UNTRACKED_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

/**
 * The exact commit range a branch review covers.
 *
 * Exported so callers that build their own review prompt can name the range
 * instead of naming the base branch and leaving the model to guess a command.
 */
export function getBranchReviewRange(cwd, baseRef) {
  const repoRoot = getRepoRoot(cwd);
  const comparison = buildBranchComparison(repoRoot, baseRef);
  return {
    ...comparison,
    changedFiles: gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange])
      .stdout.trim()
      .split("\n")
      .filter(Boolean)
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

function refExists(cwd, ref) {
  return git(cwd, ["show-ref", "--verify", "--quiet", ref]).status === 0;
}

/**
 * Of several refs naming the same branch, pick the one that forks from HEAD
 * most recently.
 *
 * A merge base that is an ancestor of another merge base is the older of the
 * two, and reviewing from it drags in every upstream commit made in between.
 * Comparing them directly keeps the review scoped to what this branch actually
 * added, whichever copy of the base branch happens to be stale.
 */
function pickNarrowestBase(cwd, refNames) {
  let bestRef = null;
  let bestMergeBase = null;

  for (const refName of refNames) {
    const mergeBase = git(cwd, ["merge-base", "HEAD", refName]);
    if (mergeBase.status !== 0) {
      continue;
    }
    const candidate = mergeBase.stdout.trim();
    if (!bestRef) {
      bestRef = refName;
      bestMergeBase = candidate;
      continue;
    }
    // `--is-ancestor` is reflexive, so equal merge bases would keep flipping the
    // choice on ordering alone. Only a strictly newer fork point wins, which
    // leaves the first-listed ref as the stable answer for a tie.
    if (candidate !== bestMergeBase && git(cwd, ["merge-base", "--is-ancestor", bestMergeBase, candidate]).status === 0) {
      bestRef = refName;
      bestMergeBase = candidate;
    }
  }

  // No shared history with anything (an unborn or unrelated HEAD) still leaves a
  // usable base name for the caller to diff against.
  return bestRef ?? refNames[0] ?? null;
}

/**
 * Resolve a default-branch *name* to the ref a review should diff against.
 *
 * `refs/remotes/origin/HEAD` tells us the branch is called `trunk`; it does not
 * mean the local `trunk` is current. On a feature branch nobody checks the base
 * branch out, so the local copy sits wherever it was months ago while
 * `origin/trunk` tracks reality. Diffing from the stale one puts every upstream
 * commit merged into the branch since then inside the review — the failure that
 * turned an 8-file change into 113 files of unrelated trunk work.
 */
function resolveBaseRefForName(cwd, name) {
  const refs = [];
  if (refExists(cwd, `refs/remotes/origin/${name}`)) {
    refs.push(`origin/${name}`);
  }
  if (refExists(cwd, `refs/heads/${name}`)) {
    refs.push(name);
  }
  if (refs.length === 0) {
    return null;
  }
  return pickNarrowestBase(cwd, refs);
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      const resolved = resolveBaseRefForName(cwd, remoteHead.slice("refs/remotes/origin/".length));
      if (resolved) {
        return resolved;
      }
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const resolved = resolveBaseRefForName(cwd, candidate);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

// A key no path can collide with, for the commit and ref HEAD points at.
const FINGERPRINT_HEAD_KEY = "\0HEAD";

function describeGitFailure(result) {
  return result.error?.message ?? result.stderr.trim() ?? `exit ${result.status}`;
}

/**
 * Size and mtime of what a path resolves to — through a symlink, so a write
 * to the target counts — falling back to the link itself when it dangles.
 */
function statDetail(absolutePath) {
  for (const probe of [fs.statSync, fs.lstatSync]) {
    try {
      const stat = probe(absolutePath);
      return `${stat.size}@${Math.round(stat.mtimeMs)}`;
    } catch {
      // Try the next probe.
    }
  }
  return "absent";
}

function isRegularFile(absolutePath) {
  try {
    return fs.statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

/**
 * A per-path fingerprint of everything uncommitted: the porcelain status code
 * and a content hash for every changed tracked file, size plus mtime for
 * untracked files, the commit and ref HEAD points at, and the hooks and config
 * git would run from. Taken before and after a review and compared, it catches
 * a run that modified the tree — or committed, stashed, checked something out,
 * or planted a hook — no matter what the sandbox did: `--sandbox` is a request
 * the CLI drops silently when the kernel policy cannot be applied.
 *
 * Content is hashed by `git hash-object`, which streams each file, so there is
 * no size past which the check quietly degrades; if any step fails the result
 * says so and the comparison reports the tree as unverified rather than
 * unchanged. Paths git ignores (build output, dependencies) are not covered.
 *
 * @returns {{ entries: Map<string, string>, incomplete: string | null }}
 */
export function fingerprintWorkingTree(cwd) {
  const entries = new Map();
  const status = git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.error || status.status !== 0) {
    return { entries, incomplete: `git status failed: ${describeGitFailure(status)}` };
  }

  const toHash = [];
  const records = status.stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    const code = record.slice(0, 2);
    const filePath = record.slice(3);
    // A rename or copy is followed by the original path as a record of its own.
    if (/[RC]/.test(code)) {
      index += 1;
    }
    const absolutePath = path.join(cwd, filePath);
    if (code === "??") {
      entries.set(filePath, `?? ${statDetail(absolutePath)}`);
    } else if (isRegularFile(absolutePath)) {
      entries.set(filePath, code);
      toHash.push(filePath);
    } else {
      // Deleted, a submodule, or a symlink: the status code and lstat cover it.
      entries.set(filePath, `${code} ${statDetail(absolutePath)}`);
    }
  }

  // Further edits to a tracked file that was already modified do not move its
  // status code, and can keep its size and line counts too; its content hash
  // cannot stay the same. One git process hashes every path.
  if (toHash.length > 0) {
    const hashed = git(cwd, ["hash-object", "--stdin-paths"], { input: `${toHash.join("\n")}\n` });
    if (hashed.error || hashed.status !== 0) {
      return { entries, incomplete: `git hash-object failed: ${describeGitFailure(hashed)}` };
    }
    const digests = hashed.stdout.trim().split("\n");
    if (digests.length !== toHash.length) {
      return { entries, incomplete: `git hash-object returned ${digests.length} digests for ${toHash.length} paths` };
    }
    toHash.forEach((filePath, index) => entries.set(filePath, `${entries.get(filePath)} ${digests[index]}`));
  }

  // A commit, stash, checkout or branch switch can leave the tree looking
  // untouched; HEAD moves.
  const head = git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
  const ref = git(cwd, ["symbolic-ref", "-q", "HEAD"]);
  entries.set(
    FINGERPRINT_HEAD_KEY,
    `${head.status === 0 ? head.stdout.trim() : "unborn"} ${ref.status === 0 ? ref.stdout.trim() : "detached"}`
  );

  // A hook or config written into the git directory shows nothing in the tree
  // and runs later, on the user's own git commands. In a linked worktree the
  // hooks and shared config live in the common directory, the per-worktree
  // config in the worktree's own; `core.hooksPath` can move the hooks anywhere.
  const dirs = git(cwd, ["rev-parse", "--git-dir", "--git-common-dir"]);
  if (dirs.error || dirs.status !== 0) {
    return { entries, incomplete: `git rev-parse failed: ${describeGitFailure(dirs)}` };
  }
  const [gitDirRaw, commonDirRaw] = dirs.stdout.trim().split("\n");
  const gitDir = path.resolve(cwd, gitDirRaw);
  const commonDir = path.resolve(cwd, commonDirRaw ?? gitDirRaw);
  const hooksPath = git(cwd, ["config", "--get", "core.hooksPath"]);
  const hooksDir =
    hooksPath.status === 0 && hooksPath.stdout.trim() ? path.resolve(cwd, hooksPath.stdout.trim()) : path.join(commonDir, "hooks");
  const watched = new Set([path.join(commonDir, "config"), path.join(gitDir, "config.worktree"), ...listHooks(hooksDir)]);
  for (const candidate of watched) {
    try {
      const stat = fs.statSync(candidate);
      const inCommon = path.relative(commonDir, candidate);
      const label = inCommon && !inCommon.startsWith("..") ? `.git/${inCommon}` : path.relative(cwd, candidate);
      entries.set(label, `${stat.size}@${Math.round(stat.mtimeMs)}`);
    } catch {
      // Absent is fine; it only matters if it appears.
    }
  }
  return { entries, incomplete: null };
}

function listHooks(hooksDir) {
  try {
    return fs
      .readdirSync(hooksDir)
      .filter((name) => !name.endsWith(".sample"))
      .map((name) => path.join(hooksDir, name));
  } catch {
    return [];
  }
}

/**
 * Compare two fingerprints: the paths whose entry differs, sorted, with a moved
 * HEAD reported as `HEAD`; and, when either snapshot could not be completed,
 * why — a partial comparison is not proof that nothing changed.
 *
 * An incomplete snapshot lacks the content hashes a complete one carries, so
 * comparing the two in full would report every hashed path as edited. When
 * either side is incomplete only the status codes are compared: new, deleted
 * and re-staged paths still show, content changes are what the unverified
 * flag is for.
 *
 * @returns {{ changed: string[], unverified: string | null }}
 */
export function diffWorkingTreeFingerprints(before, after) {
  const unverified = before.incomplete ?? after.incomplete ?? null;
  const comparable = (detail) => (unverified ? String(detail).split(" ")[0] : detail);
  const changed = new Set();
  for (const [filePath, detail] of before.entries) {
    if (!after.entries.has(filePath) || comparable(after.entries.get(filePath)) !== comparable(detail)) {
      changed.add(filePath);
    }
  }
  for (const [filePath, detail] of after.entries) {
    if (!before.entries.has(filePath) || comparable(before.entries.get(filePath)) !== comparable(detail)) {
      changed.add(filePath);
    }
  }
  return {
    changed: [...changed].map((filePath) => (filePath === FINGERPRINT_HEAD_KEY ? "HEAD" : filePath)).sort(),
    unverified
  };
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

/**
 * @returns {{ skipped: string } | { size: number, text: string }}
 */
function inspectUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return { skipped: "broken symlink or unreadable file" };
  }
  if (stat.isDirectory()) {
    return { skipped: "directory" };
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return { skipped: `${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit`, oversized: true };
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return { skipped: "broken symlink or unreadable file" };
  }
  if (!isProbablyText(buffer)) {
    return { skipped: "binary file" };
  }

  return { size: buffer.length, text: buffer.toString("utf8").trimEnd() };
}

function formatUntrackedFileBlock(relativePath, file) {
  if (file.skipped) {
    return `### ${relativePath}\n(skipped: ${file.skipped})`;
  }
  return [`### ${relativePath}`, "```", file.text, "```"].join("\n");
}

/**
 * Inline untracked files until `budgetBytes` is spent, then list the rest with
 * their size for the model to read with its tools. Skipped entries (directories,
 * binaries, oversized files) cost nothing and are always noted.
 *
 * `omitted` counts everything the prompt does not carry — text files past the
 * budget or the per-file cap, and every skipped entry, since a binary, a
 * nested repository, or an unreadable path is still part of the change — so
 * the caller knows whether Grok must go and look.
 */
function renderUntrackedFiles(cwd, files, budgetBytes) {
  let remaining = budgetBytes;
  let inlined = 0;
  let deferred = 0;
  let omitted = 0;
  const blocks = files.map((relativePath) => {
    const file = inspectUntrackedFile(cwd, relativePath);
    if (file.skipped) {
      omitted += 1;
      return formatUntrackedFileBlock(relativePath, file);
    }
    if (file.size > remaining) {
      deferred += 1;
      omitted += 1;
      return `### ${relativePath}\n(${file.size} bytes; not inlined — read it with your file tools)`;
    }
    remaining -= file.size;
    inlined += 1;
    return formatUntrackedFileBlock(relativePath, file);
  });
  if (deferred > 0) {
    blocks.unshift(
      `${inlined} of ${inlined + deferred} untracked text file(s) are inlined below, within a ${budgetBytes} byte budget. The rest are listed with their size only: read each one with your file tools before judging it.`
    );
  }
  return { body: blocks.join("\n\n"), omitted };
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let parts;
  // Whether the prompt carries the whole change. When it does not, a review
  // that never called a tool was written from the file list.
  let inlinedEverything;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untracked = renderUntrackedFiles(cwd, state.untracked, Infinity);
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untracked.body)
    ];
    inlinedEverything = untracked.omitted === 0;
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untracked = renderUntrackedFiles(
      cwd,
      state.untracked,
      normalizeMaxUntrackedInlineBytes(options.maxUntrackedInlineBytes)
    );
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untracked.body)
    ];
    inlinedEverything = state.staged.length === 0 && state.unstaged.length === 0 && untracked.omitted === 0;
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles,
    inlinedEverything
  };
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison,
    inlinedEverything: includeDiff
  };
}

// Enough of the file list to pin scope without burying the instructions.
const MAX_LISTED_SCOPE_FILES = 40;

function formatScopeFileList(changedFiles) {
  const files = changedFiles.filter(Boolean);
  if (files.length === 0) {
    return "(no files)";
  }
  const listed = files.slice(0, MAX_LISTED_SCOPE_FILES).join(", ");
  const remaining = files.length - MAX_LISTED_SCOPE_FILES;
  return remaining > 0 ? `${listed}, and ${remaining} more` : listed;
}

/**
 * Tell the reviewer exactly which diff it is reviewing.
 *
 * Naming the base branch and leaving the command to the model is what produced
 * reviews of the wrong change: `git diff <base>`, `git show HEAD`, and the diff
 * of a merge commit all include upstream work the branch merely merged in, and
 * a model handed only a branch name reaches for those first. The range is
 * already computed here, so state it and fence the file list around it.
 */
function buildAdversarialCollectionGuidance(options = {}) {
  const includeDiff = options.includeDiff !== false;
  const changedFiles = options.changedFiles ?? [];
  const lines = [];

  if (includeDiff) {
    lines.push("Use the repository context below as primary evidence.");
  } else {
    lines.push(
      "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings."
    );
  }

  if (options.mode === "branch" && options.comparison?.mergeBase) {
    const range = `${options.comparison.mergeBase}..HEAD`;
    lines.push(
      `Scope is pinned to \`git diff ${range}\`.`,
      includeDiff
        ? "The diff below is the complete contents of that range."
        : `Run that exact range. Do not run \`git diff ${options.baseRef}\`, \`git show HEAD\`, or diff a merge commit — this branch may have merged the base branch in, and those commands pull in unrelated upstream work.`
    );
  } else if (options.mode === "working-tree") {
    lines.push(
      "Scope is pinned to the uncommitted working tree: staged changes, unstaged changes, and untracked files.",
      includeDiff
        ? "The diff below is the complete contents of that scope."
        : "Inspect it with `git diff --cached`, `git diff`, and the untracked files listed below. Untracked files appear in no diff: where one is listed without its contents, read it with your file tools. Do not review committed history."
    );
  }

  lines.push(
    `In scope (${changedFiles.length} file(s)): ${formatScopeFileList(changedFiles)}.`,
    "Anything outside that list is out of scope: do not report findings against it. If the scope looks wrong, say so in the summary instead of reviewing files that are not in it."
  );

  return lines.join("\n");
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, {
      includeDiff,
      maxUntrackedInlineBytes: options.maxUntrackedInlineBytes
    });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({
      includeDiff,
      mode: details.mode,
      baseRef: target.baseRef,
      comparison: details.comparison,
      changedFiles: details.changedFiles
    }),
    ...details
  };
}
