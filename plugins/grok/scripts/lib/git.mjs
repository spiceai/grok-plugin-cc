import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

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

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = state.untracked.map((file) => formatUntrackedFile(cwd, file)).join("\n\n");
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
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
    comparison
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
        : "Inspect it with `git diff --cached`, `git diff`, and the untracked files listed below. Do not review committed history."
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
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff });
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
