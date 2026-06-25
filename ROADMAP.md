# LIGHTLAG — roadmap

**Status:** Phases 1–6 complete and adversarially audited. The reusable physics
engine is `src/core/` (see [ARCHITECTURE.md](ARCHITECTURE.md)); 178 passing
physics/sim tests.

Built so far: real ephemeris + Keplerian orbits, the rocket equation + staging +
RK4 powered flight, transfer planning (Lambert / Hohmann / porkchop / real launch
windows), patched-conic SOI capture, light-lag command (the thesis), and
thermal / power / detection ("no stealth in space"). Plus parallel-session
add-ons: a 30-craft preset catalog and keyboard controls.

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

- **Relativistic propulsion**: torchships, >0.1c, relativistic rocket equation,
  time dilation / proper-time divergence (catalog `PENDING_RELATIVISTIC`). The
  comms layer is already kept 4D-consistent for this.
- **Power-limited electric thrust**: wire specific power (kW/kg) + solar 1/r² /
  reactor into the *actual* thrust (electric engines are a fixed operating point
  today; thermal is a readout). `a_max = 2ηP/(vₑ·m)`.
- **Parallel staging** / strap-on boosters / drop tanks (serial stages only now).
- **N-body perturbations & J2** (currently two-body + patched conics); multi-SOI
  flyby chains; gravity assists as a planned maneuver.
- **Multi-revolution Lambert** + full B-plane targeting in the planner UI
  (single-rev now; B-plane solved at execution).
- **SOI-as-point departure** (parking-orbit offset dropped) — documented
  approximation; refine if close-range nav matters.
- **Standish outer-planet correction terms** (b,c,s,f) for validity past 1800–2050.
- **Detection model**: single-band IR + reflected; sensor NEP/aperture is a
  calibration scale (no integration time / zodiacal+CMB background floor) — fold
  in for a defensible SNR=1 range.
- **Aerobraking / aerocapture**; surface operations; landing.
- Minor fidelity: EMB-vs-Earth-centre ~4671 km offset; Moon two-body precession
  drift over years.

## Consciously-deferred audit notes (non-blocking, already judged)

- comms: control node treated as fixed during light-travel (O(v/c), ~0.13 s at
  Earth–Mars max range).
- `arrival.ts`: aim bisection returns the smallest achievable periapsis if the
  requested one is below reachable (a safe over-shoot).
- Equal-time event tie-break is insertion order (deterministic for current
  schedulers; revisit if simultaneous cross-ship events become common).
