# Architecture — engine vs. game

LIGHTLAG is deliberately split so the **physics is a reusable engine** and any
particular **game is a thin layer on top**. If you want to build a different
game around the same hard-physics rules (a courier sim, a 4X, a survival
sandbox), you keep `src/core/` and replace the layers above it.

## The one rule

**Dependencies point inward, never outward.**

```
app/  ─┐
ui/   ─┼──►  core/        core/ imports NOTHING from app, ui, or render.
render/┘              (no Three.js, no DOM, no game-specific assumptions)
```

`src/core/` has zero `import` from `../render`, `../ui`, or `../app`. The
renderer and UI are strictly *read-only views* of the simulation; only
`Simulation.step()` mutates state. This is enforced by convention today and is
the invariant to protect.

## The engine — `src/core/` (pure, deterministic, SI)

Game-agnostic. No framework, no renderer, no wall-clock, no `Math.random()` in
the hot path. Everything is double-precision SI and a pure function of state + time.

| Module | Provides |
|---|---|
| `constants.ts` | Physical constants + real Solar-System body data (JPL elements, μ=GM, radii). |
| `math/vec3.ts` | f64 vector ops (plain `{x,y,z}`, serializable). |
| `math/kepler.ts` | Kepler solvers (elliptic+hyperbolic), coe↔rv, propagation, orbit sampling. |
| `math/integrators.ts` | RK4 (for powered flight). |
| `ephemeris.ts` | Analytic body state at any `t`. |
| `orbit.ts` | vis-viva, apsides, periods, maneuver frame, SOI radius, Oberth burn. |
| `propulsion.ts` | Rocket equation, staging, Δv budget, electric power law. |
| `ships.ts` | Ship mass/state/orbit helpers; impulsive Δv with affordability. |
| `maneuver/` | Lambert, Hohmann, porkchop, B-plane arrival targeting. |
| `comms.ts` | Light-time, signal propagation at `c`, retarded (delayed) state. |
| `time.ts` | Clock, time-warp levels, deterministic event queue, calendar. |
| `world.ts` | `WorldState` — plain serializable data (the save format). |
| `sim.ts` | The deterministic step kernel: time advance, RK4 sub-stepping, event dispatch. |

### Engine contract
- **State is plain data.** `WorldState` is JSON-serializable (numbers, strings,
  `{x,y,z}`, Maps of those). No class instances with hidden state in the world.
- **One mutator.** `Simulation.step(dtSim)` is the only thing that advances state;
  it is deterministic in its argument (events fire at exact times; equal-time
  events break ties by insertion order).
- **Time is explicit.** Everything is a function of `t` (seconds since J2000).

## The game / presentation — `render/`, `ui/`, `app/`

- `render/` — Three.js scene (floating origin, LOD, orrery, ships, comms packets).
- `ui/` — HUD and panels (ship designer, transfer planner, flight console).
- `app/` — wiring (`main.ts`) and **command semantics** (`commands.ts`): what a
  "burn" or a "transfer" means, and (Phase 5) how player intents become
  light-lagged messages.

## Building another game on the engine

Keep `src/core/`. Provide your own `render/`/`ui/`, and your own `commands` +
event semantics. The engine gives you correct orbits, transfers, propulsion,
SOI patched conics, and light-lag for free.

## Path to a standalone engine package (when you commit to it)

The split is mostly mechanical because the dependency direction is already right:

1. Move `src/core/` to `packages/engine/src` with its own `package.json`
   (`@lightlag/engine`), `tsconfig`, and the existing `*.test.ts` (they only
   import core).
2. The app imports `@lightlag/engine` instead of `../core`.
3. **One real refactor:** `sim.ts` currently contains *game-specific* event
   handlers (interplanetary transfer departure, SOI capture, and Phase-5 command
   delivery) alongside the generic kernel. For a clean engine these become
   **registered handlers** the game supplies, leaving `sim.ts` with only the
   generic step/event machinery. Until then they live in the kernel for
   convenience — this file is the marker for that future tease-apart.

Nothing else crosses the boundary, so the engine is already a coherent unit.
