import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/integration",
  timeout: 120_000,
  retries: 0,
  use: {
    baseURL: `http://localhost:${process.env.FOUNDRY_PORT ?? "30000"}`,
    headless: true,
  },
  globalSetup: "./tests/integration/global-setup.ts",
  globalTeardown: "./tests/integration/global-teardown.ts",
});
