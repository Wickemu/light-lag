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
  // Match the dev transform + dependency pre-bundle to the ES2022 baseline the
  // engine and the production build already target. Without this, Vite's default
  // dev target (es2020) rejects top-level await in deps (e.g. satellite.js's WASM
  // entry), which only the dev server — not the es2022 production build — hit.
  esbuild: { target: "es2022" },
  optimizeDeps: { esbuildOptions: { target: "es2022" } },
  // Honour a PORT from the environment so dev/preview tooling can place the
  // server on an assigned free port; falls back to Vite's default otherwise.
  // Read via globalThis so this typechecks without pulling in @types/node.
  server: {
    port: portFromEnv() ?? 5173,
  },
  test: {
    // The physics engine is pure and runs headless in Node. One runner covers
    // both the engine package and the game layer (incl. the app↔engine
    // integration tests under src/integration).
    environment: "node",
    include: ["src/**/*.test.ts", "packages/engine/src/**/*.test.ts"],
  },
});
