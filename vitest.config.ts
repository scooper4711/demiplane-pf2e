import { defineConfig } from "vitest/config";
import path from "path";
export default defineConfig({
  resolve: {
    alias: {
      "@scooper4711/demiplane-api": path.resolve(
        __dirname,
        "../demiplane-api/src/index.ts",
      ),
    },
  },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/import/**/*.ts"],
      exclude: ["src/import/index.ts"],
    },
  },
});
