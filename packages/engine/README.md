# @lightlag/engine

The LIGHTLAG physics engine: a **pure, deterministic, double-precision SI** model of
Solar-System mechanics. No renderer, no DOM, no wall-clock, no `Math.random()` in the
hot path, and **no game assumptions**. Everything is a function of state and time `t`
(seconds since J2000).

This package is the reusable core. A game — the strategy sim in this repo's `src/`, or
any other purpose (a courier sim, a 4X, a teaching tool) — is a thin layer on top that
supplies its own views, commands, and goals. The dependency only ever points inward:
the engine imports nothing from any game.

## What's inside

- **Math** — f64 vectors, Kepler solvers (elliptic + hyperbolic, coe↔rv, propagation),
  RK4 integration, special-relativistic powered-flight acceleration.
- **Bodies & state** — physical constants + a JPL-validated body catalog, analytic
  ephemeris at any `t`, plain-data serializable `WorldState`.
- **Orbital mechanics** — vis-viva, apsides, SOI, Oberth, J2 secular precession,
  sun-synchronous inclination, and a closed-form secular atmospheric-drag decay on
  coasting orbits (a constant ṅ → ½·ṅ·dt² along-track + consistent SMA decay; opt-in
  per ship via `Ship.drag`, used by the sandbox's TLE satellites).
- **Propulsion** — rocket equation, staging, Δv budgets, electric power law, variable-Isp.
- **Maneuvers** — Lambert, Hohmann, porkchop windows, bi-elliptic, gravity assists &
  multi-flyby chains, moon tours, low-thrust Edelbaum spirals, atmospheric entry &
  aerocapture, relativistic brachistochrone.
- **Thermal / comms** — Stefan-Boltzmann heat budget, solar flux, detection range,
  light-time and retarded state.
- **The kernel** — `Simulation.step(dt)`: deterministic time advance, RK4 sub-stepping,
  an event queue, and native light-lag command delivery (commands propagate at `c`).

## Usage

```ts
// Fine-grained subpath — one module, tree-shakeable:
import { Simulation } from "@lightlag/engine/sim";
import { createWorld } from "@lightlag/engine/world";
import { summarizeOrbit } from "@lightlag/engine/orbit";
import { add, cross } from "@lightlag/engine/math/vec3";

// Or the namespaced barrel — collision-free, reads as physics:
import { sim, world, orbit, vec3 } from "@lightlag/engine";
```

`@lightlag/engine/<module>` maps 1:1 to `src/<module>.ts`. There is no build step — the
package ships TypeScript source, consumed directly by Vite / Vitest / `tsc` under bundler
resolution.

## Engine contract

- **State is plain data.** `WorldState` is JSON-serializable; no hidden class state.
- **One mutator.** `Simulation.step(dt)` is the only thing that advances state, and it is
  deterministic in its argument (events fire at exact times; equal-time ties break by
  insertion order). The golden-state hash (`hashWorld`) guards this in CI.
- **Time is explicit.** Everything is a function of `t`.
- **Light-lag is native.** `sim.sendCommand(targetId, command)` emits a signal that
  travels at `c` and resolves against the ship's live state at delivery.

## Boundary gate

The engine has its own **DOM-free** `tsconfig.json`. From the repo root:

```bash
npm run typecheck:engine   # tsc --noEmit -p packages/engine
```

Because that config's `lib` is `ES2022` only (no `"DOM"`) and it sees no game source, any
accidental dependency on the browser, a renderer, or the game layer fails to compile. That
is what keeps this package genuinely standalone.

## Tests

The engine's own suites are pure (they import only `@lightlag/engine`) and run as part of
the repo's single `npm test`. Suites that drive the kernel through a game's command layer
are integration tests and live on the game side (`src/integration/`), so this package
carries no dependency on any game — see the repo's `ARCHITECTURE.md`.

## Status

`private` within the workspace for now (consumed only in-repo). When it's worth publishing
standalone, flip `private`, add an explicit build/`d.ts` emit step, and declare its own dev
dependencies; nothing about the source needs to change.
