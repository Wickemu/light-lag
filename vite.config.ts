/// <reference types="vitest/config" />
import { defineConfig } from "vite";

/** Read PORT from the environment (Node at config time) without @types/node. */
function portFromEnv(): number | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const n = env?.PORT == null ? NaN : Number(env.PORT);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Absolute path to a file under the LOCAL engine source. `import.meta.dirname`
 *  (Node ≥20.11) is this config's own directory, i.e. the current checkout —
 *  cast because vite/client doesn't type the Node-only field. */
const here = (import.meta as unknown as { dirname: string }).dirname;
const engineSrc = (rel: string): string => `${here}/packages/engine/src/${rel}`;

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
  // Resolve `@lightlag/engine[/sub]` to the LOCAL packages/engine/src, not via a
  // node_modules symlink. The workspace symlink hoists to the repo that owns
  // node_modules — which, in a git WORKTREE that shares the parent's node_modules,
  // is the MAIN checkout, so engine edits in the worktree were silently ignored by
  // the dev server and tests. Aliasing to this config's own dir makes every checkout
  // (main or worktree) use its own engine source. (Mirrored by tsconfig `paths` for
  // tsc.) The engine's package `exports` map still serves real external consumers.
  resolve: {
    alias: [
      { find: /^@lightlag\/engine$/, replacement: engineSrc("index.ts") },
      { find: /^@lightlag\/engine\/(.*)$/, replacement: engineSrc("$1") },
    ],
  },
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
    // The perturbed-propagation tests integrate real third-body arcs and legitimately run
    // several seconds each; on slower hardware they straddle Vitest's default 5 s per-test
    // timeout and flake red. Give the suite comfortable headroom (the degenerate-leg guard
    // in armPerturbedLeg ensures a genuine hang still fails fast, not at this bound).
    testTimeout: 20000,
  },
});
