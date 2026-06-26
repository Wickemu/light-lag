/// <reference types="vitest/config" />
import { defineConfig } from "vite";

/** Read PORT from the environment (Node at config time) without @types/node. */
function portFromEnv(): number | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const n = env?.PORT == null ? NaN : Number(env.PORT);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export default defineConfig({
  // Solar-system distances overflow nothing in f64, but we keep the build simple.
  build: {
    target: "es2022",
  },
  // Honour a PORT from the environment so dev/preview tooling can place the
  // server on an assigned free port; falls back to Vite's default otherwise.
  // Read via globalThis so this typechecks without pulling in @types/node.
  server: {
    port: portFromEnv() ?? 5173,
  },
  test: {
    // The physics core is pure and runs headless in Node.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
