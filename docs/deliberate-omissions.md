# LIGHTLAG — deliberate omissions, alternatives, and rejected approaches

_What the engine consciously does **not** model, the alternatives that were weighed,
and why the current choice was made._

This document is the standing record of **scope decisions**. It exists so that an
approximation is never mistaken for an oversight, and so a future contributor can see
that a given simplification was *chosen* — with its alternatives and trade-offs — not
missed. It complements three living documents and tries not to duplicate them:

- [`ROADMAP.md`](../ROADMAP.md) — the **live backlog** and "Consciously-deferred audit
  notes". Status (planned / deferred / done) lives there; *rationale* lives here.
- [`error-budget.md`](error-budget.md) — *how large* each residual error is.
- [`physics-audit.md`](physics-audit.md) / [`physics-assessment.md`](physics-assessment.md)
  — the correctness audits that surfaced most of these decisions.

Each entry: **the omission · the alternative(s) considered · the decision · why.**

Three standing principles drive most of these decisions and are referenced below by
name:

- **Determinism is load-bearing.** The engine guarantees a fixed absolute-time grid,
  exact event splitting, stable serialization, and a golden-state hash. Anything that
  introduces always-on numerical integration or non-reproducible state is weighed
  against that guarantee.
- **Analytic-at-read-time.** Coast and ephemeris are evaluated in closed form so the
  clock can jump to any time-warp without accumulating error. Models that *require*
  step-by-step integration cross that line and must be gated.
- **Era is the 21st century.** Gameplay lives in contemporary epochs, so fidelity is
  spent there rather than on far-future / ancient validity.

---

## 1. Gravity & perturbations

### Continuous third-body gravity during coast and burns
- **Considered:** an always-on N-body force on every ship (Sun felt in Earth orbit,
  moons felt inside a planet's SOI, etc.).
- **Decision:** omitted from the default model; captured only through patched-conic
  SOI transitions and explicit flyby mechanics. An **opt-in perturbed propagation
  mode** is on the roadmap, not the default.
- **Why:** always-on N-body defeats *analytic-at-read-time* and *determinism* — it
  forces numerical propagation for every ship at every warp. This is the single
  biggest realism gap and is acknowledged as such; the right shape is a gated,
  fixed-step, preview-first mode, not a rewrite of the coast kernel. (See ROADMAP
  "Higher-fidelity propagation".)

### Higher-order gravity (J3/J4, tesserals, mascons) and short-period J2
- **Considered:** numerical J2 acceleration on close arcs, then J3/J4 zonals and
  tesseral/sectoral harmonics, mascons for the Moon, irregular small-body fields.
- **Decision:** only **secular J2** is modelled (plus a single-pass J2 *perturbation*
  on the capture approach, which is already done). The rest is omitted.
- **Why:** secular J2 is the dominant perturbation and captures node/apsis drift to
  first order; the higher terms are diminishing returns for a strategy game and only
  matter for precision orbit determination, which is not a goal. Numerical J2 on
  integrated arcs is a plausible future step; full harmonics are **not worth it** at
  this altitude of play.

---

## 2. Ephemerides

### Outer-planet long-period (b, c, s, f) libration terms
- **Considered:** adding the JPL 3000 BC–3000 AD augmentation terms to the Standish
  elements (a one-line change in `standishElements` plus per-planet data).
- **Decision:** deferred.
- **Why:** the 3000 BC–3000 AD table trades *in-window* precision for date range, and
  the engine's era is the 21st century, where the 1800–2050 linear model is more
  accurate (confirmed vs Horizons). Worth revisiting only if far-future/ancient play
  is prioritized. (ROADMAP "Validity window".)

### SPICE/Horizons-grade ephemeris as the live model
- **Considered:** importing sampled SPICE/Horizons tables and interpolating
  (Chebyshev / VSOP87 / ELP2000).
- **Decision:** rejected as the always-on model; reasonable only as an *offline
  planning/preview* import.
- **Why:** a multi-megabyte data pipeline and interpolation state fight both
  *analytic-at-read-time* and serialization determinism for a precision gameplay
  doesn't require. The cheap, in-scope win (long-period terms above) is itself already
  deferred for era reasons.

---

## 3. Atmosphere, entry & surface

### Lifting entry, ablation, radiative heating, density tables
- **Considered:** tabulated per-body atmospheres, Mach/Reynolds/Knudsen drag
  coefficients, lift-to-drag and bank modulation, TPS ablation/recession, radiative
  shock-layer heating, parachutes/terminal-descent devices.
- **Decision:** omitted; entry is planar, ballistic (zero lift), single exponential
  scale height, convective-only (Sutton–Graves) heating.
- **Why:** this is sufficient for blunt-capsule / aerocapture gameplay, which is the
  use case. Radiative heating is explicitly flagged as the first thing to add if
  high-speed (Apollo-return, giant-planet-probe) entries become important; the rest is
  a large subsystem for a regime the game doesn't centre on.

### Terrain, non-spherical body shape, collision/landing dynamics
- **Considered:** elevation maps / procedural relief, non-spherical collision,
  body-rotating atmosphere with surface-relative wind, landing-gear/crash dynamics,
  plume impingement.
- **Decision:** omitted; surface impact during coast is modelled (analytic
  surface-crossing → wreck), landed states co-rotate with the body.
- **Why:** only matters if surface operations become a real game mode. The current
  point-mass-on-a-sphere model is a deliberate abstraction adequate for impact loss
  and co-rotating touchdown.

---

## 4. Propulsion, attitude & control

### Attitude / pointing / control constraints
- **Considered:** an orientation quaternion, slew rate, gimbal limits, throttle range,
  restart counts, minimum impulse bit, ignition/shutdown transients, ullage/settling,
  ACS propellant, moment of inertia, engine cant.
- **Decision:** omitted; a burn is steered instantly in instantaneous orbital-frame
  directions (prograde/retrograde/radial/normal…).
- **Why:** the full guidance-and-attitude layer is an enormous surface area that
  changes the control paradigm (burns become guidance objectives) and is largely
  invisible to a strategy player. **Not worth it** unless the game pivots toward a
  flight-sim feel. The honest finite-burn energetics and event splitting are modelled;
  the *pointing* idealisation is the conscious cut.

### Integrated (flown) low-thrust arcs
- **Considered:** flying electric transfers as months-long stepped RK4 burns with
  power-limited throttle and a guidance law.
- **Decision:** electric transfers are flown as an **analytic Edelbaum spiral** leg
  (exact Δv/time/propellant, charged up front), not an integrated arc — for now.
- **Why:** a stepped multi-month burn is impractical at gameplay time-warp; the
  Edelbaum analytic leg is exact at any warp and is good planning fidelity. An *opt-in
  integrated* low-thrust mode (reusing the existing RK4 powered integrator) is a
  bounded, worthwhile roadmap item — the planning model is deliberately first.

### Drop-tank cross-feed
- **Considered:** a no-engine reservoir feeding the core engine (Falcon-Heavy-style
  crossfeed).
- **Decision:** omitted; such a tank is folded into its core stage, and crossfeed
  vehicles are modelled at their no-crossfeed performance.
- **Why:** a scope cut documented at the catalog level (e.g. Falcon Heavy at ~45 t,
  not its crossfeed-assumed 63.8 t). Tracked in the ROADMAP staging backlog.

---

## 5. Relativity & comms

### General relativity / rigorous relativistic gravity
- **Considered:** GR, gravitational time dilation, light aberration, relativistic
  collision energy/momentum.
- **Decision:** omitted; special relativity is exact, but gravity is treated as a
  proper-frame force passed through the SR transform.
- **Why:** SR is what torchship play needs and it is implemented exactly (rapidity
  composition, dilation, Doppler, retarded-time signalling). GR is a research project
  with ~zero gameplay payoff. Light *aberration* of apparent position remains a small
  open completeness candidate (distinct from the modelled Doppler).

### Comms: fixed control node during light-travel; arrival solved once
- **Considered:** re-solving a command's light-arrival as the ship's path is later
  mutated, and treating the control node as moving during propagation.
- **Decision:** the arrival time is solved once at emission against a node treated as
  fixed during light-travel.
- **Why:** both are O(v/c) effects — ~0.13 s at Earth–Mars maximum range, and
  sub-millisecond firing-instant drift at in-system speeds — and the burn still
  executes against the ship's real live state at delivery, so only timing (never the
  physics or Δv) is slightly stale. Judged non-blocking in the audit.

---

## 6. Numerics & determinism

### RK4 thrust-path is not bit-chunk-invariant (and the golden hash excludes it)
- **Considered:** forcing `step(A)+step(B) ≡ step(A+B)` for the integrated r, v of an
  active burn.
- **Decision:** accepted as a bounded approximation; the golden-state hash is scoped
  to the analytic/impulsive regime.
- **Why:** RK4 local truncation makes different chunkings of a burn differ by
  ~sub-metre to metres — physically legitimate, not a bug. The analytically advanced
  quantities (propellant, Δv, event times) *are* exactly chunk-invariant, which is
  what a deterministic hash oracle needs. (Refuted as a defect in `physics-audit.md
  §6`; bounds in `error-budget.md`.)

### Equal-time event tie-break = insertion order
- **Decision:** simultaneous events break ties by insertion order.
- **Why:** deterministic for the current schedulers. Worth revisiting only if
  simultaneous cross-ship events become common.

---

## How to use this document

When you add a feature that *closes* one of these gaps, move the rationale here to
past tense and link the ROADMAP "Done" note. When you make a **new** scope cut, add an
entry here in the same shape (omission · alternatives · decision · why) — a deliberate
omission recorded is a future misunderstanding prevented.
