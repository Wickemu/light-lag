# LIGHTLAG Physics Engine Audit

_Date: 2026-06-29_

## Scope

This audit reviews the core physics stack around:

- simulation stepping and event handling (`Simulation.step`, finite burns, impacts, light-lag events),
- coasting/orbital propagation,
- propulsion and staging,
- finite-thrust and relativistic handling,
- patched-conic/SOI behavior,
- atmospheric entry/aerocapture,
- body ephemerides,
- thermal/detection side mechanics.

## Bottom line

The implementation is unusually strong for a browser/game physics engine. The core choices are internally consistent, deterministic, and mostly honest about where they are approximations. The most important “real physics” pieces—Kepler propagation, Tsiolkovsky mass bookkeeping, finite-thrust RK4 integration, event splitting at tank-empty / target-Δv, light-time command delivery, J2 secular effects, entry heating, Oberth-aware burns, and patched-conic SOI transitions—are present and generally implemented in the right conceptual direction.

The biggest caveat is that this is not a full N-body flight dynamics simulator. It is a patched-conic / analytic-ephemeris / event-driven game engine, and the clearest realism gaps are exactly the ones implied by that architecture: no continuous third-body gravity during most coasts or burns, no numerical N-body propagation for ships, simplified atmosphere and entry, simplified launch/descent profiles, simplified attitude/pointing/throttle constraints, and approximate ephemerides for outer planets / moons / small bodies.

---

## A. Is what is implemented so far correct?

### 1. Simulation stepping and determinism

The simulation architecture is well designed. It explicitly separates two regimes:

- **Coast:** analytic evaluation of bodies and ship conics, so the clock can jump without accumulating numerical error.
- **Powered flight:** fixed-grid substepping with RK4 and exact splitting at burn events.

The main stepping loop also does the right high-level thing: it advances to the next event or fixed thrust grid boundary, integrates thrusting ships only when needed, and checks impacts during analytic coast.

**Assessment:** correct and robust for a deterministic game sim. The event-bounded loop is a good choice because it prevents command arrivals, captures, impacts, or burn completions from being skipped by time warp.

**Small concern:** `step()` credits ship proper time for the whole interval before processing events, then finite burns refund dilation segment-by-segment. That is documented and likely passes because all event splits happen inside the same enclosing interval, but it is conceptually fragile if future mechanics change `tau` at events.

### 2. Coasting orbital propagation

Coasting ships use Kepler propagation, plus optional J2 secular precession and a simple secular atmospheric drag term.

That is a reasonable “rung 1.5” model:

- Kepler propagation is exact for two-body motion.
- J2 secular rates are a physically meaningful leading perturbation.
- Constant-rate drag decay is not a high-fidelity atmospheric model, but it is a controlled approximation.

The J2 formulas are the standard nodal/periapsis/anomaly secular-rate shape, using the equatorial reference radius.

**Assessment:** correct for patched-conic, long-term visual/gameplay behavior. It is not correct for high-fidelity orbit determination because J2 is only secular, atmospheric drag is not density/attitude/solar-cycle dependent, and third-body effects are absent from ship coast propagation.

### 3. Finite-thrust integration

Finite thrust uses RK4, not Euler, with a 2-second max powered step. Inside `advanceThrustShip`, burns are integrated in a primary-centered frame and explicitly documented as patched-conic/inertial.

The derivative includes:

- central inverse-square gravity,
- thrust in a local orbital frame,
- current mass from carried dry/payload/upper stages plus remaining propellant,
- propellant depletion,
- special-relativistic acceleration conversion.

The burn solver analytically determines when a requested Δv target is reached or a tank empties, then shortens the numerical integration segment to hit that event.

**Assessment:** this is the right structure. It avoids the most common burn-sim mistakes: overshooting Δv, burning phantom propellant, and losing determinism across save/load or different time chunking.

**Important limitation:** the burn is steered only in instantaneous orbital-frame directions: prograde, retrograde, radial, normal, etc. That is fine for manual/game controls but not enough to represent real closed-loop guidance laws, finite-burn targeting, attitude slew, thrust-vector limits, gravity-turn control, or low-thrust optimal control.

### 4. Propulsion and mass bookkeeping

The propulsion model is broadly correct.

The base rocket-equation functions are textbook:

- `v_e = Isp * g0`,
- mass flow `ṁ = F / v_e`,
- Tsiolkovsky `Δv = v_e ln(m0/mf)`,
- propellant needed and Δv delivered functions.

Electric propulsion correctly models power-limited thrust as `F = 2ηP / v_e`, with solar power falling as inverse-square distance and capped closer than 1 AU.

Parallel boosters are modeled as independent burning reservoirs with aggregated counts, individual thrust/Isp/mass, concurrent burn, and drop on depletion. Impulsive Δv first checks affordability, then consumes propellant using the same stage/booster model as the budget.

**Assessment:** very good. The code avoids a lot of common rocket-game errors, especially around booster effective Isp and staging.

**Potential correctness issue to inspect later:** the thermal model’s drive waste heat uses nominal active-stage thrust/Isp, not necessarily actual derated solar-electric thrust or live booster contributions. That is not core trajectory physics, but it is a “ship mechanics” inconsistency.

### 5. Relativistic treatment

The code has an explicit special-relativistic conversion from proper-frame specific force to coordinate acceleration. It decomposes acceleration parallel/perpendicular to velocity and suppresses by γ³/γ², which is the right conceptual transform for proper acceleration.

The finite burn comments also correctly identify `burn.dvDone` / `dvTarget` as rapidity-like accumulated Δv, and cap rapidity per segment to limit frozen-γ error.

**Assessment:** impressive for a game engine, and likely adequate for torchship-style play.

**Caveat:** gravity is treated as a proper-frame force and then passed through the same SR transform. The code acknowledges this approximation. This is acceptable for this architecture, but it is not general relativity and not a rigorous relativistic gravity model.

### 6. Ephemerides and natural bodies

The ephemeris is analytic, using JPL Standish linear-rate elements for planets, mean/precessing moon elements, and fixed heliocentric elements for small bodies.

It correctly uses parent-plus-body μ for relative two-body state, which matters for systems like Earth–Moon. It also accounts for barycenter rows for systems like Earth–Moon and Pluto–Charon by shifting from barycenter to true body center.

**Assessment:** good for a deterministic strategy game. The diagnostic tests show noticeable outer-planet and small-body drift versus Horizons over long spans, so this is not high-precision ephemeris. The code itself documents the 1800–2050 linear-element range and approximate nature.

### 7. Patched conics and SOI model

The engine uses Laplace sphere of influence radius.

The SOI/patched-conic approximation is a standard game/simplified mission-design method. It is not “full reality,” but within the chosen method it is coherent.

**Assessment:** correct as patched conics. The tests include SOI continuity and end-to-end transfer/capture determinism, and the test suite passed during this audit.

### 8. Atmospheric entry and aerocapture

The entry module is physically thoughtful:

- planar point-mass entry equations,
- zero lift / ballistic trajectory,
- exponential atmosphere,
- Sutton–Graves convective heating,
- heat load,
- wall-temperature estimate,
- peak deceleration,
- deterministic bisection for aerocapture targeting.

The equations documented are the classic ballistic-entry point-mass set. The code explicitly documents that radiative shock-layer heating is neglected and notes the high-speed regimes where that matters.

**Assessment:** very good for blunt ballistic capsule / aerocapture gameplay. Not sufficient for lifting entry, bank modulation, skip guidance, ablation, parachutes, supersonic retropropulsion, or high-speed giant-planet entries.

---

## B. Clear omissions if the goal is “as close to reality as this method can get”

### Priority 1 — Continuous third-body perturbations for ships

Right now, ships mostly coast as two-body conics around a selected primary, with SOI switches. During powered flight, the integrator uses only central gravity from the current primary.

That means the ship does not continuously feel:

- the Sun while orbiting Earth/Moon,
- moons while in a planet’s SOI,
- Jupiter while near Saturn transfer except at patched events,
- lunar/solar perturbations on high Earth orbits,
- resonant moon effects except through explicit flyby mechanics.

**Recommendation:** add an optional “perturbed propagation” layer:

- central body + selected third-body accelerations,
- maybe only for high-fidelity modes, close approaches, and long coasts,
- preserve deterministic chunking by using fixed-step integration or analytic correction splines.

This is the single biggest physical gap versus reality.

### Priority 2 — More faithful ephemerides

The current analytic ephemeris is efficient and deterministic, but the diagnostic output shows outer-planet and small-body errors that can grow to millions of kilometers over contemporary dates.

**Recommendation options:**

1. **Short-term:** add the long-period correction terms for outer planets from the JPL approximate-position model.
2. **Medium-term:** add VSOP87/ELP2000-style series or compact Chebyshev tables.
3. **High-fidelity mode:** allow importing sampled SPICE/Horizons ephemeris tables and interpolate.

For gameplay, the current model is fine; for “as close to reality as possible,” ephemeris fidelity becomes a hard ceiling.

### Priority 3 — Non-spherical gravity beyond secular J2

The existing J2 handling is a good first-order secular model. But real low orbit dynamics include:

- short-period J2 terms,
- higher zonals: J3, J4, etc.,
- tesseral/sectoral gravity harmonics,
- body-fixed gravity-field rotation,
- mascons for the Moon,
- irregular fields for small bodies.

**Recommendation:** add:

- optional numerical J2 acceleration during integrated arcs,
- then J3/J4 or low-order gravity harmonics for Earth/Moon/Mars,
- at minimum, distinguish secular J2 coasting from true J2-accelerated close-approach arcs.

The code already has a J2-perturbed approach leg concept, so this would fit the existing architecture.

### Priority 4 — Better atmosphere and drag

The atmosphere/entry model is intentionally simplified:

- exponential atmosphere,
- ballistic point mass,
- no winds,
- no lift,
- no density tables,
- no temperature/speed-of-sound profile,
- no ablation,
- convective-only heating.

**Recommendation:** add layers:

1. tabulated atmosphere per body,
2. drag coefficient as Mach/Reynolds/Knudsen function,
3. lift-to-drag and bank angle,
4. ablation / TPS mass-loss,
5. radiative heating at high speed,
6. parachutes / terminal descent devices.

This matters for Earth return, Mars EDL, Venus entry, and gas-giant probes.

### Priority 5 — Attitude, pointing, and control constraints

The burn model assumes the commanded direction is available instantly in the local orbital frame.

Missing realities:

- attitude state,
- slew rate,
- gimbal limits,
- throttle range,
- engine restart limits,
- minimum impulse bit,
- finite ignition/shutdown transients,
- ullage / settled propellant,
- attitude-control propellant,
- torque and moment of inertia,
- engine cant angles and off-axis thrust.

**Recommendation:** add an optional “guidance and attitude” layer:

- ship orientation quaternion,
- max slew rate,
- thrust direction constrained by attitude and gimbal,
- burn commands become guidance objectives rather than instantaneous vector selection.

This is especially important for long low-thrust arcs and realistic launch/ascent.

### Priority 6 — Finite-size body and collision / terrain modeling

Surface impact during coast is considered, and landed states rotate with the body.

Missing:

- terrain elevation,
- non-spherical body shape,
- atmosphere rotating with body,
- surface-relative wind,
- local gravity variation,
- landing gear / crash dynamics,
- plume impingement or touchdown constraints.

**Recommendation:** add at least body elevation maps or procedural relief for landing/collision if surface operations matter.

### Priority 7 — Low-thrust trajectory fidelity

The low-thrust spiral model analytically grows semi-major axis linearly and assumes circular near-circular evolution.

That is acceptable for a visual/strategic low-thrust transfer, but true low-thrust dynamics depend on thrust direction, mass depletion, changing gravity, perturbations, eclipse, power, and optimal control.

**Recommendation:** for electric ships, add a second mode:

- real integrated low-thrust arcs using the same RK4 powered integrator,
- throttle limited by solar power,
- guidance law options: tangential spiral, Edelbaum plane change, target-state feedback, or direct collocation/precomputed trajectory.

### Priority 8 — Launch/ascent and descent are budget/spline approximations

Launch and descent are represented by precomputed splines and pinned end states.

That is a good game abstraction, but it is not a true 6-DOF or even full 3-DOF ascent simulation. Missing:

- gravity turn guidance,
- max-Q throttle,
- aerodynamic lift/drag during ascent,
- staging dynamics through atmosphere,
- launch latitude/azimuth constraints,
- range safety / downrange footprint,
- engine-out or TWR limits beyond coarse budget,
- ascent losses computed dynamically from actual profile.

**Recommendation:** if launch realism is important, replace or supplement the spline with a planar/3D ascent integrator using atmosphere, drag, thrust, mass, pitch program, and constraints.

### Priority 9 — Thermal and detection consistency

The thermal model is physically motivated: absorbed sunlight + housekeeping, reflected sunlight, and drive waste heat.

But as noted, the drive waste calculation appears to use nominal active-stage thrust/Isp instead of actual `thrustAt()` after solar-electric derating and does not include live boosters.

**Recommendation:** compute thermal drive power from the same live engine/reservoir set used by the actual thrust integrator.

Also consider:

- radiator orientation and view factor,
- transient heat capacity,
- waste heat from reactors even while coasting,
- plume radiation/scattering,
- optical phase angle for reflected sunlight,
- sensor wavelength bands and background variation.

---

## C. General suggestions for improving the engine

### 1. Make fidelity modes explicit

The code already contains multiple fidelity levels: analytic Kepler, J2 secular, J2 approach splines, RK4 powered flight, entry integration, patched conics.

Recommended modes:

- **Game/default:** current deterministic patched-conic model.
- **Perturbed:** central + third-body + J2 numerical propagation for selected arcs.
- **High-fidelity planning:** slower, more accurate propagation for preview/analysis, not necessarily always-on.

This would preserve the game’s responsiveness while allowing reality checks.

### 2. Add error-budget documentation

Add or update developer/user documentation that states:

- what is modeled,
- what is approximated,
- what is intentionally omitted,
- expected error scale by regime:
  - LEO,
  - Earth–Moon,
  - interplanetary transfer,
  - giant-planet moon tours,
  - low-thrust arcs,
  - aerocapture,
  - interstellar.

### 3. Add validation cases against known missions

The tests are extensive and passed, but the next realism step would be mission benchmark tests:

- Apollo TLI / LOI approximate Δv and flight time,
- Mars Hohmann windows against known porkchop values,
- Voyager/Juno/Cassini-style gravity assist geometry,
- ISS J2 nodal precession,
- sun-synchronous inclination,
- Apollo lunar-return entry heat/decel envelope,
- Dawn ion-thrust order-of-magnitude spiral performance.

These would make the “physics true” claim stronger.

### 4. Keep determinism as a first-class invariant

The current suite clearly values chunk invariance, serialization stability, and golden hashes. Any new physics—especially third-body numerical propagation—should preserve:

- fixed absolute-time grid,
- event splitting,
- deterministic body ordering,
- stable serialization,
- no dependence on render-frame chunking.

### 5. Unify “actual live thrust” calculations

Actual thrust appears in several places:

- finite-burn integration,
- propulsion budget,
- thermal state,
- launch budget,
- UI/catalog readouts.

The risk is drift between these. The propulsion module should expose a single “live engine set” / “current thrust and mdot” function reused everywhere.

---

## Specific potential follow-up tickets

### High priority

1. Add third-body acceleration option for ship propagation.
2. Improve ephemeris fidelity or clearly bound validity.
3. Make low-thrust arcs physically integrated when desired.
4. Fix/align thermal drive waste with actual thrust source.

### Medium priority

5. Add real attitude/pointing constraints.
6. Add higher-fidelity atmosphere / lift / radiative heating.
7. Add numerical J2 acceleration and short-period terms for close orbits.
8. Add a more physical launch/ascent integrator.

### Lower priority / polish

9. Add finite burn ignition/shutdown transient modeling.
10. Add throttle ranges and restart counts.
11. Add propellant boiloff, pressurization, residuals, ullage, and mixture-ratio constraints.
12. Add landing terrain/elevation and non-spherical body collision.
13. Add eclipse/shadow modeling for solar-electric power.
14. Add reactor waste heat when not thrusting for nuclear-electric craft.

---

## Audit commands and checks

Commands used during the audit included source inspection with `rg`, `find`, `sed`, and `nl`, plus the project test suite.

Testing performed:

- `npm test -- --runInBand` failed because Vitest does not recognize Jest’s `--runInBand` option.
- `npm test` passed: 60 test files passed, 691 tests passed.
