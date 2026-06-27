# LIGHTLAG

A space-based strategy sim with one inviolable rule: **physics is never hand-waved.**
Relativity, the rocket equation, the speed of light, thermodynamics, materials limits — none
of it is decoration. It's the whole game.

You command a spacefaring effort across a real, to-scale Solar System. You will never see the
present (light takes minutes to hours to reach you) and you can never directly fly the distant
(you send instructions that crawl outward at *c*). You move mass by paying real Δv out of a real
propellant budget, on transfer windows dictated by orbital geometry, while shedding waste heat
that no amount of engineering can wish away.

> Single-player sandbox. The antagonist is physics.

## The five pillars (all consequences of real physics)

1. **Command under light-lag** — your view of each object is a *retarded snapshot*, delayed by
   `distance / c`. Commands propagate at `c` and are acknowledged a round-trip later. The map is
   the past.
2. **The rocket equation is the economy** — wealth is mass, Δv, energy, and heat, not money.
   `Δv = vₑ·ln(m₀/m_f)`. Staging, propellant depots, and shallow gravity wells are strategy.
3. **Orbital mechanics is the clock** — Hohmann/Lambert transfers, synodic launch windows, the
   Oberth effect. The reachable map pulses with planetary geometry.
4. **Thermodynamics is inescapable** — waste heat can only be radiated (`P = εσAT⁴`). Power →
   radiator area → IR signature → detection range. There is no real stealth in space.
5. **Materials & energy set the ceilings** — specific power (kW/kg) caps acceleration, solar
   power falls as `1/r²`, tensile strength caps tethers and spin gravity.

## Status

**Phases 1–6 + core-mechanics expansion complete** — a deterministic physics engine and a
flyable, to-scale 3D Solar System.

- Real JPL ephemeris for **43 bodies** — the 8 planets, the dwarf planets, major asteroids, the
  gas-giant & other moons (Galileans, Titan + six Saturnians, five Uranians, Triton, Phobos/Deimos,
  Charon), and TNOs + comets (Sedna, Quaoar, Gonggong, Orcus, 1P/Halley, 2P/Encke); analytic
  Keplerian propagation exact at any time-warp, cross-checked to machine precision at J2000 vs Horizons.
- **Light-lag command** — the thesis of the game: commands propagate from Earth at `c`; your view
  of every ship is a retarded snapshot (delayed by `distance / c`), and orders are acknowledged
  only a round-trip later. A NACK arrives if the ship can't execute (out of propellant, wrong
  frame). Telemetry replies propagate back at `c` the same way.
- **Transfer toolkit**: Hohmann, Lambert (multi-revolution), porkchop launch windows, bi-elliptic
  transfers, plane changes, and **gravity-assist flybys** — plan an Earth→Jupiter→Saturn
  slingshot and watch the heliocentric energy jump at the flyby (the bend is free). Gravity-assist
  via-body mode in the transfer planner; the in-sim executor uses patched-conic geometry.
- **Landing & takeoff** Δv/propellant budgeting: a calibrated gravity-turn ascent through real
  exponential atmospheres (Earth→LEO ≈ 9.3 km/s, Moon ≈ 1.9, Mars ≈ 4.0), aerobraking on
  descent, and ships that sit on the surface co-rotating with the body.
- **Atmospheric-entry heating & aerocapture**: a real ballistic entry trajectory integrated
  through the exponential atmosphere — peak deceleration (cross-checked against Allen-Eggers),
  Sutton-Graves convective stagnation heat flux, radiative-equilibrium wall temperature, and
  the integrated heat load that sizes a heat shield. Aerocapture solves the single-pass
  corridor that captures a hyperbolic arrival into a bound orbit, saving nearly the whole
  propulsive capture burn (a Mars arrival captures for ~10 m/s of trim instead of ~2 km/s).
- **Electric (low-thrust) propulsion**: power-limited ion/Hall drives whose real thrust is
  `min(F_rated, 2ηP/vₑ)` with solar power falling as 1/r² — fly a multi-month Edelbaum spiral
  from LEO to GEO (or any near-circular orbit), charged up front and exact at any time-warp.
- **Interstellar** first steps: a relativistic propulsion layer (rapidity rocket equation +
  constant-proper-accel brachistochrone), the ~24 nearest star systems, a transit estimator, and
  an in-sim flyable flip-and-burn where the crew clock and Earth clock visibly diverge.
- **Thermal & detection** — there is no stealth in space: hull temperature (Stefan-Boltzmann),
  IR signature, and a defensible **SNR-vs-range** detection curve are live readouts. The
  detection model is the radiometer equation — a real detector noise-equivalent power,
  an integration time τ, a 5σ threshold, and background photon shot noise — so range
  improves only as τ^(1/4) and √(aperture) and still falls only as √(signature). A cold
  hull is visible ~0.1 AU off; a thrusting drive is a beacon across tens of AU.
- **J2 oblateness**: secular nodal/apsidal precession applied analytically at read time (exact at
  any time-warp); sun-synchronous inclination helper.
- **Preset ship catalog**: 30+ real and inferred designs across Historical / Current / Prototype /
  Sci-Fi categories — Saturn V, Falcon 9, ion tugs, Daedalus, photon drives — every number from
  published data, no tuning for balance.
- Floating-origin + logarithmic-depth rendering for solar-system-scale precision in float32.
- Time warp from real-time to 1 yr/s, a live calendar, body focus, and physics readouts
  (orbital period, heliocentric speed, surface gravity/escape velocity, one-way light-time).
- **Deterministic serialize/hash**: `serializeWorld` / `hashWorld` for golden-state CI checks
  and as the foundation for Phase-8 save/load.

See [ROADMAP.md](ROADMAP.md) for the full feature backlog and candidate next phases.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

Controls:

| Key(s) | Action |
|---|---|
| Drag / WASD / ↑↓←→ | Orbit camera |
| Scroll / `+` `-` | Zoom |
| Space | Pause / resume |
| `,` / `.` | Slower / faster time-warp |
| `1`–`8` | Focus Sun, Mercury, Venus, Earth, Moon, Mars, Jupiter, Saturn |
| Tab / Shift+Tab | Cycle focus forward / backward through all 43 bodies |
| `F` | Toggle ship designer & flight console |
| `V` | Cycle camera view angle (isometric → top-down → edge-on) |
| `R` / Home | Reset camera distance for current focus |
| Escape | Close transfer or interstellar planner (then ship panel) |
| `◐` (button) | Toggle light / dark theme |

Show / hide is in the **FOCUS** panel: an eye toggle on each body (and each
group header) hides that object or the whole kind, and a chip row toggles the
cross-cutting layers — orbit lines, labels, the nearby-star sky, ships, and
in-flight comms.

## Develop

```bash
npm test           # vitest — the physics core is tested hard
npm run typecheck  # strict TypeScript, no emit
npm run build      # static, zero-install production bundle
```

## Architecture

The single rule that everything rests on: **the simulation core is a pure, deterministic,
double-precision SI module with zero renderer dependencies. Three.js only ever *reads* it.**

```
src/
  core/                  pure f64 SI physics — no three.js import anywhere
    math/
      vec3.ts            f64 vector ops ({x,y,z}, serializable)
      kepler.ts          Kepler solvers, coe↔rv, propagation
      integrators.ts     RK4 for powered flight
    maneuver/
      lambert.ts         Lambert solver (single + multi-revolution)
      hohmann.ts         Hohmann transfer + synodic period
      porkchop.ts        launch-window sweep (Lambert grid)
      biElliptic.ts      bi-elliptic transfer
      arrival.ts         B-plane hyperbolic approach targeting
      flyby.ts           gravity-flyby geometry
      assist.ts          two-leg gravity-assist solver + grid search
      lowThrust.ts       Edelbaum analytic spiral (electric, power-limited)
      entry.ts           ballistic entry heating (Sutton-Graves) + aerocapture
      interstellar.ts    relativistic brachistochrone + transit estimator
    constants.ts         physical constants + body catalog (JPL elements, μ, radii)
    ephemeris.ts         analytic body state at any t
    orbit.ts             vis-viva, maneuver frame, SOI, Oberth, J2 precession rates
    propulsion.ts        rocket equation, staging, Δv budget, electric power law
    ships.ts             ship helpers: state, mass, Δv, thermal readout
    surface.ts           landing/takeoff Δv: gravity-turn, atmospheres, aerobraking
    thermal.ts           Stefan-Boltzmann, solar flux, detection range
    stars.ts             nearest ~24 star systems in ecliptic-J2000 frame
    comms.ts             light-time, signal propagation at c, retarded state
    serialize.ts         canonical world serialization + hashWorld (golden-state oracle)
    time.ts              clock, time-warp levels, event queue, calendar
    world.ts             WorldState — plain serializable data (the save format)
    sim.ts               step kernel: time advance, RK4, event dispatch, light-lag command delivery
  render/                three.js read-only view — never feeds back into core
    SceneManager.ts      scene, camera, renderer, floating origin, OrbitControls
    bodyViews.ts         body meshes, orbit lines (phased through the marker), label anchors
    shipViews.ts         ship meshes + floating name labels
    starViews.ts         nearby real-star markers (the only sky; no procedural starfield)
    commsViews.ts        light-cone / signal-in-flight visualizations
    visibility.ts        shared show/hide state (per-body, per-kind, per-layer)
    scale.ts             metre ↔ render-unit conversion, logarithmic depth
  ui/                    DOM panels over the WebGL canvas
    hud.ts               clock, warp, body list + show/hide layers, readouts, labels, theme
    shipPanel.ts         ship designer, flight console, surface ops, electric spiral, thermal
    transferPanel.ts     porkchop plot, gravity-assist via mode, commit
    interstellarPanel.ts star picker, torchship selector, transit estimator, dispatch
    keyboard.ts          shortcuts + smooth per-frame camera orbit/zoom
  app/                   wiring
    main.ts              entry point + the one-way frame loop
    commands.ts          player intents → validated world mutations
    shipCatalog.ts       30+ preset designs (Historical / Current / Prototype / Sci-Fi)
```

Determinism is a feature: state is plain serializable data, advanced only by `sim.step()`; the
renderer and HUD never feed back into it. No `Date.now()` or `Math.random()` in the core.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the dependency rules, engine contract, and the
path to a standalone `@lightlag/engine` package.

## License

TBD.
