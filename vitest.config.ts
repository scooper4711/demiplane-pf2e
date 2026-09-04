import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/import/index.ts"],
      // Push gate per coding standards: >=80% lines and branches. Enforced
      // mechanically so under-covered code cannot be pushed.
      thresholds: {
        lines: 80,
        branches: 80,
      },
    },
  },
});
