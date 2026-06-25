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

**Phase 1 complete** — a deterministic physics core and a flyable, to-scale 3D Solar System.

- Real JPL ephemeris for **37 bodies** — the 8 planets, the dwarf planets (Ceres, Pluto, Eris,
  Haumea, Makemake), major asteroids (Vesta, Pallas), and the gas-giant & other moons (Galileans,
  Titan + six Saturnians, five Uranians, Triton, Phobos/Deimos, Charon); analytic Keplerian
  propagation exact at any time-warp, cross-checked to machine precision at J2000 vs Horizons.
- **Landing & takeoff** Δv/propellant budgeting: a calibrated gravity-turn ascent through real
  exponential atmospheres (Earth→LEO ≈ 9.3 km/s, Moon ≈ 1.9, Mars ≈ 4.0), aerobraking on descent.
- **Interstellar** first steps: a relativistic propulsion layer (rapidity rocket equation +
  constant-proper-accel brachistochrone), the ~27 nearest star systems, a transit estimator, and
  an in-sim flyable flip-and-burn where the crew clock and Earth clock visibly diverge.
- Floating-origin + logarithmic-depth rendering for solar-system-scale precision in float32.
- Time warp from real-time to 1 yr/s, a live calendar, body focus, and physics readouts
  (orbital period, heliocentric speed, surface gravity/escape velocity, one-way light-time).

See `docs`/the design plan for the full roadmap (ship design & the rocket equation → transfer
planning & windows → patched conics & capture → light-lag command → thermal & detection →
economy & colonization).

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

Controls: drag to orbit · scroll to zoom · `«`/`»` (or `,`/`.`) to change time-warp · `space`
to pause · click a body to focus it · `◐` to toggle light/dark.

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
  core/      pure f64 SI physics — no three.js import anywhere
    math/    vec3, kepler (the keystone: solvers, coe↔rv, propagation)
    constants.ts   real bodies + physical constants (published mu = GM, JPL elements)
    ephemeris.ts   analytic body state at any t
    time.ts world.ts sim.ts   clock + event queue, world state, the step loop
  render/    three.js view: floating origin, LOD, orbits — reads the world
  ui/        HUD: clock, focus, live physics readouts
  app/       wiring + the one-way frame loop
```

Determinism is a feature: state is plain serializable data, advanced only by `sim.step()`; the
renderer and HUD never feed back into it. No `Date.now()` or `Math.random()` in the core.

## License

TBD.
