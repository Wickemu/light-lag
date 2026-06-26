# Deep Physics Audit — `light-lag`

## 1. Scope & Methodology

This is a read-only, source-level physics audit of the `light-lag` simulation core. Coverage spans the classical/Newtonian propulsion and integration layer, two-body orbital mechanics and ephemeris, maneuver/transfer planning (Lambert, Hohmann, bi-elliptic, flyby/assist, low-thrust), the special-relativistic and light-lag subsystems, and cross-cutting integration concerns (frame conventions, conservation invariants, SOI patch continuity, determinism/serialization). Verification methodology is independent adversarial re-derivation of each formula from first principles, cross-checked against external authoritative references (Vallado, Curtis, JPL/JUNO published constants, John Baez's relativistic-rocket treatment, standard numerical-analysis results), plus targeted numerical reproduction where a claim hinged on convergence or round-trip precision. Every finding reported below was confirmed against the actual source and an external citation; refuted candidates are listed in an appendix so the reader sees what was examined and cleared. No code was modified.

## 2. Executive Summary

Per-domain verdicts:

- **Classical / Newtonian — Accurate.** The classical core is algebraically sound and dimensionally consistent throughout: RK4 is a textbook-exact 4th-order step, the powered-flight derivative correctly assembles F=ma with attractive gravity and steered thrust, analytic event-split times are exact inverses of the segment Tsiolkovsky law, and all propulsion formulas (ve=Isp·g0, mdot, Tsiolkovsky and inverses, staged Δv, electric F=2ηP/ve, solar 1/r², relativistic constant-proper-acceleration forms) are correct. Only minor edge-case/gap items remain.
- **Orbital mechanics — Accurate.** The two-body core is algebraically sound and numerically excellent: the perifocal-to-inertial rotation is correct entry-by-entry, both Kepler solvers converge to machine precision, coe2rv/rv2coe round-trips to ~1e-9 m across all singular branches, and J2 secular rates, sun-sync inclination, and JPL constants all check out. One minor data-currency item (Jupiter J2).
- **Maneuver / transfer — Accurate.** The transfer core matches first-principles orbital mechanics throughout (universal-variable Lambert vs Curtis 5.2, Hohmann, bi-elliptic, vis-viva/Oberth, Edelbaum, flyby vector math, Oberth-aware capture). No genuine defects in formulas, signs, units, or domain handling. This domain audited clean — zero surviving findings.
- **Relativistic & light-lag — Accurate.** SR and light-lag are derived correctly throughout (rapidity convention, relativistic rocket equation, hyperbolic-motion brachistochrone, symmetric flip-and-burn reconstructions, light-cone fixed points). Named GR/Doppler/aberration omissions are documented out-of-scope. One minor robustness gap (comms convergence at relativistic speed).
- **Cross-cutting / integration — Issues found.** Frame conventions, conservation invariants, and SOI patch continuity are physically sound and internally consistent, and the tested invariants genuinely pin the physics they claim. The defects found are a documentation inconsistency about thrust-path determinism and two coverage gaps for already-correct physics paths.

**Surviving findings by severity:** 0 blocker · 0 major · 5 minor · 0 nit. (Two candidates were initially proposed as major — the comms convergence gap and the hyperbolic round-trip gap — but adversarial verification downgraded both to minor: the comms case impacts only display/timing readouts and is partly documented, and the hyperbolic path is already correct and indirectly covered by integration tests.)

**Headline takeaways:** The physics engine is in excellent shape. There are no correctness defects in any core formula — every surviving item is either an undocumented modeling assumption, a stale-but-attested constant, an internal documentation overstatement, or a test-coverage hardening opportunity. The single behavioral bug (electric thrust not derated in impulsive burns) corrupts only burn *duration*/finite-burn trajectory, not propellant or delivered Δv, and is reachable only by an off-nominal command path.

## 3. Findings

| ID | Severity | Category | Location | Claim | Correct result | Source(s) |
|----|----------|----------|----------|-------|----------------|-----------|
| electric-thrust-not-derated-in-burn | minor | gap | `src/core/sim.ts:186` | `advanceThrustShip` uses rated `stage.thrust` for an impulsive burn, ignoring the 1/r² solar-electric power derating that `thrustAt()` models. | Use `thrustAt(stage, r_helio)` (per smooth segment) for mdot/tauCut/accel, or gate impulsive burns to non-electric stages and document it. Propellant/Δv stay correct (thrust cancels); burn duration & finite-burn gravity losses are wrong by the derating factor (~9× at 3 AU). | ESA ACT low-thrust-to-circumsolar (F ∝ P ∝ 1/R²); NASA JPL solar-power-in-space; `propulsion.ts:65-84` vs `sim.ts:186` |
| jupiter-j2-value | minor | imprecise | `src/core/constants.ts:208` | Jupiter J2 = 0.014736 (Voyager-era) vs modern Juno-measured 0.0146965; 0.27% high. | J2 = 0.0146965 (14696.514e-6, Iess et al. 2018). Propagates linearly into Jovian-moon nodal/apsidal precession via `j2Rates`. | Iess et al. 2018, Nature 555:220; Juno gravity-moments table; Campbell & Synnott 1985 (legacy value) |
| comms-relativistic-convergence | minor | gap | `src/core/comms.ts:29-52` | `signalArrival`/`retardedTime` fixed-point iterations contract at factor ~v/c; at relativistic v they don't reach 1e-3 s within the 64-iteration cap and silently return the unconverged value. | Document as in-system-only (v≪c) or use an accelerated/closed-form relativistic solve. Affects display/telemetry timing for interstellar torch ships (error ~days), not core orbital state. | John Baez, "The Relativistic Rocket" (UC Riverside); Banach contraction-mapping convergence (Burden & Faires); independent numerical reproduction |
| thrust-determinism-comment | minor | imprecise | `src/core/sim.ts:13-18` | Header claims step(A)+step(B)==step(A+B) in the THRUST regime, contradicting `serialize.ts:17-23` which correctly scopes chunk-invariance to the analytic/impulsive regime. | Scope the equality to the analytic/impulsive regime. The absolute-time grid only *caps* the RK4 substep; it does not re-align the partition, so integrated r,v differ by RK4 truncation (~sub-metre to metres). Propellant/Δv/event times *are* exactly chunk-invariant. | Numerical Recipes 3e §17.2 (step doubling); Hairer/Nørsett/Wanner ODE I, Ch. II.4 (O(h⁵) local error); RK4 (Wikipedia); source under audit |
| hyperbolic-coe2rv-untested | minor | gap | `src/core/math/kepler.test.ts:41-70` | No test round-trips a hyperbolic orbit (e>1, a<0) through elementsToState→stateToElements, though that path runs at every interplanetary capture/flyby. | Add hyperbolic round-trip cases (e.g. e=1.2, e=3.0, a<0) asserting a,e,i,Ω,ω,M recovery. Code is correct (machine-precision round-trip); this is test-coverage hardening, already indirectly covered by integration tests B2b/B3. | orbital-mechanics.space hyperbolic trajectories (Eqs. 233/234); Vallado Alg. 9/10; Curtis Eqs. 3.40/3.44b; independent numerical round-trip (~1e-15) |

**Resolution (this branch).** All five findings are addressed in the commits that accompany this report: electric-thrust derating (`advanceThrustShip` now evaluates `thrustAt(stage, r_helio)` per segment, a no-op for chemical stages, with a regression test at 3 AU); Jupiter J2 updated to the Juno value `0.0146965`; the `sim.ts` determinism comment scoped to match `serialize.ts`; a hyperbolic coe2rv round-trip test added to `kepler.test.ts`; and the **comms relativistic-convergence** gap closed — `signalArrival`/`retardedTime` now bracket the light-cone root and close it with an Illinois (regula-falsi) iteration that converges superlinearly at any sub-c speed (instead of the old fixed-point loop that contracted only at rate β and stalled for a ship in transit), with `signalArrival` returning `Infinity` when a target is unreachable within the contact horizon. Verified against the exact closed forms `x0/(c−v)` and `(c·t−x0)/(c+v)` at β up to 0.99.

### 3.1 electric-thrust-not-derated-in-burn (minor, gap)

`sim.ts:186-187` reads `const thrust = stage.thrust; const mdot = thrust / ve;` and uses this rated value throughout `advanceThrustShip` — the analytic `tauCut` (line 205), the acceleration `at = thrust/m` (line 232), and propMass flow (line 248). It never calls `thrustAt()` or `availablePowerW()`. `propulsion.ts:80-84` defines `thrustAt(stage, r)` which, for an electric stage, returns `min(rated, electricThrust(availablePowerW(src, r), ve, eta))` with solar `availablePowerW ∝ (AU/r)²` — exactly the 1/r² derating.

The impulsive integrator *is* reachable by an electric stage. The burn-command chain is `sendBurn` (commands.ts:83) → `sim.sendCommand({type:'burn'})` → `applyBurn` (sim.ts:354) → mode='thrust' → `advanceThrustShip` (sim.ts:174). None of `sendBurn`, `sendCommand`, or `applyBurn` checks `stage.electric`; the UI `execute()` (shipPanel.ts:381-387) likewise has no electric guard. By contrast the dedicated spiral path is correctly gated and derated: `planSpiral` (commands.ts:239-255) requires `stage.electric` and computes `thrust = thrustAt(stage, rHelio)`. So `thrustAt` is used everywhere except the impulsive integrator — an inconsistency, not a deliberate scope split.

Physics: electric thrusters are power-limited, F = 2ηP/v_e, and a solar array's electrical power scales with solar flux ∝ 1/r², so F(r) = 2η·P_1AU·(AU/r)²/v_e, capped near the Sun where the PPU regulates. In the rocket equation the delivered Δv and propellant for a Δv target are mass-ratio quantities (m0·(1−e^{−Δv/ve})) and are **thrust-independent** — the thrust factor cancels between mdot and seg in dvDone = ve·ln(m0/(m0−mdot·seg)). So the burn's energetics/propellant bookkeeping remain correct. What *is* corrupted is the burn **duration**, tauCut = (m0/mdot)(1−e^{−dvRem/ve}) ∝ 1/thrust. Using rated instead of derated thrust shortens an electric burn by the derating factor (~9× at 3 AU per the code's own Dawn test), understating finite-burn gravity losses and giving a wrong mid-burn trajectory/timing. Applying full rated thrust at 3 AU is also physically impossible for a solar-electric stage. The `advanceThrustShip` docstring (sim.ts:163-172) never states a chemical-only assumption, so the gap is real and undocumented.

**Refined expected:** In `advanceThrustShip` the burn thrust used for mdot, tauCut, and acceleration should be the distance-derated `thrustAt(stage, r_helio)` — for solar-electric, F = 2η·P_1AU·(AU/r)²/v_e capped at rated — evaluated per smooth RK4 segment (heliocentric radius, distinct from the primary-centred r used for gravity). Alternatively, impulsive burns should be explicitly restricted to non-electric stages with a guard in `applyBurn`/`sendBurn` and a documented assumption. As-is, propellant and delivered Δv are still correct (thrust cancels), but burn duration and finite-burn gravity losses / trajectory are wrong by the derating factor.

### 3.2 jupiter-j2-value (minor, imprecise)

`constants.ts:208` sets Jupiter J2 = 0.014736. The value 14736e-6 is the Voyager-era figure (Campbell & Synnott 1985, from 1979 flyby data, referenced to R_eq = 71398 km). The modern Juno value is J2 = 14696.514e-6 = 0.0146965 (Iess et al. 2018). Relative error: (0.014736 − 0.0146965)/0.0146965 = 2.69e-3.

`j2Rates` (orbit.ts:77-85) computes nodeDot = −1.5·f·cos i and periDot = 0.75·f·(5cos²i−1) where the prefactor f is strictly linear in J2, so a 0.27% error in J2 produces a 0.27% error in the secular nodal/apsidal precession of any Jovian moon orbit using this constant. By comparison Jupiter's μ relative error is ~8e-9, making J2 the least accurate of the audited constants (~5–6 orders of magnitude worse than μ). Both values are literature-attested, so physical impact is minor, but there is no code comment marking the legacy value as an intentional scope choice — this is genuine data-currency staleness.

Secondary observation (not part of the finding): J2 is conventionally referenced to Jupiter's equatorial radius (~71492 km Juno), but `j2Rates` is fed the body's mean radius field 6.9911e7 m. That is a separate, smaller modeling inconsistency.

**Refined expected:** Jupiter J2 = 0.0146965 (14696.514e-6, Iess et al. 2018) rather than the Voyager-era 0.014736. The ~0.27% discrepancy propagates linearly into Jovian-moon nodal/apsidal precession via `j2Rates`. (Independently, J2 is referenced to Jupiter's equatorial radius ~71492 km, not the 69911 km mean radius the code passes in — a separate minor point.)

### 3.3 comms-relativistic-convergence (minor, gap)

`comms.ts:29-52`: `signalArrival` iterates t_{n+1}=tEmit+|posFn(t_n)−fromPos|/c (line 32) and `retardedTime` iterates tRet_{n+1}=t−|posFn(tRet_n)−obsPos|/c (line 47), both with a fixed 64-iteration cap, a 1e-3 s tolerance, and a fall-through `return t`/`return tRet` (lines 36/51) yielding the last unconverged value with no error flag.

The map for `retardedTime` is g(tRet)=t−|posFn(tRet)−obs|/c with derivative g'(tRet) = −(v_radial)/c. Banach fixed-point convergence requires |g'|<1, and the per-step error multiplies by |g'|=β_radial. After 64 steps the error is β^64 times the initial error; for a target receding near c, β≈1 and the contraction is negligible. Numerical reproduction (1-D radial recession): β=0.5 barely converges (~35 iters); β=0.9 does not converge in 64 (err ~1.8e4 s); β=0.95 fails (~6.7 d); β=0.99 fails (~95 d). A 1g torch ship at the midpoint of a 4.2 ly leg (β=0.949) returns tRet off by ~1.12e6 s ≈ 13 days.

These speeds are real and reached. `ships.ts:74-75` (`interstellarLegState`) uses the exact relativistic-rocket velocity v=at/√(1+(at/c)²); a 1g brachistochrone reaches midpoint β≈0.95 at 4.2 ly. Moreover the call-site claim that current sites avoid relativistic ships is *wrong, which strengthens the finding*: `signalArrival` is called with `posFn = shipWorldState(ship,t).r` at sim.ts:317-318 (and emitTelemetry at 372-373), and `retardedTime` with shipWorldState at shipPanel.ts:422 — every UI frame for a selected ship. `shipWorldState`→`shipRelativeState`→`interstellarLegState` returns the relativistic-leg state. So an interstellar torch ship mid-leg drives these helpers at β up to ~0.95+, hitting the non-converged path live; the ship panel would display a signal-delay/retarded-state error of order days. The header comment (comms.ts:12-14) asserts convergence "in a couple of steps because in-system speeds are << c" — silently violated by the codebase's own interstellar feature. The failure is silent (wrong value, no NaN/throw).

Kept at minor (not major) because the impacted quantities are observability/timing readouts (retarded telemetry / signal delay / command-arrival timing), not core orbital state, and the convergence assumption is at least gestured at in the header (though incorrectly for the codebase's own trajectories). In-system ships (β≪1, the dominant regime) are correct.

**Refined expected:** Either document these as in-system-only (v≪c) helpers not to be applied to relativistic-speed targets, or provide an accelerated/closed-form relativistic solve (e.g. Newton iteration or the analytic radial form).

### 3.4 thrust-determinism-comment (minor, imprecise)

`sim.ts:134-144` partitions powered flight on a fixed absolute-time grid, gridNext=(floor(t/2)+1)·2 (MAX_THRUST_STEP=2), with segEnd = min(gridNext, target, nextEvent). `advanceThrustShip` performs a single classical RK4 step (integrators.ts `rk4` has no internal substepping) per smooth segment of length dt = segEnd − t0. The `target` term means a chunk boundary cuts the integration mid-grid-cell: the grid only *caps* substep size at the next 2 s multiple, it does not *re-align* the partition onto absolute multiples of 2.

Worked counterexample from grid boundary t=0, thrust active, no events: step(2) → segEnd=min(2,2,∞)=2 → one 2 s RK4 step. step(1)+step(1) → segEnd=min(2,1,∞)=1, then segEnd=min(2,2,∞)=2 → two 1 s RK4 steps. Even within one grid cell, step(2) over [0,2] vs step(0.5)+step(1.5) partitions [0,2] differently. RK4 over [a,c] in one step ≠ RK4 over [a,b]+[b,c] in two steps; the discrepancy is the local truncation error, O(h⁵) per step — the exact basis of step-doubling / Richardson error estimation. So step(A) then step(B) does not in general equal step(A+B) for the integrated r,v in the thrust regime.

The codebase itself confirms this, refuting any "merely imprecise design language" defense: (1) `serialize.ts:17-23` correctly scopes chunk-invariance to the analytic/impulsive regime and states RK4 truncation makes different chunkings of an active burn differ by ~metres = many quanta = legitimately different hashes; (2) `sim.test.ts:81` asserts grid-aligned step(600)==step(300)+step(300) only to <1e-3 m, not exact; (3) `sim.test.ts:96-108` uses non-grid-aligned chunk=7 vs 0.5 and asserts agreement only <50 m. These loose tolerances directly contradict the sim.ts:13 unqualified claim. The header's broader intent (the grid bounds per-step error; the rocket-equation ledger and event times *are* advanced analytically and *are* exactly chunk-invariant) is partly true, but the literal sentence is wrong for the RK4-integrated r,v. No runtime impact — the code is correct — so minor is right.

**Refined expected:** The sim.ts:11-14 header should scope the equality to the analytic/impulsive regime, matching serialize.ts:17-23. In the thrust regime the absolute-time grid only caps the RK4 substep; it does not re-align the partition, because segEnd=min(gridNext,target,nextEvent) cuts a segment at the chunk boundary `target`. Consequently step(A)+step(B) and step(A+B) produce r,v differing by the RK4 local truncation error (~sub-metre to metres) — legitimately different states, as the sim's own tests and serialize.ts confirm. The analytically advanced quantities (propellant, delivered Δv, event times) *are* exactly chunk-invariant; only the integrated r,v are not, and the header should say so.

### 3.5 hyperbolic-coe2rv-untested (minor, gap)

The round-trip `cases` in `kepler.test.ts:42-46` are all elliptic (e=0.3, 0.05, 0.048); the only direct hyperbolic test (lines 30-38) exercises `solveKeplerHyperbolic` (the scalar M=e·sinhF−F equation) alone, never the full elementsToState→stateToElements path. So there is no hyperbolic coe2rv/rv2coe round-trip test. The path is load-bearing in production: `arrival.ts:82-83` calls `stateToElements` on the target-relative state at SOI entry and computes periapsis = a(1−e); for a fast interplanetary approach (v_inf>0) this is a hyperbola (e>1, a<0), so the hyperbolic rv2coe branch runs at every capture/flyby.

The code is correct. The hyperbolic conversions in kepler.ts match the standard formulas: `trueAnomalyFromF` (line 106) gives tan(ν/2)=√((e+1)/(e−1))·tanh(F/2) and the inverse (line 275) tanh(F/2)=√((e−1)/(e+1))·tan(ν/2) (orbital-mechanics.space Eq. 233); hyperbolic Kepler M=e·sinhF−F (Eq. 234); r=a(1−e·coshF) with a<0 is algebraically identical to r=a(e·coshF−1) with a>0. An independent reimplementation of the exact code ran three hyperbolic round-trips (e=1.2/a=−1.2 AU/M=0.7; e=3.0/M=−1.5; e=1.05/M=0.3): all six elements recover to ~1e-15 (machine precision). No sign error.

Severity downgraded from major. The finding's premise that a sign error "would pass all unit tests and only show as a continuity-tolerance miss" is inaccurate: integration.test.ts B3 (lines 169-188) asserts the capture leaves a bound orbit with ε≈−μ/2r at the periapsis radius, and B2b (line 117) asserts a flyby is uncaptured — both derive from the hyperbolic a,e extracted by `stateToElements`, so a real sign error would break these physical assertions. The branch is therefore indirectly but meaningfully covered. A direct unit test mainly improves failure localization and covers the hyperbolic M-reconstruction (kepler.ts:276) that arrival.ts does not consume.

**Refined expected:** Add a hyperbolic round-trip block to kepler.test.ts mirroring the elliptic cases (e.g. {a:−1.2·AU, e:1.2}, {a:−0.5·AU, e:3.0}) asserting elementsToState→stateToElements recovers a,e,i,Ω,ω,M. The code is correct (machine-precision round-trip), so this is test-coverage hardening, not a bug fix — minor severity, since the branch is already indirectly validated by integration tests B2b and B3.

## 4. Gaps & Scope

Three of the five surviving findings are `gap`-category. Their omissions split cleanly between non-trivial undocumented assumptions and legitimate scope boundaries:

- **electric-thrust-not-derated-in-burn** — *non-trivial, undocumented.* This is the only one with live behavioral consequences. The 1/r² derating is implemented and used in the spiral path but silently bypassed in the impulsive integrator, with no docstring stating a chemical-only assumption and no guard preventing an electric stage from being commanded an impulsive burn. The energetics (propellant, Δv) stay correct because thrust cancels in the rocket equation; only burn duration and finite-burn trajectory are wrong. It deserves either the per-segment `thrustAt` fix or an explicit guard + documented assumption.

- **comms-relativistic-convergence** — *latent, partly documented, real for the codebase's own feature.* The fixed-point solvers are mathematically correct for v≪c and the header gestures at that assumption, but the assumption is violated by the in-repo interstellar torch trajectories that drive these helpers every UI frame. Because the corrupted outputs are display/timing readouts rather than orbital state, and because the codebase already routes interstellar ships through an analytic leg for their actual state, this is a minor robustness gap rather than a core-physics defect. It should be closed either by an honest in-system-only scope note or an accelerated solve.

- **hyperbolic-coe2rv-untested** — *coverage hardening of already-correct code.* The hyperbolic conversion is correct to machine precision and is indirectly exercised by capture/flyby integration tests at every interplanetary arrival. The gap is purely about failure localization and direct coverage of the M-reconstruction term, not about any latent incorrectness.

Separately, the broader relativistic-domain omissions noted in the audit summary — GR/gravitational time dilation, relativistic Doppler/aberration, relativistic collision momentum/energy, in-system finite-thrust relativistic correction — are all explicitly documented as out-of-scope in `ROADMAP.md`, consistent with the stated SR-only, in-system-Newtonian design. These are legitimate scope boundaries, not defects, and were not raised as findings.

## 5. Confirmed Correct (Appendix)

This section consolidates the verified-correct items per domain to document coverage, not just defects.

### Classical / Newtonian
- `integrators.ts:24-34` — rk4: exact classical Butcher tableau with dt/6 weighting.
- `sim.ts:230,235-237` — gravity gfac=−μ/r³ applied as r·gfac gives −(μ/r²)·r̂, correctly attractive.
- `sim.ts:205` — tauCut=(m0/mdot)(1−e^(−dvRem/ve)) exact inverse of the segment Tsiolkovsky law.
- `sim.ts:206` — tauEmpty=propMass/mdot exact for constant mdot.
- `sim.ts:232,239,248-249` — at=F/m, dm=−mdot, analytic dvDone+=ve·ln(m0/(m0−mdot·seg)) exact segment Tsiolkovsky.
- `propulsion.ts:42,47,52,57,62` — ve=Isp·g0; massFlow=F/ve; Tsiolkovsky dv=ve·ln(m0/mf); propellantForDv=m0(1−e^(−dv/ve)); dvForPropellant=ve·ln(m0/(m0−mProp)).
- `propulsion.ts:67,74` — electricThrust=2ηP/ve; solar power P·min(1,(AU/r)²).
- `propulsion.ts:99-112,119` — deltaVBudget staging; initialTWR=thrust/(wet·g0).
- `propulsion.ts:171-176,133,158` — relAccelLeg constant-proper-acceleration SR; rapidity=c·atanh(v/c); relativisticBurnVelocity=c·tanh((ve/c)·ln(m0/mf)).
- `surface.ts:37,42,49,55-59,149,153` — surfaceGravity=μ/R²; escapeVelocity=√(2μ/R); rotationSpeed=2πR/|T|; exponential atmosphere ρ0·exp(−h/H); drag accel ½ρv²/β; ascent dv/dt decomposition.
- `hohmann.ts:26-35` — Hohmann via vis-viva on transfer ellipse aT=(r1+r2)/2, tof=π√(aT³/μ).

### Orbital mechanics
- `kepler.ts:124-132` — rotation matrix R=Rz(Ω)Rx(i)Rz(ω), all 9 entries verified symbolically.
- `kepler.ts:65-78,85-97` — elliptic Newton (residual ≤4.4e-16, ≤11 iters) and hyperbolic Newton (rel residual 7.6e-16, ≤10 iters).
- `kepler.ts:100-107,162-171,217-227` — trueAnomaly conversions; perifocal v=(μ/h)[−sinν,e+cosν,0] with p=a(1−e²); eccentricity vector; energy/a inversion.
- `kepler.ts:238-267,292-299` — all four rv2coe singular branches round-trip to ~1e-9 m (incl. retrograde i=π); meanMotion √(μ/|a|³), period 2π√(a³/μ).
- `orbit.ts:13-19,28-30,39-43,51-63,77-104` — visViva/circular speeds; soiRadius (Earth SOI 924,647 km vs ~925,000 km); hyperbolicBurnDv; plane-change forms; j2Rates secular coefficients; sunSyncInclination (98.18°, exact 360°/yr).
- `ephemeris.ts:39-42,100-106` — Standish ω=ϖ−Ω, M=L−ϖ; Earth-Moon barycentre shift.
- `constants.ts:47,169,182,195` — MU_SUN/EARTH/MOON/MARS/JUPITER/SATURN, AU, C, J2_EARTH, J2_MARS match JPL to <6e-6.

### Maneuver / transfer
- `lambert.ts:20-43,96-130,82-87,150-184` — Stumpff C(z)/S(z) all three branches; y(z), F(z), dF/dz incl. z=0 limit; f/g/gdot recovery; prograde/retrograde selection; multi-rev golden-section + bisection — all vs Curtis 5.2.
- `hohmann.ts:26-41,55-80` — transfer ellipse, dv1/dv2, ToF, synodic period, phase-angle window.
- `biElliptic.ts:27-46` — a1/a2, three burns via vis-viva, ToF.
- `flyby.ts:21-28,37-68,76-81` — e=1+rp·vInf²/μ, δ=2asin(1/e); Rodrigues rotation + vectorial body-velocity addition; powered Oberth.
- `assist.ts:44-63` — eNeeded=1/sin(δ/2), rpNeeded inversion, law-of-cosines periapsis burn.
- `lowThrust.ts:21-25` — Edelbaum Δv.
- `arrival.ts:63-84`, `porkchop.ts:79-118` — SOI-entry periapsis evaluation; grid sweep with Oberth-aware burns.

### Relativistic & light-lag
- `propulsion.ts:133-159,171-197` — rapidity inverse pair; lorentzFactor (γ(0.866c)=2); relativisticMassRatio=exp(dφ/ve); relativisticBurnVelocity bounded <c; relAccelLeg from hyperbolic motion; brachistochrone two symmetric legs (matches 1g→Proxima ~3.5 yr ship / ~5.9 yr Earth / ~0.95c).
- `ships.ts:58-61,74-76,81-88,94-109` — brachDistance continuity; interstellarLegState speed profile; symmetric proper-time reconstruction; landedRelativeState ω×r.
- `interstellar.ts:59-65,88-90` — ballisticCruise rapidity split; torchTransit massRatio=relativisticMassRatio(ve, 2·rapidity(peakVelocity)).
- `comms.ts:21-52` — lightTime=distance/c; signalArrival/retardedTime light-cone fixed points (contraction ~v/c for in-system use).

### Cross-cutting / integration
- `kepler.ts:118-139,169-171,226-227,286-294` — perifocalToInertial shared by state and renderer; perifocal velocity sign-correct both conics; a=−μ/(2ε); propagate sign conventions consistent with enterSoi/capture.
- `sim.ts:529-546,596-614,629-641,110-123` — enterSoi/exitSoi continuous vector subtraction/addition (Δr<1e-3 m, Δv<1e-9 m/s); captureAtPeriapsis removes radial component (ε≈−μ/2r); interstellar τ telescopes (chunk-invariant).
- `orbit.ts:77-88,39-43`, `ephemeris.ts:92-108`, `comms.ts:29-52`, `ships.ts:185-214` — j2Rates; hyperbolicBurnDv; EMB↔Earth barycentre recombination; light-cone fixed points (v≪c); applyImpulsiveDv ledger closes (<1%).
- `integration.test.ts:41-82` — B1 relSpread<1e-12 genuinely pins energy and |r×v| conservation on the parking arc (with active J2) and heliocentric cruise.

## 6. Refuted Candidates (Appendix)

Candidates examined and cleared during verification:

| ID | Domain | Location | One-line reason for refutation |
|----|--------|----------|-------------------------------|
| deltabudget-negative-current-on-overfuel | Classical / Newtonian | `propulsion.ts:107-110` | mf=current−propMass ≥ 0 always for non-negative masses (proven + 200k-case fuzz); the mf>0 guard prevents any ln of a negative argument. NaN only arises from negative propMass, which the input contract forbids and `shipCatalog.test.ts` enforces. |
| surface-maneuver-uses-rated-thrust | Classical / Newtonian | `surface.ts:265,275` | Burn-time uses rated thrust, but surfaceManeuverCost serves only TWR>1 surface ascent/descent — a regime electric thrusters (TWR ~1e-4) cannot reach, and electric stages are architecturally routed to the spiral path. Δv/propellant are thrust-independent; only a cosmetic burnTime readout is affected, for an unreachable case. |
| moon-meanmotion-mu-inconsistency | Orbital mechanics | `ephemeris.ts:65-72,92-93` | MDot=13.064993 deg/day is the *anomalistic* rate; the model's sidereal advance L=M+peri+node=13.17640 deg/day implies μ only 0.27% below μ_sum (not the claimed ~1–2%). The auditor ignored the explicit periapsis precession the model carries; residual is documented (perturbations neglected). |
| soi-egress-bound-inside | Cross-cutting / integration | `sim.ts:556-579` | A bound arrival with apoapsis strictly inside the SOI is geometrically impossible: enterSoi fires at |rRel|=rSoi and derives a,e from that very state, so rSoi ≤ a(1+e) necessarily. The Math.max(−1,…) clamp is unreachable defensive code; no captured orbit is ejected. |
| rk4-thrust-chunk-untested | Cross-cutting / integration | `integration.test.ts:209-246` | The B5 golden suite is intentionally analytic+impulsive (correct for a hash oracle), but the RK4 thrust-path chunk boundary *is* pinned elsewhere: `sim.test.ts:81` (grid-aligned positive control) and `sim.test.ts:96-108` (non-grid-aligned negative-control bound, <50 m). The auditor missed sim.test.ts. |
