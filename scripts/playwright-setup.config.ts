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
    headless: true,
  },
});
