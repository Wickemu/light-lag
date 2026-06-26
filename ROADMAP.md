# LIGHTLAG — roadmap

**Status:** Phases 1–6 complete; core-physics hardening pass complete (ephemeris
tightening + Horizons cross-check, integration-invariant suite, golden-state
determinism, and an adversarial cross-subsystem audit with its confirmed findings
fixed). The reusable physics engine is `src/core/` (see
[ARCHITECTURE.md](ARCHITECTURE.md)); 227 passing physics/sim tests — including a
JPL Horizons ephemeris cross-check, cross-subsystem conservation/SOI-continuity
(entry **and** egress) invariants, off-nominal flyby + abort handling, and a
golden-state determinism hash.

Built so far: real ephemeris + Keplerian orbits, the rocket equation + staging +
RK4 powered flight, transfer planning (Lambert / Hohmann / porkchop / real launch
windows), patched-conic SOI capture, light-lag command (the thesis), and
thermal / power / detection ("no stealth in space"). Plus parallel-session
add-ons: a 30-craft preset catalog and keyboard controls.

**Core-mechanics expansion (latest):** the full Solar System — 37 bodies, adding
the dwarf planets (Ceres, Pluto, Eris, Haumea, Makemake), major asteroids (Vesta,
Pallas), and the gas-giant & other moons (Galileans, Titan + six Saturnians, five
Uranians, Triton, Phobos/Deimos, Charon), each on a JPL-validated ephemeris;
**landing & takeoff** Δv/propellant budgeting (a calibrated gravity-turn ascent
through real atmospheres, with aerobraking on descent); and the first
**interstellar** layer — relativistic propulsion (rapidity rocket equation +
constant-proper-accel brachistochrone), a ~27-system nearby-star catalog, a
transit estimator, and an in-sim flyable flip-and-burn with crew/Earth time
dilation.

## Now — core physics hardening (current focus)

Not a feature phase. With every physics layer in place, verify them *together*:
cross-subsystem conservation/continuity invariants, end-to-end mission accounting,
and golden-state determinism. Goal: the physics core is provably correct and
locked by a permanent integration test suite before more gameplay is layered on.

## Coming phases (address soon)

### Phase 7 — Mass economy · resources · depots · colonization
- Wealth is **mass, energy, Δv, heat** — never abstract money.
- **Propellant depots + refueling**: docking transfers propellant, raising m₀ → Δv.
- **ISRU**: mine volatiles (water ice from comets/moons/regolith) → propellant +
  life support; everything traces back to energy.
- A **colony/base** with supply requirements that must be resupplied within a
  transfer window; missing the window has consequences.
- v1 resource cap: propellant, structure, life-support mass (~3 resources).

### Phase 8 — Polish · persistence · determinism-in-CI
- Versioned **save/load** (`JSON.stringify(WorldState)` + command log + schema version).
- **Golden-state determinism** test in CI (headless harness hashes final state).
- HUD/legibility pass; onboarding / tutorialized vertical slice; light + dark verified.

## Backlog — known engine gaps (future layers)

- **Relativistic propulsion** — DONE (first cut): rapidity rocket equation,
  constant-proper-accel brachistochrone, time dilation / proper-time divergence,
  and an in-sim flyable interstellar leg; `PENDING_RELATIVISTIC` is now the flyable
  `INTERSTELLAR_CRAFT` roster. Still to do: in-system relativistic burns (the
  finite-thrust integrator is still classical), multi-leg coast cruises rendered
  in-sim, and stellar proper motion.
- **Power-limited electric thrust** — DONE: an `ElectricSource {powerW, eta, solar}`
  on a stage drives the *actual* thrust `F = min(F_rated, 2ηP/vₑ)`, with solar power
  falling as 1/r² toward the Sun (reactor power constant); the ship console reads
  out drive power (kW @ AU) and live thrust/accel. Long electric transfers are flown
  as an analytic Edelbaum spiral leg (`Δv = √(v0²+v1²−2v0v1·cos(½π·Δi))`, semi-major
  axis linear, phase in closed form) — committed with Δv/propellant charged up front
  and exact at any time-warp, rather than an impractical months-long stepped burn.
  Five solar-electric + one VASIMR craft ship with the catalog. Still to do:
  variable-Isp throttling and a powered low-thrust capture/escape spiral about a
  destination body.
- **Parallel staging** / strap-on boosters / drop tanks (serial stages only now).
- **Gravity assists** — DONE (first cut): flyby physics (flyby.ts), a two-leg
  patched-conic assist solver (assist.ts), and in-sim execution (a flyby-pass that
  bends the heliocentric velocity for free and continues to the target), with a
  "via flyby" planner mode. Still to do: multi-flyby chains and full free-bend
  B-plane targeting (the executor uses a patched-conic point + charged residual).
- **Transfer toolkit** — DONE: plane-change Δv, bi-elliptic transfers, and
  multi-revolution Lambert (wired into the porkchop).
- **J2 oblateness** — DONE: secular nodal/apsidal precession of ship/station
  orbits about oblate bodies (orbit.ts j2Rates), applied analytically at read time
  (exact at any time-warp; golden-hash-neutral), with a sun-synchronous-inclination
  helper. Still to do: full N-body perturbations, J3+ harmonics, and J2 on the
  capture/aim geometry (the hyperbolic approach is still pure two-body).
- **Full B-plane targeting in the planner UI** (B-plane solved at execution today).
- **SOI-as-point departure** (parking-orbit offset dropped) — documented
  approximation; refine if close-range nav matters.
- **Validity window past 1800–2050** (the giants' 3000 BC–3000 AD b,c,s,f
  libration terms). Evaluated during the hardening pass and deferred: the JPL
  3000 BC–3000 AD table trades in-window precision for range, and the engine's
  era is the 21st century, where the 1800–2050 model is more accurate (confirmed
  vs Horizons). Worth revisiting only if far-future/ancient play is prioritized.
- **Detection model**: single-band IR + reflected, now with a zodiacal+CMB
  background floor (range goes sky-limited once the signal noise is
  background-dominated). Still single-band with no explicit integration time or
  SNR>1 threshold — refine for a fully defensible SNR-vs-range curve.
- **Landing / takeoff** — DONE (first cut): a calibrated gravity-turn ascent Δv
  budget through real exponential atmospheres + an aerobraking descent model, with
  in-sim land/launch and co-rotating landed ships (sit on the surface at surface
  speed). Still to do: full aerocapture trajectories and atmospheric-entry heating.
- **More bodies** — DONE: 43 bodies (dwarfs, asteroids, gas-giant & other moons,
  plus TNOs and comets) on the fixed-J2000-conic (`FixedHelioRow`) + `MoonRow`
  paths, Horizons-checked. Still to do: irregular-moon precession, more small
  bodies, comet outgassing/non-gravitational forces.
- Minor fidelity: EMB-vs-Earth-centre ~4671 km offset; Moon & small-body two-body
  precession drift over years; the Pluto–Charon barycentre approximation.

## Consciously-deferred audit notes (non-blocking, already judged)

- comms: control node treated as fixed during light-travel (O(v/c), ~0.13 s at
  Earth–Mars max range).
- comms: a command's light-arrival time is solved once at emission and not
  re-solved if the ship's path is later mutated in flight (a second delivered
  burn, or an SOI patch). The firing-instant drift is O(δr/c) — sub-millisecond
  at in-system speeds — and the burn still executes against the ship's real live
  state, so only the timing (not the physics or Δv) is slightly stale.
- `arrival.ts`: aim bisection returns the smallest achievable periapsis if the
  requested one is below reachable (a safe over-shoot).
- Equal-time event tie-break is insertion order (deterministic for current
  schedulers; revisit if simultaneous cross-ship events become common).
