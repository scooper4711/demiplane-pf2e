#!/usr/bin/env node
/**
 * E2E coverage report for the Playwright integration suite.
 *
 * The specs collect Chromium V8 JS coverage while importing each character
 * (see startCoverage/stopCoverage in tests/integration/helpers.ts) into
 * coverage/e2e-raw/*.json. This script maps those ranges back onto src/*.ts
 * through the rollup sourcemap, merges the per-character chunks, and writes
 * text + HTML + lcov reports to coverage/e2e/.
 *
 * Viewing:
 * - Terminal: the text table printed by this script.
 * - Browser: open coverage/e2e/index.html (annotated per-file source).
 * - VS Code: install "Coverage Gutters" (ryanluker.vscode-coverage-gutters)
 *   and point it at coverage/e2e/lcov.info via the
 *   `coverage-gutters.coverageFileNames` setting.
 *
 * Usage: npm run coverage:e2e   (run *after* `npx playwright test`)
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join, resolve } from "path";
import { execSync } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const v8toIstanbul = require("v8-to-istanbul");
const convertSourceMap = require("convert-source-map");

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const RAW_DIR = join(ROOT, "coverage", "e2e-raw");
const TMP_DIR = join(ROOT, "coverage", ".e2e-tmp");
const REPORT_DIR = join(ROOT, "coverage", "e2e");
const BUNDLE = join(ROOT, "dist", "module.js");
const BUNDLE_MAP = `${BUNDLE}.map`;

function fail(message) {
  console.error(`e2e-coverage: ${message}`);
  process.exit(1);
}

if (!existsSync(BUNDLE) || !existsSync(BUNDLE_MAP)) {
  fail("dist/module.js(.map) missing — run 'npm run build' first.");
}
const rawFiles = existsSync(RAW_DIR) ? readdirSync(RAW_DIR).filter((f) => f.endsWith(".json")) : [];
if (rawFiles.length === 0) {
  fail("no raw chunks in coverage/e2e-raw/. Run `npx playwright test` first (specs record coverage on import).");
}

const source = readFileSync(BUNDLE, "utf8");
// v8-to-istanbul v9 wants a convert-source-map Converter, not the raw map.
const parsedMap = JSON.parse(readFileSync(BUNDLE_MAP, "utf8"));
// The rollup map leaves most sourcesContent entries empty, which poisons the
// converter (it only loads from disk when sourcesContent is absent
// entirely). Fill them from disk — paths are relative to dist/.
parsedMap.sourcesContent = parsedMap.sources.map((relativePath) => {
  try {
    return readFileSync(join(ROOT, "dist", relativePath), "utf8");
  } catch {
    return "";
  }
});
const sourceMap = convertSourceMap.fromObject(parsedMap);

rmSync(TMP_DIR, { recursive: true, force: true });
mkdirSync(TMP_DIR, { recursive: true });

let chunks = 0;
for (const file of rawFiles) {
  const entries = JSON.parse(readFileSync(join(RAW_DIR, file), "utf8"));
  for (let i = 0; i < entries.length; i++) {
    const converter = v8toIstanbul(entries[i].url, 0, { source, sourceMap });
    await converter.load();
    converter.applyCoverage(entries[i].functions);
    writeFileSync(join(TMP_DIR, `${file.replace(/\.json$/, "")}-${i}.json`), JSON.stringify(converter.toIstanbul()));
    chunks += 1;
  }
}
console.log(`e2e-coverage: converted ${chunks} chunk(s) from ${rawFiles.length} spec(s)`);

execSync(`npx nyc merge ${TMP_DIR} ${join(REPORT_DIR, "coverage-merged.json")}`, { stdio: "inherit", cwd: ROOT });
execSync(
  `npx nyc report --temp-dir ${REPORT_DIR} --reporter=text --reporter=html --reporter=lcov --report-dir ${REPORT_DIR}`,
  { stdio: "inherit", cwd: ROOT },
);
rmSync(TMP_DIR, { recursive: true, force: true });

console.log(`e2e-coverage: report written to ${REPORT_DIR}/index.html and ${REPORT_DIR}/lcov.info`);
