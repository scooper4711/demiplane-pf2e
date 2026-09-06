#!/usr/bin/env node
/**
 * Summarizes a Playwright JSON report for smoke-test runs.
 *
 * Usage: node scripts/summarize-results.mjs <report.json>
 *
 * Prints overall stats plus, for every failed test: the spec file, the full
 * title path, and the first lines of the error. Exits 1 when anything
 * failed, 0 otherwise.
 */
import { readFileSync } from "fs";

const [reportPath] = process.argv.slice(2);
if (!reportPath) {
  console.error("Usage: node scripts/summarize-results.mjs <report.json>");
  process.exit(2);
}

let report;
try {
  const raw = readFileSync(reportPath, "utf8");
  // Be tolerant of log lines mixed into stdout-captured reports: the JSON
  // payload always starts at the first '{'.
  report = JSON.parse(raw.slice(raw.indexOf("{")));
} catch (error) {
  console.error(`Cannot read report ${reportPath}: ${String(error)}`);
  process.exit(2);
}

const failures = [];
let passed = 0;
let skipped = 0;
let flaky = 0;

function visit(suite, parents) {
  for (const spec of suite.specs ?? []) {
    const title = [...parents, spec.title].join(" › ");
    for (const test of spec.tests ?? []) {
      // Playwright reports outcome per attempt in test.results; test.status
      // is 'expected' when the outcome matched (pass OR intended skip),
      // 'unexpected' on real failure, 'flaky' on pass-after-retry.
      const attemptStatuses = (test.results ?? []).map((r) => r.status);
      if (attemptStatuses.length > 0 && attemptStatuses.every((s) => s === "skipped")) {
        skipped += 1;
      } else if (test.status === "flaky") {
        flaky += 1;
        passed += 1;
      } else if (test.status === "unexpected") {
        const errors = (test.results ?? [])
          .filter((r) => r.status !== "passed" && r.status !== "skipped")
          .flatMap((r) => (r.errors ?? []).filter(Boolean))
          .map((e) => `${e.message ?? String(e)}${e.location ? ` (${e.location.file}:${e.location.line})` : ""}`);
        failures.push({ file: spec.file, title, errors });
      } else {
        passed += 1;
      }
    }
  }
  for (const child of suite.suites ?? []) visit(child, parents);
}

for (const suite of report.suites ?? []) visit(suite, []);
const total = passed + skipped + failures.length;

console.log(`\n=== Smoke summary: ${passed} passed, ${failures.length} failed, ${skipped} skipped, ${flaky} flaky (${total} total) ===`);
for (const failure of failures) {
  console.log(`\nFAIL ${failure.file}\n  ${failure.title}`);
  for (const error of failure.errors.slice(0, 2)) {
    const excerpt = error.split("\n").slice(0, 15).join("\n    ");
    console.log(`    ${excerpt}`);
  }
}

process.exit(failures.length > 0 ? 1 : 0);
