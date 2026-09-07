#!/usr/bin/env node
/**
 * Links (or unlinks) the local demiplane-api checkout for development.
 *
 * The published package carries a `#VERSION#` placeholder instead of a valid
 * semver version, which npm link refuses. `link` temporarily swaps in
 * `0.0.0-local`, rebuilds the API package so `dist/` matches `src/`, and
 * symlinks it into this repo. `unlink` removes the symlink, reinstalls the
 * registry copy, and reverts the version swap.
 *
 * Hygiene rules (the API repo has a clean-tree release gate, so this script
 * must never leave it dirty):
 * - The original version string is backed up OUTSIDE the API repo
 *   (`scripts/.link-api-version`, never committed), so the API tree contains
 *   only the single version-line change while linked — and nothing after
 *   unlink.
 * - `unlink` reverts the version FIRST, before any npm operation that could
 *   fail partway.
 * - No `npm unlink <pkg>` (npm 11 treats it as uninstall and strips the dep
 *   from package.json); the symlink is removed directly and the registry
 *   copy restored with an install that touches neither package.json nor the
 *   lockfile.
 *
 * Usage:
 *   npm run link:api     (DEMIPLANE_API_DIR overrides ~/git/demiplane-api)
 *   npm run unlink:api
 *
 * NOTE: any `npm install`/`npm ci` in this repo wipes the link; re-run
 * `npm run link:api` afterward.
 */
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, lstatSync } from "fs";
import { join, resolve } from "path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const API_DIR = process.env.DEMIPLANE_API_DIR ?? join(process.env.HOME ?? "", "git", "demiplane-api");
const PKG = "@scooper4711/demiplane-api";
const DEV_VERSION = "0.0.0-local";
// Kept in THIS repo (never committed) so the API tree stays clean for release.
const BACKUP_FILE = join(ROOT, "scripts", ".link-api-version");

function fail(message) {
  console.error(`link-api: ${message}`);
  process.exit(1);
}

function sh(command, cwd) {
  execSync(command, { stdio: "inherit", cwd });
}

function readApiPkg() {
  return JSON.parse(readFileSync(join(API_DIR, "package.json"), "utf8"));
}

function writeApiPkg(pkg) {
  writeFileSync(join(API_DIR, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
}

function isSemver(version) {
  return /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(version ?? "");
}

function linkTarget() {
  return join(ROOT, "node_modules", PKG);
}

function link() {
  if (!existsSync(join(API_DIR, "package.json"))) fail(`API checkout not found at ${API_DIR} (set DEMIPLANE_API_DIR)`);
  const dirty = execSync("git status --porcelain", { cwd: API_DIR }).toString().trim();
  if (dirty) console.log(`link-api: note: API repo has uncommitted changes:\n${dirty}`);

  const pkg = readApiPkg();
  if (!isSemver(pkg.version)) {
    if (!existsSync(BACKUP_FILE)) writeFileSync(BACKUP_FILE, pkg.version);
    console.log(`link-api: version "${pkg.version}" is not valid semver; temporarily using "${DEV_VERSION}"`);
    pkg.version = DEV_VERSION;
    writeApiPkg(pkg);
  } else {
    console.log(`link-api: version "${pkg.version}" is already valid semver; leaving it alone`);
  }

  sh("npm run build", API_DIR);
  sh("npm link", API_DIR);
  sh(`npm link ${PKG}`, ROOT);
  console.log(`link-api: ${PKG} is now symlinked to ${API_DIR}. Re-run after any npm install.`);
}

function unlink() {
  // Revert the version swap FIRST so the API tree is clean even if an npm
  // operation below fails partway.
  if (existsSync(BACKUP_FILE)) {
    const original = readFileSync(BACKUP_FILE, "utf8");
    const pkg = readApiPkg();
    if (pkg.version !== original) {
      pkg.version = original;
      writeApiPkg(pkg);
    }
    rmSync(BACKUP_FILE);
    console.log(`link-api: reverted API version to "${original}"`);
  }
  const target = linkTarget();
  try {
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      rmSync(target);
      console.log("link-api: removed symlink");
    } else {
      console.log("link-api: no symlink to remove (already a real directory or absent)");
    }
  } catch (error) {
    fail(`could not remove symlink: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Restore the registry copy without touching package.json or package-lock.json.
  sh("npm install --no-save --no-package-lock --no-audit --no-fund", ROOT);
  // NOTE: the global link entry is intentionally left alone (re-linking
  // overwrites it, and bare `npm unlink` errors on npm 11). It points at the
  // API checkout, which is harmless when unused.
  console.log("link-api: unlinked; registry copy restored.");
}

const mode = process.argv[2];
if (mode === "link") link();
else if (mode === "unlink") unlink();
else fail("usage: node scripts/link-api.mjs <link|unlink>");
