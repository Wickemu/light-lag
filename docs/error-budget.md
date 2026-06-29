# LIGHTLAG — physics error budget

_How wrong the engine is, and where._

This is the quantitative companion to [`physics-audit.md`](physics-audit.md) and
[`physics-assessment.md`](physics-assessment.md). Those argue that the model is
internally consistent and honest; this one says, regime by regime, *how large the
residual error is and what causes it*. The numbers are harvested from the test
suite (the ephemeris cross-check tolerances, the chunk-invariance bounds) and the
model assumptions documented in the source — not estimated from outside.

LIGHTLAG is a **patched-conic / analytic-ephemeris / event-driven** engine, pure SI,
deterministic, and analytic at read time wherever possible. Its error profile is the
one that architecture implies: two-body motion is essentially exact, the leading
perturbation (secular J2) is modelled, and everything else — continuous third-body
gravity, short-period and higher-order gravity terms, a high-fidelity atmosphere — is
a controlled approximation or a deliberate omission (see
[`deliberate-omissions.md`](deliberate-omissions.md)).

> **Scope of validity:** the ephemeris uses JPL 1800–2050 linear elements, so every
> number below is for **contemporary (21st-century) epochs**. Far-future / ancient
> play degrades the ephemeris first (see "Validity window" in
> [`ROADMAP.md`](../ROADMAP.md)).

---

## At a glance — error by regime

| Regime | Dominant error source | Expected error scale | Notes |
|---|---|---|---|
| **LEO / Earth orbit** | J2 is *secular-only*; no short-period terms; constant-rate drag | Node/apsis precession to leading order; short-period oscillation (~km, orbit-periodic) not modelled | Sun-sync & nodal-regression rates are correct to first order |
| **Earth–Moon** | No continuous third-body (Sun) during coast; EMB-vs-Earth-centre handling | Kepler exact two-body; lunar/solar perturbation on high orbits omitted between SOI patches | EMB→true-centre shift *is* applied (~4–5 thousand km, corrected) |
| **Interplanetary transfer** | Analytic ephemeris; patched-conic SOI; no third-body mid-cruise | Planet position **inner ≤ 6–40 Mm, giants ≤ ~2.5–8 Gm** vs Horizons (2000–2025) | These are the test tolerances; see table below |
| **Giant-moon tours** | Two-body moon ephemerides; secular-only J2 on the parent | Moon position drifts over years; J2 *aim* is modelled at the giant | Parent oblateness handled in the moon-arrival aim and capture approach |
| **Low-thrust arcs** | Edelbaum analytic spiral, not an integrated trajectory | Δv/time/propellant are the optimal-spiral estimate; not a flown arc | Good planning fidelity; phase/eclipse/optimal-control omitted |
| **Aerocapture / entry** | Exponential atmosphere, ballistic (no lift), convective-only heating | Radiative shock-layer heating omitted **above ~11 km/s** | Sutton–Graves convective flux modelled; good for blunt capsules |
| **Powered flight (RK4)** | Numerical integration truncation | Different time-chunkings of one burn differ **~sub-metre to metres** | Analytic/impulsive quantities are *exactly* chunk-invariant |
| **Interstellar** | SR exact; gravity-as-proper-force is an approximation | Relativistic kinematics exact to f64; not general relativity | Light-lag, Doppler, dilation all modelled |

---

## Per-subsystem detail

### Ephemerides (`ephemeris.ts`, `constants.ts`)

Analytic JPL Standish linear-rate elements for planets; mean/precessing elements for
the Moon; fixed heliocentric conics for small bodies. Measured worst-case
heliocentric position error vs JPL Horizons (2000–2025), from the per-body
tolerances in `ephemeris.horizons.test.ts`:

| Body | Position tol (m) | ≈ |
|---|---|---|
| Mercury | 6e6 | ~6 thousand km |
| Venus | 2.5e7 | ~25 thousand km |
| Earth | 1.5e7 | ~15 thousand km |
| Mars | 4e7 | ~40 thousand km |
| Jupiter | 2.5e9 | ~2.5 million km |
| Saturn | 8e9 | ~8 million km |
| Uranus | 3e9 | ~3 million km |
| Neptune | 2.5e9 | ~2.5 million km |

Osculating velocity omits slow element drift: **< 0.5 % of speed** (the giants show
~0.3 %). Small-body and outer-moon two-body conics drift further over multi-year
spans. The outer-planet long-period (b, c, s, f) libration terms that would extend
validity past 1800–2050 are **deliberately deferred** (they trade in-window accuracy
for range — see ROADMAP "Validity window").

### Coasting propagation (`ships.ts` `coastElements`, `orbit.ts` `j2Rates`)

- **Kepler two-body: exact** (machine precision).
- **J2: secular only.** Nodal regression, apsidal precession, and the mean-anomaly
  rate are the standard first-order secular forms, referenced to the body's
  *equatorial* radius. Short-period J2 oscillations (orbit-periodic, ~km) and all
  higher zonals (J3, J4…) and tesserals are **not** modelled.
- **Atmospheric drag: constant-rate secular** (`Ship.drag`: a fixed ṅ → along-track
  + SMA decay). Exact at any time-warp by construction, but misses the decay
  *runaway* as perigee drops and has no space-weather (F10.7 / geomagnetic) handle.
- **No continuous third-body gravity during coast** — the Sun is not felt in Earth
  orbit, moons are not felt in a planet's SOI, except through explicit SOI patches
  and flyby mechanics.

### Powered flight (`sim.ts`, `math/integrators.ts`)

RK4 on a fixed 2 s absolute-time grid, with exact analytic event splitting at
Δv-target and tank-empty. Consequence for determinism:

- **Analytically advanced quantities** (propellant, delivered Δv, event times) are
  **exactly chunk-invariant** — `step(A)+step(B) ≡ step(A+B)`.
- **The RK4-integrated r, v are not exactly chunk-invariant**: different chunkings of
  an active burn differ by the RK4 local truncation error, **~sub-metre to metres**
  (documented in `serialize.ts` and `physics-audit.md §3.4`; the sim's own tests
  assert agreement only to <1e-3 m grid-aligned, <50 m for arbitrary chunkings). This
  is why `hashWorld` golden determinism is scoped to the analytic/impulsive regime.

### Relativity (`math/relativity.ts`, `propulsion.ts`, `comms.ts`)

- Special relativity is **exact to f64**: rapidity composition, the relativistic
  rocket equation, constant-proper-acceleration brachistochrone, time dilation,
  relativistic Doppler, and retarded-time signal propagation (the retarded-time solve
  converges to β≈0.99, per `comms.test.ts`).
- **Approximation:** gravity is treated as a proper-frame force passed through the SR
  transform — adequate for torchship play, but **not general relativity**.
- **Comms fixed-node assumption:** a command's light-arrival is solved once at
  emission against a control node treated as fixed during light-travel — an O(v/c)
  effect, **~0.13 s at Earth–Mars maximum range**.

### Atmospheric entry / aerocapture (`maneuver/entry.ts`)

Planar point-mass entry, zero lift (ballistic), exponential atmosphere, Sutton–Graves
convective stagnation heating, radiative-equilibrium wall temperature, integrated heat
load, deterministic bisection for the aerocapture corridor.

- **Radiative shock-layer heating is neglected** — material above ~11 km/s entry
  (Apollo lunar return, giant-planet probes) under-reports peak heating.
- No lift/bank modulation, no ablation/TPS recession, no parachutes, no density tables
  (single exponential scale height per body).

### Low-thrust (`maneuver/lowThrust.ts`)

Edelbaum's analytic optimal spiral (Δv = √(v0²+v1²−2v0v1·cos(½π·Δi))), with
capture/escape spirals as the r→∞ limit. This is a **planning estimate**, exact for
the idealised constant-thrust near-circular spiral — not an integrated arc. It omits
thrust-direction history, eclipse, power variation along the spiral, and optimal
control. (An *integrated* low-thrust mode is on the roadmap.)

---

## Determinism is a first-class invariant

Every error above is **deterministic** — a pure function of state and time. The
engine guarantees a fixed absolute-time grid, exact event splitting, deterministic
body/event ordering, stable 12-sig-fig serialization, and a golden-state hash
(`hashWorld`). Any future fidelity work must preserve these (see ROADMAP); the price
of the approximations here is bounded and reproducible, never random.

---

_Sources: `packages/engine/src/ephemeris.horizons.test.ts` (tolerances),
`serialize.ts` & `src/integration/sim.test.ts` (chunk-invariance bounds),
`orbit.ts` / `ships.ts` / `maneuver/entry.ts` / `maneuver/lowThrust.ts` /
`comms.ts` (model assumptions), and the two audit documents in this directory._
