import { defineConfig } from "@playwright/test";
import { config } from "dotenv";
import { resolve } from "path";

// Load .env
config({ path: resolve(import.meta.dirname, ".env") });

const PORT = process.env.FOUNDRY_TEST_PORT ?? "30001";

export default defineConfig({
  testDir: "./tests/integration",
  timeout: 180_000, // 3 minutes per test (PF2e init is slow)
  retries: 0,
  workers: 1, // Foundry can only handle one session at a time
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
  },
  // Global setup only runs if FOUNDRY_SETUP=true (opt-in for license/system/world setup)
  ...(process.env.FOUNDRY_SETUP === "true"
    ? { globalSetup: "./tests/integration/global-setup.ts" }
    : {}),
});
