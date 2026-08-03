import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.join(HERE, "..", "fixtures");

/**
 * Build a throwaway git repository for one eval run.
 *
 * A fixture has two layers: `base/` becomes the committed history, and
 * `change/` is copied on top afterwards so it shows up as uncommitted work.
 * That shape is what `/grok:review` and the rescue flows actually operate on,
 * and it means every run starts from an identical, known-dirty tree.
 *
 * @param {string} fixtureName
 * @param {string} destination
 * @returns {{root: string, snapshot: Record<string, string>}}
 */
export function buildFixture(fixtureName, destination) {
  const source = path.join(FIXTURES_ROOT, fixtureName);
  if (!fs.existsSync(source)) {
    throw new Error(`Unknown fixture: ${fixtureName}`);
  }

  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });

  copyTree(path.join(source, "base"), destination);

  const git = (args) =>
    execFileSync("git", args, { cwd: destination, stdio: "pipe", encoding: "utf8" });

  git(["init", "--quiet", "--initial-branch", "main"]);
  git(["config", "user.email", "evals@example.com"]);
  git(["config", "user.name", "Grok Plugin Evals"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["add", "--all"]);
  git(["commit", "--quiet", "--message", "baseline cache implementation"]);

  const changeDir = path.join(source, "change");
  if (fs.existsSync(changeDir)) {
    copyTree(changeDir, destination);
  }

  return { root: destination, snapshot: snapshotTree(destination) };
}

/**
 * Hash every tracked-ish file so we can tell afterwards whether anything on
 * disk moved. Review evals assert nothing changed; write-capable rescue evals
 * assert something did.
 *
 * @param {string} root
 * @returns {Record<string, string>}
 */
export function snapshotTree(root) {
  const out = {};
  for (const file of walk(root)) {
    const relative = path.relative(root, file);
    out[relative] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  return out;
}

/**
 * @param {Record<string, string>} before
 * @param {Record<string, string>} after
 */
export function diffSnapshots(before, after) {
  const added = Object.keys(after).filter((k) => !(k in before));
  const removed = Object.keys(before).filter((k) => !(k in after));
  const modified = Object.keys(after).filter((k) => k in before && before[k] !== after[k]);
  return { added, removed, modified, changed: [...added, ...removed, ...modified] };
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function copyTree(from, to) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyTree(src, dest);
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
}
