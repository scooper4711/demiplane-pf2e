import { spawn, type ChildProcess } from "child_process";
import { existsSync, lstatSync, rmSync, symlinkSync } from "fs";
import { resolve, join } from "path";

const FOUNDRY_PATH = process.env.FOUNDRY_PATH ?? resolve(__dirname, "../../foundry-playwright/FoundryVTT-Node-14.367");
// The TEST data dir (port 30001), separate from the dev Data dir (30000).
const DATA_PATH = process.env.FOUNDRY_DATA_PATH ?? resolve(__dirname, "../../foundry-playwright/TestData");
const PORT = process.env.FOUNDRY_TEST_PORT ?? process.env.FOUNDRY_PORT ?? "30001";
const ADMIN_PASSWORD = process.env.FOUNDRY_ADMIN_PASSWORD ?? "test-admin";
// Boot straight into the test world so first-run setup screens are skipped.
const WORLD = process.env.FOUNDRY_WORLD ?? "integration-test";
const MODULE_ID = "demiplane-pf2e";
const STARTUP_TIMEOUT_MS = 30_000;

let foundryProcess: ChildProcess | undefined;

/**
 * Ensures the built module is linked into the test data dir. A wiped
 * TestData loses the symlink, and without it the world boots with no
 * module and every import test fails at `mod.api`.
 */
function ensureModuleLinked(): void {
  const projectRoot = resolve(__dirname, "../..");
  const dist = join(projectRoot, "dist");
  if (!existsSync(join(dist, "module.js"))) {
    throw new Error(`Module not built: ${dist}/module.js missing. Run 'npm run build' first.`);
  }
  const link = join(DATA_PATH, "Data", "modules", MODULE_ID);
  // Symlink the project root (module.json + dist/ resolve through it).
  if (existsSync(link)) {
    if (lstatSync(link).isSymbolicLink()) return;
    rmSync(link, { recursive: true });
  }
  symlinkSync(projectRoot, link);
  console.log(`Linked module: ${link} -> ${projectRoot}`);
}

export default async function globalSetup(): Promise<void> {
  console.log(`Starting Foundry VTT at ${FOUNDRY_PATH} on port ${PORT}...`);
  console.log(`Data path: ${DATA_PATH}`);
  console.log(`World: ${WORLD}`);

  ensureModuleLinked();

  foundryProcess = spawn(
    "node",
    [
      resolve(FOUNDRY_PATH, "main.mjs"),
      `--dataPath=${DATA_PATH}`,
      `--port=${PORT}`,
      `--adminPassword=${ADMIN_PASSWORD}`,
      `--world=${WORLD}`,
      "--noupdate",
      "--headless",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    }
  );

  (globalThis as Record<string, unknown>).__FOUNDRY_PROCESS__ = foundryProcess;

  const startupPromise = new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Foundry VTT failed to start within ${STARTUP_TIMEOUT_MS}ms. ` +
            `Check that Node 24 is available and Foundry path is correct: ${FOUNDRY_PATH}`
        )
      );
    }, STARTUP_TIMEOUT_MS);

    foundryProcess!.stdout?.on("data", (data: Buffer) => {
      const output = data.toString();
      if (output.includes("Server started and listening")) {
        clearTimeout(timeout);
        resolvePromise();
      }
    });

    foundryProcess!.stderr?.on("data", (data: Buffer) => {
      console.error(`Foundry stderr: ${data.toString()}`);
    });

    foundryProcess!.on("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start Foundry VTT: ${error.message}`));
    });

    foundryProcess!.on("exit", (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Foundry VTT exited with code ${code} before startup completed`));
      }
    });
  });

  await startupPromise;
  console.log(`Foundry VTT started on port ${PORT}`);
}
