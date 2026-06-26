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

### Math primitives

| Module | Provides |
|---|---|
| `math/vec3.ts` | f64 vector ops (plain `{x,y,z}`, serializable). |
| `math/kepler.ts` | Kepler solvers (elliptic + hyperbolic), coe↔rv, propagation, orbit sampling. |
| `math/integrators.ts` | RK4 integrator for powered flight. |

### Core simulation

| Module | Provides |
|---|---|
| `constants.ts` | Physical constants + real Solar-System body data (JPL elements, μ=GM, radii, atmospheres). |
| `ephemeris.ts` | Analytic body state (position, velocity) at any `t`. |
| `orbit.ts` | vis-viva, apsides, periods, maneuver frame, SOI radius, Oberth burn, J2 secular precession rates, sun-synchronous inclination. |
| `propulsion.ts` | Rocket equation, staging, Δv budget, electric power law (`F = min(F_rated, 2ηP/vₑ)`). |
| `ships.ts` | Ship mass/state/orbit helpers; impulsive Δv (with affordability check); thermal state readout. |
| `surface.ts` | Landing/takeoff Δv budgets: calibrated gravity-turn ascent through real exponential atmospheres, aerobraking fraction on descent. |
| `thermal.ts` | Stefan-Boltzmann heat budget, solar flux (1/r²), detection range — the "no stealth in space" pillar. |
| `stars.ts` | Nearest ~24 star systems in ecliptic-J2000 frame (interstellar destinations). |
| `comms.ts` | Light-time, signal propagation at `c`, retarded (delayed) state of a moving target. |
| `serialize.ts` | Canonical, deterministic world serialization (sorted Maps, 12-sig-fig quantization) + `hashWorld` (the golden-state CI oracle). Foundation for Phase-8 save/load. |
| `time.ts` | Clock, time-warp levels, deterministic event queue, calendar formatting. |
| `world.ts` | `WorldState` — plain serializable data (ships, stations, maneuvers, messages). |
| `sim.ts` | The deterministic step kernel: time advance, RK4 sub-stepping, event dispatch, **light-lag command delivery** (commands propagate at `c`, resolved against the ship's live state at delivery). |

### Maneuver solvers — `maneuver/`

| Module | Provides |
|---|---|
| `maneuver/lambert.ts` | Lambert problem solver, single + multi-revolution. |
| `maneuver/hohmann.ts` | Hohmann transfer Δv + synodic period. |
| `maneuver/porkchop.ts` | Porkchop launch-window grid (Lambert × dep/tof sweep). |
| `maneuver/biElliptic.ts` | Bi-elliptic transfer. |
| `maneuver/arrival.ts` | B-plane arrival targeting: hyperbolic approach to a requested periapsis altitude. |
| `maneuver/flyby.ts` | Patched-conic gravity-flyby geometry (vₓ in/out rotation, turn angle, periapsis). |
| `maneuver/assist.ts` | Two-leg gravity-assist solver (leg1 → flyby body → leg2 → target) + grid search for the cheapest window. |
| `maneuver/lowThrust.ts` | Edelbaum analytic spiral: exact Δv/time/propellant for a power-limited electric transfer between near-circular orbits (and coplanar inclination change). |
| `maneuver/interstellar.ts` | Relativistic brachistochrone (flip-and-burn): rapidity rocket equation, coordinate/proper time, peak Lorentz factor, mass ratio, light-lag. |

### Engine contract
- **State is plain data.** `WorldState` is JSON-serializable (numbers, strings,
  `{x,y,z}`, Maps of those). No class instances with hidden state in the world.
- **One mutator.** `Simulation.step(dtSim)` is the only thing that advances state;
  it is deterministic in its argument (events fire at exact times; equal-time
  events break ties by insertion order).
- **Time is explicit.** Everything is a function of `t` (seconds since J2000).
- **Light-lag is native.** `sim.sendCommand(targetId, command)` emits a signal
  that propagates at `c` and is delivered when it reaches the (moving) ship.
  The command resolves against the ship's actual live state at delivery — the
  light-lag bargain, not a bug. A NACK propagates back at `c` if the ship cannot
  execute. Both directions are `MessageInFlight` entries in `WorldState`.

## The game / presentation — `render/`, `ui/`, `app/`

### `render/` — Three.js read-only view

| Module | Provides |
|---|---|
| `SceneManager.ts` | Three.js scene, camera, WebGL renderer, OrbitControls, floating origin (re-centred every frame on the focused body), theme (dark/light). |
| `bodyViews.ts` | Body sphere meshes, ecliptic orbit lines (eccentric-anomaly sampled and phased so the loop passes through the marker), label anchor NDC coordinates. |
| `shipViews.ts` | Ship marker meshes + floating name labels in screen space. |
| `starViews.ts` | Point markers for the nearby real star systems (the only sky — there is no procedural starfield). |
| `commsViews.ts` | Light-cone / signal-in-flight visualizations (outbound commands, inbound telemetry). |
| `visibility.ts` | Shared show/hide state — per-body and per-kind toggles plus cross-cutting layers (orbits, labels, stars, ships, comms). Written by the HUD, read by every view. |
| `scale.ts` | Metre ↔ render-unit conversion; logarithmic depth for solar-system-scale precision in float32. |

### `ui/` — DOM panels over the WebGL canvas

| Module | Provides |
|---|---|
| `hud.ts` | Clock, time-warp controls, body focus list (grouped by kind, scrollable) with per-body / per-kind show-hide eyes and a layer-chip row (orbits, labels, stars, ships, comms), per-body physics readouts (distance, speed, period, surface gravity, light-time), floating body labels, theme toggle. |
| `shipPanel.ts` | Ship designer (staged stack editor, live Δv budget, preset fleet picker) + flight console (osculating orbit, mass, Δv remaining, burn orders, transfer status, J2 precession, surface ops, electric spiral, thermal/detection readouts). |
| `transferPanel.ts` | Transfer planner: porkchop plot (Lambert grid, blue/red Δv colour scale), optional gravity-assist via-flyby-body mode, cell selection, commit to `planTransfer` / `planAssist`. |
| `interstellarPanel.ts` | Interstellar planner: star selector (sorted by distance), torchship selector, transit estimator (coordinate/proper time, mass ratio, light-lag), dispatch to `dispatchInterstellar`. |
| `keyboard.ts` | Central keyboard input: one-shot shortcuts (Space, `,` `.`, `1`–`8`, Tab, `F`, `V`, `R`, Escape) + smooth per-frame camera orbit (WASD/arrows) and zoom (`+`/`-`). |

### `app/` — wiring and command semantics

| Module | Provides |
|---|---|
| `main.ts` | Entry point: constructs all layers and runs the one-way frame loop (sim advance → render read). |
| `commands.ts` | Player intents → validated world mutations: `spawnShip`, `sendBurn` (via light-lag `sim.sendCommand`), `planTransfer`, `planAssist`, `landShip`, `launchShip`, `planSpiral`, `dispatchInterstellar`. |
| `shipCatalog.ts` | 30+ preset ship designs (Historical / Current / Prototype / Sci-Fi), every number from published data. Includes classical staged presets and `INTERSTELLAR_CRAFT` for the relativistic layer. |

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
   handlers (interplanetary transfer departure, SOI capture, flyby pass, spiral
   arrival, and light-lag command delivery) alongside the generic kernel. For a
   clean engine these become **registered handlers** the game supplies, leaving
   `sim.ts` with only the generic step/event machinery. Until then they live in
   the kernel for convenience — this file is the marker for that future tease-apart.

Nothing else crosses the boundary, so the engine is already a coherent unit.
