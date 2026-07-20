#!/usr/bin/env node
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const docsRepoDir = resolve(process.env.DOCS_REPO_DIR ?? resolve(repoRoot, "vendor/docs"));
const docsRepoUrl = process.env.DOCS_REPO_URL ?? "https://github.com/Xinyuan-LilyGO/documentation.git";
const docsRepoBranch = process.env.DOCS_REPO_BRANCH ?? "master";
const docsSparsePath = process.env.DOCS_SPARSE_PATH ?? "en/products";

async function pathExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function git(args) {
  return execFileAsync("git", args, { maxBuffer: 1024 * 1024 * 20 });
}

async function isGitCheckout(path) {
  try {
    await git(["-C", path, "rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

async function ensureDocsCheckout() {
  if (await isGitCheckout(docsRepoDir)) {
    return;
  }

  if (await pathExists(docsRepoDir)) {
    throw new Error(`${docsRepoDir} exists but is not a git checkout`);
  }

  await mkdir(dirname(docsRepoDir), { recursive: true });
  await git([
    "clone",
    "--filter=blob:none",
    "--sparse",
    "--depth",
    "1",
    "--branch",
    docsRepoBranch,
    docsRepoUrl,
    docsRepoDir,
  ]);
}

async function main() {
  await ensureDocsCheckout();
  await git(["-C", docsRepoDir, "sparse-checkout", "set", docsSparsePath]);
  await git(["-C", docsRepoDir, "pull", "--ff-only", "origin", docsRepoBranch]);
  console.error(`[lilygo-docs] documentation updated in ${docsRepoDir}`);
}

main().catch((error) => {
  console.error("[lilygo-docs] documentation update failed:", error);
  process.exitCode = 1;
});
