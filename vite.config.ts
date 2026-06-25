/// <reference types="vitest/config" />
import { defineConfig } from "vite";

export default defineConfig({
  // Solar-system distances overflow nothing in f64, but we keep the build simple.
  build: {
    target: "es2022",
  },
  test: {
    // The physics core is pure and runs headless in Node.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
