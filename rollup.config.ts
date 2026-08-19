import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import typescript from "@rollup/plugin-typescript";
import { defineConfig } from "rollup";

export default defineConfig({
  input: "src/module.ts",
  output: {
    file: "dist/module.js",
    format: "es",
    sourcemap: true,
  },
  plugins: [
    resolve({
      browser: true,
      preferBuiltins: false,
    }),
    commonjs(),
    typescript({ tsconfig: "./tsconfig.json" }),
  ],
  external: [],
});
