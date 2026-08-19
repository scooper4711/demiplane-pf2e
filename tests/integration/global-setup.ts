import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";

const FOUNDRY_PATH =
  process.env.FOUNDRY_PATH ??
  resolve(__dirname, "../../foundry-playwright/FoundryVTT-Node-14.367");
const DATA_PATH =
  process.env.FOUNDRY_DATA_PATH ??
  resolve(__dirname, "../../foundry-playwright/Data");
const PORT = process.env.FOUNDRY_PORT ?? "30000";
const ADMIN_PASSWORD = process.env.FOUNDRY_ADMIN_PASSWORD ?? "test-admin";
const STARTUP_TIMEOUT_MS = 30_000;

let foundryProcess: ChildProcess | undefined;

export default async function globalSetup(): Promise<void> {
  console.log(
    `Starting Foundry VTT at ${FOUNDRY_PATH} on port ${PORT}...`,
  );
  console.log(`Data path: ${DATA_PATH}`);

  foundryProcess = spawn(
    "node",
    [
      resolve(FOUNDRY_PATH, "main.mjs"),
      `--dataPath=${DATA_PATH}`,
      `--port=${PORT}`,
      `--adminPassword=${ADMIN_PASSWORD}`,
      "--noupdate",
      "--headless",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    },
  );

  (globalThis as Record<string, unknown>).__FOUNDRY_PROCESS__ = foundryProcess;

  const startupPromise = new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Foundry VTT failed to start within ${STARTUP_TIMEOUT_MS}ms. ` +
            `Check that Node 24 is available and Foundry path is correct: ${FOUNDRY_PATH}`,
        ),
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
        reject(
          new Error(
            `Foundry VTT exited with code ${code} before startup completed`,
          ),
        );
      }
    });
  });

  await startupPromise;
  console.log(`Foundry VTT started on port ${PORT}`);
}
