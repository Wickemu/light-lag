# Architecture — engine vs. game

LIGHTLAG is deliberately split so the **physics is a reusable engine** and any
particular **game is a thin layer on top**. If you want to build a different
game around the same hard-physics rules (a courier sim, a 4X, a survival
sandbox), you keep `@lightlag/engine` and replace the layers above it.

The split is now a **real package boundary**, not just a folder convention:

```
packages/engine/   →  @lightlag/engine   the physics engine (this repo's first product)
src/render|ui|app  →  the game           the strategy sim built on the engine
```

## The one rule

**Dependencies point inward, never outward.**

```
app/  ─┐
ui/   ─┼──►  @lightlag/engine     the engine imports NOTHING from app, ui, or render.
render/┘                      (no Three.js, no DOM, no game-specific assumptions)
```

The engine (`packages/engine/src/`) has zero `import` from the game. The renderer
and UI are strictly *read-only views* of the simulation; only `Simulation.step()`
mutates state.

This is no longer enforced by convention alone. The engine is its own workspace
package with its own **DOM-free** `tsconfig`, and CI runs `npm run typecheck:engine`
against it: because that config's `lib` is `ES2022` only (no `"DOM"`) and it sees
no game source, any accidental reach into the browser, the renderer, or the game
layer fails to compile. The boundary is now self-enforcing.

The game consumes the engine through its package name, never a relative path:

```ts
import { summarizeOrbit } from "@lightlag/engine/orbit";   // fine-grained subpath
import { orbit, sim, vec3 } from "@lightlag/engine";        // namespaced barrel
```

`@lightlag/engine/<module>` maps 1:1 to `packages/engine/src/<module>.ts` via the
package's wildcard `exports`. There is no build step — Vite, Vitest, and `tsc`
(bundler resolution) all consume the engine's TypeScript source directly through
the workspace symlink.

## The engine — `packages/engine/` (`@lightlag/engine`, pure, deterministic, SI)

Game-agnostic. No framework, no renderer, no wall-clock, no `Math.random()` in
the hot path. Everything is double-precision SI and a pure function of state + time.
Module paths below are relative to `packages/engine/src/` (and imported as
`@lightlag/engine/<module>`). The package barrel `index.ts` re-exports every module
under a namespace for the `import { orbit, sim } from "@lightlag/engine"` form.

### Math primitives

| Module | Provides |
|---|---|
| `math/vec3.ts` | f64 vector ops (plain `{x,y,z}`, serializable). |
| `math/kepler.ts` | Kepler solvers (elliptic + hyperbolic), coe↔rv, propagation, orbit sampling. |
| `math/integrators.ts` | RK4 integrator for powered flight. |
| `math/relativity.ts` | Special-relativistic coordinate acceleration from a proper-frame force (Rindler decomposition along/across velocity, clamped below `c`) — the relativistic powered-flight derivative. |

### Core simulation

| Module | Provides |
|---|---|
| `constants.ts` | Physical constants + real Solar-System body data (JPL elements, μ=GM, radii, atmospheres). |
| `ephemeris.ts` | Analytic body state (position, velocity) at any `t`. |
| `orbit.ts` | vis-viva, apsides, periods, maneuver frame, SOI radius, Oberth burn, J2 secular precession rates, sun-synchronous inclination. |
| `perturbations.ts` | Shared gravitational acceleration TERMS — `centralAccel`, `j2ZonalAccel`, `thirdBodyAccel` (the differential/tidal term) — the "one gravity law" reused by the force overlay AND the integrators, so the arrow shown and the path flown can't drift apart. |
| `perturbed.ts` | The higher-fidelity propagator: a deterministic RK4 integrating a ship under central + selected third-body (+ optional numerical J2) gravity, with the perturbers read from the analytic ephemeris (re-derivable, exact at any warp). Plus `selectPerturbers` and the read-time interpolant. The opt-in "perturbed" fidelity tier; the default game model is untouched. |
| `propulsion.ts` | Rocket equation, staging, Δv budget, electric power law (`F = min(F_rated, 2ηP/vₑ)`), variable-Isp constant-power throttle (`variableIspBurn`: thrust↔Isp↔time trade at `F·vₑ = 2ηP`); per-stage tank capacity (`stageCapacity`/`stageHeadroom`, the refuelling ceiling). |
| `ships.ts` | Ship mass/state/orbit helpers; impulsive Δv (with affordability check); thermal state readout. `coastElements` advances a coasting conic by Kepler + J2 secular precession + optional closed-form secular atmospheric drag (`Ship.drag`: constant ṅ → ½·ṅ·dt² along-track + SMA decay), every rate constant so it stays exact at any time-warp. A `Ship.stationKept` flag suppresses the drag decay (implicit-burn station-keeping) so maintained craft hold their orbit. |
| `refuel.ts` | Rendezvous-gated orbital propellant transfer + in-orbit assembly: `dockState`/`isDockable` (shared-primary, co-located gate), `transferProp` (mass-conserving, capacity-capped), `mergeStacks` (dock-merge two craft into one). |
| `surface.ts` | Landing/takeoff Δv budgets: calibrated gravity-turn ascent through real exponential atmospheres, aerobraking fraction on descent. |
| `forces.ts` | Read-only force/momentum breakdown for the overlay: dominant gravitational pull, secondary tidal perturbation, and primary-relative velocity for a body or ship (`bodyForceBreakdown`, `shipForceBreakdown`). |
| `trajectory.ts` | Live ship forecast path sampled from osculating elements — a continuous, snap-free bound ellipse or unbound arc with a trailing past arc (`shipForecastPath`). |
| `route.ts` | Heliocentric Lambert transfer geometry for visualization: single- or multi-leg paths with optional gravity-assist bends and context rings (`planRoute`). |
| `thermal.ts` | Stefan-Boltzmann heat budget, solar flux (1/r²), detection range — the "no stealth in space" pillar. |
| `stars.ts` | Nearest ~24 star systems in ecliptic-J2000 frame (interstellar destinations). |
| `comms.ts` | Light-time, signal propagation at `c`, retarded (delayed) state of a moving target. |
| `serialize.ts` | Canonical, deterministic world serialization (sorted Maps, 12-sig-fig quantization) + `hashWorld` (the golden-state CI oracle). Foundation for Phase-8 save/load. |
| `scenario.ts` | Deterministic **snapshots & scenarios**: a lossless (full-f64) `SimSnapshot` of world + pending events + warp; `snapshot`/`restore`/`restoreInto` (bit-exact resume — the save/load + replay-scrub foundation); a serializable `Scenario` (seed + objectives) and `evaluateObjective`. The event queue is snapshotted as data, not re-derived. |
| `time.ts` | Clock, time-warp levels, deterministic event queue (with `snapshot`/`load`), calendar formatting. |
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
| `maneuver/flyby.ts` | Patched-conic gravity-flyby geometry (vₓ in/out rotation, turn angle, periapsis) + B-plane aim (`bPlaneAim`: free-bend hyperbola e/rp, impact parameter, B-vector/plane-normal). |
| `maneuver/assist.ts` | Gravity-assist solver: a two-leg single-flyby plan (`assistTransfer`) with grid search for the cheapest window, and an N-body multi-flyby chain (`chainAssist`, e.g. V-E-E-G-A) over a fixed schedule. |
| `maneuver/moon.ts` | Parent-centric Lambert transfer-window search from a parking orbit to a moon (J2-aware arrival aiming) — the LEO→Moon / planet-orbit→moon leg (`searchMoonWindow`). |
| `maneuver/moonTour.ts` | Parent-centric gravity-assist moon-flyby chains: planet orbit → free/paid moon flybys → capture (`searchMoonTour`, `moonTour`). |
| `maneuver/suggest.ts` | Auto-route suggester: ranks a direct transfer, single-flyby assists, and VEEGA-style two-flyby chains by the chosen criterion (`suggestRoutes`, `bestAssist`, `bestChain`). |
| `maneuver/criteria.ts` | Trajectory scoring layer — least-Δv / shortest-flight / balanced criterion with a strict total-order comparator (`score`, `better`, `Criterion`). |
| `maneuver/lowThrust.ts` | Edelbaum analytic spiral: exact Δv/time/propellant for a power-limited electric transfer between near-circular orbits (and coplanar inclination change), plus capture/escape spirals about a single body's well (the r→∞ limit, Δv = local circular speed). |
| `maneuver/entry.ts` | Ballistic atmospheric-entry trajectory (RK4 through the exponential atmosphere): peak deceleration, Sutton-Graves convective stagnation heat flux, radiative-equilibrium wall temperature, integrated heat load, and land/capture/skip-out outcome; plus single-pass aerocapture (bisection on the entry corridor) with the Δv saved vs a propulsive capture burn. |
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

## The game / presentation — `src/render/`, `src/ui/`, `src/app/`

These live at the repo root under `src/` and depend on `@lightlag/engine`. This is
the current game (the strategy sim). A second purpose would be a sibling — a new
`apps/<name>/` (or its own `src/`) consuming the same engine. The modules here are
*views and intent*, never physics.

`src/sandbox/` is the first additional purpose growing in place (per the
multi-product plan): an orbital playground that adds **live-satellite ingestion**
(TLE→SGP4→read-only ships, `satellites.ts`), **mission replay/scrub** over the
deterministic engine (`replay.ts`, on `scenario.ts`), and **informative light-lag**
(`Simulation.commandPolicy`). It reuses the existing render/UI; its panel
(`ui/sandboxPanel.ts`) is purely additive. Shared packages (`viz`, `ui-kit`, …) get
extracted only when a *second* consuming app needs them.

A TLE is exact only near its epoch. Ingestion seeds the satellite's osculating
elements via SGP4 at spawn, then the engine coasts it on Kepler + J2 secular. Real
catalog satellites are actively maintained, so they are ingested as **station-kept**
(`Ship.stationKept`): the engine models the corrective burns implicitly (no Δv), so an
orbit holds rather than spiralling in — or, for a negative-ṅ fit, ballooning out — when
warped far past epoch. The TLE's measured secular drag (`Ship.drag`, the rung-1 ṅ) is
recorded but suppressed; it is the orbit's *natural* decay, the basis for sizing real
station-keeping Δv on player ships later. The un-kept rung-1 decay model stays in the
engine for objects that genuinely decay (debris); see ROADMAP for the rung-2 upgrade
(altitude/B*/F10.7-driven King-Hele decay) and player-ship Δv-accounted station-keeping.

### `render/` — Three.js read-only view

| Module | Provides |
|---|---|
| `SceneManager.ts` | Three.js scene, camera, WebGL renderer, OrbitControls, floating origin (re-centred every frame on the focused body), theme (dark/light), HDR post chain (bloom + depth-of-field), and the "vanity" lens (focal length / FOV, DOF with click-to-rack focus, camera roll). |
| `bodyViews.ts` | Body sphere meshes, ecliptic orbit lines (eccentric-anomaly sampled and phased so the loop passes through the marker), label anchor NDC coordinates. |
| `bodyTextures.ts` | Procedural, seeded (deterministic, zero image assets) surface textures generated at startup — granulation, bands, oceans, craters, atmosphere shells, rings (`createBodyTextures`). |
| `bodyFeatures.ts` | Real IAU-gazetteer surface-feature tables (maria, canyons, mountains, polar caps) drawn over the procedural base (`BODY_FEATURES`). |
| `earthLand.ts` | Simplified real Earth coastline polygons (Natural Earth 1:110m) rasterised into a land/sea mask (`LAND_POLYS`). |
| `shipViews.ts` | Ship marker meshes + floating name labels in screen space. |
| `trajectoryViews.ts` | Ship trajectory overlays — the live forecast arc, committed planned routes, and the transfer-planner preview ghost (`TrajectoryViews`). |
| `forceViews.ts` | Gravity/momentum vector overlay for the focused object — dominant gravity arrow, velocity arrow, faint tidal perturbation (`ForceViews`). |
| `overlayUtil.ts` | Shared render-space primitives for overlays (trajectories, routes, forces): polylines, arrows, floating-origin transforms, theme-aware palette. |
| `starViews.ts` | The in-system sky: point markers for the nearby real star systems on an unzoomable camera-locked backdrop, in their true Sun→star direction (no procedural starfield). |
| `interstellarView.ts` | The interstellar map: the ~24 nearby systems at real relative distances about Sol (its own scale), plus ships in transit. The second of the two views — toggled via the HUD switch / `M`. |
| `commsViews.ts` | Light-cone / signal-in-flight visualizations (outbound commands, inbound telemetry). |
| `visibility.ts` | Shared show/hide state — per-body and per-kind toggles plus cross-cutting layers (orbits, labels, stars, ships, comms). Written by the HUD, read by every view. |
| `scale.ts` | Metre ↔ render-unit conversion; logarithmic depth for solar-system-scale precision in float32. |

### `ui/` — DOM panels over the WebGL canvas

| Module | Provides |
|---|---|
| `hud.ts` | Clock, time-warp controls, body focus list (grouped by kind, scrollable) with per-body / per-kind show-hide eyes and a layer-chip row (orbits, labels, stars, ships, comms), a system⇄interstellar view switch, per-body physics readouts (distance, speed, period, surface gravity, light-time), floating body labels, theme toggle. |
| `shipPanel.ts` | Ship designer (staged stack editor, live Δv budget, preset fleet picker) + flight console (osculating orbit, mass, Δv remaining, burn orders, transfer status, J2 precession, surface ops, electric spiral, thermal/detection readouts). |
| `transferPanel.ts` | Transfer planner: grouped destination list (planets / dwarfs / asteroids / comets / moons), porkchop plot (Lambert grid, blue/red Δv colour scale), an **Optimize for** selector (least Δv / shortest / balanced) and a **Suggest** auto-route search, optional gravity-assist via-flyby-body mode, capture-mode choice (circular / loose ellipse / aerocapture), cell selection, commit to `planTransfer` / `planAssist` / `planMoonTransfer` / `planMoonMission`. |
| `interstellarPanel.ts` | Interstellar planner: star selector (sorted by distance), torchship selector, transit estimator (coordinate/proper time, mass ratio, light-lag), dispatch to `dispatchInterstellar`. |
| `keyboard.ts` | Central keyboard input: one-shot shortcuts (Space, `,` `.`, `1`–`8`, Tab, `F`, `V`, `M`, `R`, `?`, Escape) + smooth per-frame camera orbit (WASD/arrows) and zoom (`+`/`-`). |
| `dom.ts` | Shared DOM helpers for the panels — element/button/row/number-field builders that auto-tag glossary terms for tooltips (`el`, `button`, `kv`, `numberField`, `formatDur`). |
| `collapsible.ts` | Disclosure section (clickable header + toggleable body) whose open/closed state persists via `uiState` (`collapsible`). |
| `popover.ts` | Anchored flyout panel (trigger + floating content), repositioned on open, closes on escape/outside-click — used for the Layers menu (`popover`). |
| `tooltip.ts` | Hover/focus definition cards for glossary terms — one reused card, term-keyed, clamped to the viewport (`installTermTooltips`, `markTerm`). |
| `glossary.ts` | Physics-true term definitions (Δv, periapsis, aerocapture, …) — the single source for the hover cards (`defineTerm`, `hasTerm`). |
| `scaleBar.ts` | Cartographic scale-bar overlay on the canvas — auto unit selection (m → parsecs), {1,2,5}×10ⁿ rounding (`ScaleBar`). |
| `uiState.ts` | Persisted UI layout state (localStorage wrapper, fail-soft, namespaced) — panel docks, disclosure sections, layer toggles (`getFlag`, `setFlag`). |

### `app/` — wiring and command semantics

| Module | Provides |
|---|---|
| `main.ts` | Entry point: constructs all layers and runs the one-way frame loop (sim advance → render read). |
| `commands.ts` | Player intents → validated world mutations: `spawnShip` (in-space → LEO) / `spawnOnPad` (launch vehicle → Earth pad) / `expressToOrbit` (fly the ascent instantly) / `ascentPreview` / `deleteShip`, `sendBurn` (via light-lag `sim.sendCommand`), `planTransfer` / `cancelTransfer`, `planAssist` / `planChainAssist`, `planMoonTransfer` / `planMoonTour` / `planMoonMission` (auto-chained two-stage), `landShip`, `launchShip` (`opts.instant`), `flyEntry`, `planSpiral`, `dispatchInterstellar`, `transferPropellant` / `assembleShips` / `dockCandidates` (orbital refuelling & assembly), plus capture/aerocapture preview helpers. |
| `shipCatalog.ts` | 30+ preset ship designs (Historical / Current / Prototype / Sci-Fi), every number from published data. Includes classical staged presets and `INTERSTELLAR_CRAFT` for the relativistic layer. |

## Building another game on the engine

Add `@lightlag/engine` as a dependency and provide your own render/UI layer and
your own `commands` + event semantics. The engine gives you correct orbits,
transfers, propulsion, SOI patched conics, thermal/detection, and light-lag for
free — none of it assumes a particular game.

```ts
import { Simulation } from "@lightlag/engine/sim";
import { createWorld } from "@lightlag/engine/world";
import { searchMoonWindow } from "@lightlag/engine/maneuver/moon";
// …your own commands, your own views, your own goals.
```

A new purpose lives beside the current game (e.g. `apps/courier/`), depends on the
same engine package, and is free to diverge completely above the physics. The
engine's golden-state determinism guard and full physics test suite protect every
consumer at once.

## Workspace layout

```
packages/
  engine/                @lightlag/engine — the physics engine (pure, SI, deterministic)
    package.json         name + wildcard exports ("./*" → "./src/*.ts"); no build step
    tsconfig.json        DOM-FREE config — the boundary gate (npm run typecheck:engine)
    src/                 the former src/core/, unchanged; index.ts is the namespaced barrel
src/                     the game (the strategy sim) — depends on @lightlag/engine
  render/ ui/ app/       Three.js views, DOM panels, wiring + command semantics
  integration/           app↔engine integration tests (see below)
```

npm workspaces wire it: the root is the game **and** the workspace root; `npm install`
symlinks `node_modules/@lightlag/engine` → `packages/engine`. One `tsc --noEmit` and one
`vitest` run cover both layers; `npm run typecheck:engine` additionally checks the engine
in DOM-free isolation as the enforced boundary.

### Why the integration tests moved

The engine's own test suite is pure — it imports only `@lightlag/engine`. Four suites,
however, drive the kernel **through the game's command layer** (`spawnShip`, `planTransfer`,
…), so they couple the engine to the app by definition. Those (`sim.test.ts`,
`integration.test.ts`, `j2.test.ts`, and their shared `test-helpers.ts`) now live in
`src/integration/` on the game side. Keeping them there is what lets the engine package
stand alone: `packages/engine/` has **zero** dependency on the game, in product code and
in tests alike.

## The one remaining tease-apart

`sim.ts` still contains *game-specific* event handlers (interplanetary transfer departure,
SOI capture, flyby pass, spiral arrival, and light-lag command delivery) alongside the
generic step/event kernel. They are pure and engine-safe today, but they bake in *this*
game's notion of what events mean. For maximum reuse across very different purposes, these
should become **handlers the consumer registers**, leaving `sim.ts` as just the generic
time-advance + event-queue machinery. This is the natural next refactor when a second
purpose needs different event semantics — `sim.ts` is the marker for it.
