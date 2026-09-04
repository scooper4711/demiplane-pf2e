#!/usr/bin/env node
"use strict";

/**
 * Pre-commit guard: fail if a staged file references the local demiplane-api
 * sibling checkout instead of the published @scooper4711/demiplane-api release.
 *
 * Local references (file:../demiplane-api, link:..., relative path aliases)
 * work on a maintainer's machine but break CI and anyone without the sibling
 * directory. They have leaked into package.json, package-lock.json, and
 * vitest.config.ts in the past, so this check inspects the *staged* content of
 * every committed file rather than the working tree.
 */

const { execSync } = require("node:child_process");

const PACKAGE_NAME = "@scooper4711/demiplane-api";

/**
 * This guard script and any documentation are allowed to describe the
 * forbidden patterns in prose, so they are not scanned for references.
 */
const SELF = "scripts-build/check-demiplane-api-ref.cjs";

/**
 * Patterns that indicate a local filesystem reference to demiplane-api.
 * Each pattern requires a quoted string so that prose mentions in comments or
 * docs do not trigger a false positive. Each entry pairs a regex with a
 * human-readable explanation.
 */
const FORBIDDEN_PATTERNS = [
  {
    regex: /@scooper4711\/demiplane-api["']\s*:\s*["'](?:file|link):/,
    reason: "npm file:/link: dependency on the local sibling checkout",
  },
  {
    regex: /["'](?:\.\.?\/)+demiplane-api(?:\/[^"']*)?["']/,
    reason: "relative filesystem path to the sibling demiplane-api directory",
  },
  {
    regex: /["']resolved["']\s*:\s*["'](?:\.\.?\/)+demiplane-api/,
    reason: "package-lock resolved to a local demiplane-api path",
  },
];

function getStagedFiles() {
  const output = execSync("git diff --cached --name-only --diff-filter=ACMR", {
    encoding: "utf8",
  });
  return output.split("\n").filter((line) => line.trim() !== "");
}

function getStagedContent(file) {
  try {
    return execSync(`git show :"${file}"`, { encoding: "utf8" });
  } catch {
    // File is staged for deletion or is binary; nothing to scan.
    return "";
  }
}

function findViolations(file, content) {
  const violations = [];
  const lines = content.split("\n");
  lines.forEach((line, index) => {
    for (const { regex, reason } of FORBIDDEN_PATTERNS) {
      if (regex.test(line)) {
        violations.push({ file, lineNumber: index + 1, text: line.trim(), reason });
        break;
      }
    }
  });
  return violations;
}

function reportAndExit(violations) {
  if (violations.length === 0) {
    return;
  }

  console.error(
    `\nCommit aborted: found local references to ${PACKAGE_NAME} instead of a published release.\n`,
  );
  for (const { file, lineNumber, text, reason } of violations) {
    console.error(`  ${file}:${lineNumber}  (${reason})`);
    console.error(`    ${text}`);
  }
  console.error(
    `\nUse the published dependency (e.g. "${PACKAGE_NAME}": "^0.5.0") and let it` +
      `\nresolve from node_modules. Remove any file:/link: entries, sibling-path` +
      `\naliases, and local lockfile resolutions before committing.\n`,
  );
  process.exit(1);
}

function main() {
  const stagedFiles = getStagedFiles().filter((file) => file !== SELF);
  const violations = stagedFiles.flatMap((file) =>
    findViolations(file, getStagedContent(file)),
  );
  reportAndExit(violations);
}

main();
