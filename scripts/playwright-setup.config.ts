import { defineConfig } from "@playwright/test";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: __dirname,
  testMatch: "setup-foundry.spec.ts",
  timeout: 600_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${process.env.FOUNDRY_PORT ?? "30000"}`,
    // Headed when PLAYWRIGHT_HEADED=true (see --headed on scripts/foundry.sh).
    headless: process.env.PLAYWRIGHT_HEADED !== "true",
    // Same as the main config: Foundry degrades below 1366x768 and headless
    // defaults to 1280x720, which raises a blocking warning banner.
    viewport: { width: 1600, height: 900 },
  },
});
