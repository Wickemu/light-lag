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

**Core-mechanics expansion (latest):** the full Solar System — 43 bodies total:
the 8 planets, the dwarf planets (Ceres, Pluto, Eris, Haumea, Makemake), major
asteroids (Vesta, Pallas), gas-giant & other moons (Galileans, Titan + six
Saturnians, five Uranians, Triton, Phobos/Deimos, Charon), and TNOs + comets
(Sedna, Quaoar, Gonggong, Orcus, 1P/Halley, 2P/Encke), each on a JPL-validated
ephemeris;
**landing & takeoff** Δv/propellant budgeting (a calibrated gravity-turn ascent
through real atmospheres, with aerobraking on descent); and the first
**interstellar** layer — relativistic propulsion (rapidity rocket equation +
constant-proper-accel brachistochrone), a ~24-system nearby-star catalog
(~12 ly radius, ecliptic-J2000 frame, drifting under real proper motion), a transit
estimator, and an in-sim flyable flip-and-burn with crew/Earth time dilation.

## Completed — core physics hardening

Not a feature phase. With every physics layer in place, verify them *together*:
cross-subsystem conservation/continuity invariants, end-to-end mission accounting,
and golden-state determinism. Goal (achieved): the physics core is provably correct
and locked by a permanent integration test suite before more gameplay is layered on.

Delivered: JPL Horizons ephemeris cross-check, conservation/SOI-continuity invariants
(entry **and** egress), off-nominal flyby + abort handling, golden-state determinism
hash (`hashWorld`), and an adversarial cross-subsystem audit with all confirmed
findings fixed. **The physics core is locked.**

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
- Versioned **save/load**: `serializeWorld` / `deserializeWorld` are done
  (`WorldState` round-trips cleanly); the remaining gap is re-scheduling the
  `EventQueue` (capture / SOI / message-arrival events) after a restore.
- **Golden-state determinism** test in CI (`hashWorld` is implemented; wire into a
  headless CI harness).
- HUD/legibility pass; onboarding / tutorialized vertical slice; light + dark verified.

## Next core-mechanics round — candidate priorities (highest-leverage first)

A curated, ranked view *into* the backlog below — the threads most worth picking up
next, after four expansion rounds (Solar System + landing → assists + toolkit → J2 →
electric propulsion). Each round stays additive: pure SI, deterministic, read-time
analytic, suite green, golden hash documented if it moves.

1. **In-system relativistic / finite-thrust burns** — the finite-thrust integrator is
   still classical; a rapidity-based integrator would harden the interstellar layer.
   *(see "Relativistic propulsion" → Still to do.)*
2. **Parallel staging / strap-on boosters / drop tanks** — serial stages only today; real
   launchers light boosters and core together and stage asymmetrically. *(see "Parallel
   staging".)*

*(Done since last round: **stellar proper motion** — the star catalog now carries real
Gaia/Hipparcos space-velocity vectors and drifts as a function of time, and interstellar
legs lead the target (see "Stellar proper motion" below). Earlier rounds: low-thrust
**capture/escape spirals** + **variable-Isp throttling** (see "Power-limited electric
thrust"); **multi-flyby assist chains** + analytic **free-bend B-plane targeting** (see
"Gravity assists").)*

These are candidates, not a commitment — pick the highest-leverage one when the next round
starts. Lower-priority refinements (aerocapture + entry heating, N-body/J3 perturbations, a
defensible SNR-vs-range detection curve, comet outgassing) live in the backlog entries below.

## Backlog — known engine gaps (future layers)

- **Relativistic propulsion** — DONE (first cut): rapidity rocket equation,
  constant-proper-accel brachistochrone, time dilation / proper-time divergence,
  and an in-sim flyable interstellar leg; `PENDING_RELATIVISTIC` is now the flyable
  `INTERSTELLAR_CRAFT` roster. Still to do: in-system relativistic burns (the
  finite-thrust integrator is still classical) and multi-leg coast cruises rendered
  in-sim. (**Stellar proper motion — DONE**; see its own entry below.)
- **Power-limited electric thrust** — DONE: an `ElectricSource {powerW, eta, solar}`
  on a stage drives the *actual* thrust `F = min(F_rated, 2ηP/vₑ)`, with solar power
  falling as 1/r² toward the Sun (reactor power constant); the ship console reads
  out drive power (kW @ AU) and live thrust/accel. Long electric transfers are flown
  as an analytic Edelbaum spiral leg (`Δv = √(v0²+v1²−2v0v1·cos(½π·Δi))`, semi-major
  axis linear, phase in closed form) — committed with Δv/propellant charged up front
  and exact at any time-warp, rather than an impractical months-long stepped burn.
  Five solar-electric + one VASIMR craft ship with the catalog.
  **Capture/escape spirals — DONE:** the analytic Edelbaum leg now takes the r→∞
  limit to spiral a single body's well — `spiralEscapeDv`/`spiralCaptureDv` (= the
  local circular speed, e.g. ~7.7 km/s to spiral off LEO, more than the impulsive
  `(√2−1)·v_circ` but cheap in propellant at electric Isp) and their
  `…Transfer` legs (Δv/time/propellant). The heliocentric spiral arrives matched
  (vInf ≈ 0), so the well-spiral is internally consistent: a rendezvous, not a
  braking burn. **Variable-Isp throttling — DONE:** `variableIspBurn` operates a
  constant-power drive at a chosen exhaust velocity (`F = 2ηP/vₑ`), making the
  thrust↔Isp↔time trade explicit (`exhaustForThrust`/`jetPower` helpers). Still to
  do: an *in-sim flyable* capture/escape spiral (the analytic leg lands first) and
  a time-optimal variable-Isp control law.
- **Parallel staging** / strap-on boosters / drop tanks (serial stages only now).
- **Gravity assists** — DONE: flyby physics (flyby.ts), a two-leg patched-conic
  assist solver (assist.ts), and in-sim execution (a flyby-pass that bends the
  heliocentric velocity for free and continues to the target), with a "via flyby"
  planner mode. **Multi-flyby chains — DONE:** `chainAssist` evaluates an arbitrary
  origin→fb₁→fb₂→…→target tour (e.g. V-E-E-G-A) for a fixed schedule — a Lambert arc
  per leg, the free-or-bridged flyby model at each interior body, and a full Δv
  ledger; it generalizes `assistTransfer` (the n=1 case, reproduced exactly).
  **Free-bend B-plane targeting — DONE (analytic):** `bPlaneAim` solves the
  hyperbola that rotates v∞_in into v∞_out's direction (e = 1/sin(δ/2), rp, impact
  parameter b, and the B-vector/plane-normal aim geometry); `impactParameter` gives
  b = rp·√((e+1)/(e−1)). Still to do: an in-sim *chained* executor (the executor
  flies one flyby today) and a B-plane-targeted in-sim pass (it uses a patched-conic
  point + charged residual), plus a planner-UI search over chain schedules.
- **Transfer toolkit** — DONE: plane-change Δv, bi-elliptic transfers, and
  multi-revolution Lambert (wired into the porkchop).
- **J2 oblateness** — DONE: secular nodal/apsidal precession of ship/station
  orbits about oblate bodies (orbit.ts j2Rates), applied analytically at read time
  (exact at any time-warp; golden-hash-neutral), with a sun-synchronous-inclination
  helper. Still to do: full N-body perturbations, J3+ harmonics, and J2 on the
  capture/aim geometry (the hyperbolic approach is still pure two-body).
- **Full B-plane targeting in the planner UI** — the analytic aim (`bPlaneAim`:
  free-bend hyperbola, impact parameter, B-vector) now exists; what remains is
  surfacing it in the planner UI and a B-plane-targeted in-sim pass (B-plane solved
  at execution today).
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
- **Interstellar sky / camera** (presentation) — the procedural backdrop starfield
  was removed; the nearby **real** star systems are now the only sky, drawn in their
  true direction from the Sun but on a *compressed* shell just beyond Neptune
  (documented rendering choice — distances/light-times in the engine stay exact).
  Still to do: a **to-scale interstellar camera mode** (true ~1e17 m placement with a
  frustum/LOD scheme that spans in-system to interstellar without z-fighting), and an
  optional faint deep-sky backdrop sourced from a **real** catalog (e.g. Hipparcos/Gaia
  bright stars) — explicitly *not* a re-introduced procedural/fake starfield.
- **Stellar proper motion** — DONE: the nearby-star catalog carries real Gaia /
  Hipparcos proper motion (μα\*, μδ in mas/yr) and radial velocity (km/s); each star
  derives an ecliptic-J2000 **space-velocity vector** at load and drifts linearly with
  time (`starState(star, t)` / `starPosition(star, t)` — exact straight-line inertial
  motion, read-time analytic, golden-hash-neutral since the catalog is static module
  data). Interstellar legs **lead the target** — they aim at the star's *arrival-time*
  position (a fixed brachistochrone line, recomputed deterministically from
  `targetStar` + `tArrive`, so no new serialized state), and `dispatchInterstellar`
  re-solves the flip-and-burn against that lead-aim distance for a consistent
  `(a, D, T)`. The star map renders the drift. Still to do: per-component binary
  *orbital* motion (only the system's bulk space motion is modelled today — a
  documented approximation, like the Pluto–Charon barycentre).
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
