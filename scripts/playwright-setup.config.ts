import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./scripts",
  testMatch: "setup-foundry.spec.ts",
  timeout: 600_000, // 10 minutes — PF2e download is large
  retries: 0,
  use: {
    baseURL: `http://localhost:${process.env.FOUNDRY_PORT ?? "30000"}`,
    headless: true,
  },
});
