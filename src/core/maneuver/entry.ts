/**
 * Atmospheric entry heating & aerocapture — what a blunt body feels when it
 * trades orbital energy against an atmosphere instead of propellant.
 *
 * `descentBudget` (surface.ts) sheds orbital speed with a single aerobrake
 * FRACTION. This is the next fidelity step: a real ballistic entry trajectory,
 * RK4-integrated through the SAME exponential atmosphere (reuse atmosphericDensity),
 * reporting the three numbers an entry actually lives or dies by:
 *
 *   • peak deceleration  — the structural / crew g-limit,
 *   • peak convective stagnation-point heat flux  q = k·√(ρ/R_n)·v³  (Sutton-Graves),
 *   • the integrated heat load  ∫q dt  that sizes the thermal-protection system (TPS),
 *
 * plus a radiative-equilibrium wall temperature  T = (q/εσ)^¼  at the peak — the
 * same Stefan-Boltzmann inversion thermal.ts uses for equilibrium temperature.
 *
 * Aerocapture is the same integrator wrapped in a deterministic bisection: find
 * the entry flight-path angle whose single atmospheric pass leaves a hyperbolic
 * arrival BOUND at a target orbit, then compare the Δv it saves against a
 * propulsive capture burn (orbit.ts hyperbolicBurnDv) minus the small post-pass
 * periapsis-raise trim.
 *
 * Equations of motion are the classic planar point-mass entry set (Vinh / Regan),
 * lift = 0 (ballistic): with the flight-path angle γ measured POSITIVE-UP,
 *   dh/dt = v·sinγ,   dv/dt = −D/m − g·sinγ,   dγ/dt = (v/r − g/v)·cosγ.
 * The dγ/dt curvature term is what makes a super-circular pass skip back out and
 * a sub-circular one dive — the physics behind the aerocapture corridor.
 * Allen-Eggers (1958) gives the closed-form ballistic-entry peak decel/altitude
 * used as a sanity cross-check in the tests.
 *
 * Radiative (shock-layer) heating is neglected — a documented limitation that
 * matters only above ~10–11 km/s at Earth (Apollo lunar-return / Galileo regime).
 *
 * Pure functions over BodyDef + vehicle/entry params — no world state, never
 * called from sim.step, so golden-hash-neutral. SI throughout; mu = GM, angles
 * in radians, ρ kg/m³, fluxes W/m², heat load J/m².
 */

import { type BodyDef, SIGMA, G0 } from "../constants.ts";
import { atmosphericDensity, DEFAULT_ENTRY_BETA } from "../surface.ts";
import { visVivaSpeed, hyperbolicBurnDv } from "../orbit.ts";
import { rk4 } from "../math/integrators.ts";
import { type KeplerElements, elementsToState, propagate, period, meanMotion } from "../math/kepler.ts";
import { type Vec3, dot, normalize, length } from "../math/vec3.ts";

/** Sutton-Graves convective stagnation-point heating coefficient for AIR
 *  (Sutton & Graves, NASA TR R-376, 1971), SI: q = k·√(ρ/R_n)·v³ with q in W/m²,
 *  ρ in kg/m³, R_n in m, v in m/s. k ≈ 1.7415e-4 (the value often quoted as
 *  1.83e-4 is in mixed cgs units; this is the consistent-SI form). */
const SUTTON_GRAVES_AIR = 1.7415e-4;
/** CO₂ atmospheres (Mars, Venus) convect ~15% LESS for the same ρ,v — the heavier,
 *  less-dissociating gas. Documented calibration; per-call suttonGravesK override. */
const SUTTON_GRAVES_CO2 = 1.48e-4;
/** Bodies whose atmosphere is CO₂-dominated (use the CO₂ heating coefficient). */
const CO2_BODIES = new Set(["mars", "venus"]);
/** Atmospheric-interface altitude convention: where ρ has fallen to a negligible
 *  fraction of the surface value, ρ/ρ0 = e^−N. It must sit high enough that the
 *  drag DISCARDED above it (we inject full entry velocity at the interface) is
 *  negligible — otherwise a low-β / shallow entry over-predicts the peak. The
 *  fractional speed bled above the interface is ≈ (ρ0·H)/(2β·sinγ)·e^−N; N = 11
 *  (ρ/ρ0 ≈ 1.7e-5) keeps that under a few % even for a blunt (β≈100) shallow
 *  entry, while the discarded √ρ·v³ heating above it is utterly negligible. */
const INTERFACE_SCALE_HEIGHTS = 11;
/** Default hot-TPS surface emissivity for the radiative-equilibrium wall
 *  (carbon / ceramic ≈ 0.85). */
const DEFAULT_ENTRY_EMISSIVITY = 0.85;

/** The Sutton-Graves coefficient appropriate to a body's atmosphere composition. */
function defaultSuttonGravesK(body: BodyDef): number {
  return CO2_BODIES.has(body.id) ? SUTTON_GRAVES_CO2 : SUTTON_GRAVES_AIR;
}

// ── Heating primitives ───────────────────────────────────────────────────────

/** Convective stagnation-point heat flux q = k·√(ρ/R_n)·v³ (W/m²). */
export function suttonGravesFlux(k: number, rho: number, noseRadius: number, v: number): number {
  return k * Math.sqrt(rho / noseRadius) * v * v * v;
}

/** Radiative-equilibrium wall temperature: balance εσT⁴ = q ⇒ T = (q/εσ)^¼ (K).
 *  An upper bound on the surface temperature — a real ablator runs cooler by
 *  carrying heat away as mass. */
export function wallTemp(q: number, emissivity: number): number {
  return Math.pow(q / (emissivity * SIGMA), 0.25);
}

/** Altitude of the atmospheric interface (m) — INTERFACE_SCALE_HEIGHTS·H. 0 for
 *  an airless body (no interface). */
export function entryInterfaceAlt(body: BodyDef): number {
  const atm = body.atmosphere;
  if (!atm) return 0;
  return INTERFACE_SCALE_HEIGHTS * atm.scaleHeight;
}

// ── Entry trajectory integrator ──────────────────────────────────────────────

/** An entry vehicle — the blunt-body parameters that set heating and decel. */
export interface EntryVehicle {
  /** Ballistic coefficient β = m/(Cd·A) (kg/m²). Low β (blunt) decelerates high
   *  and cool; high β plunges deep and hot. Defaults to the blunt-capsule value. */
  ballisticCoef?: number;
  /** Stagnation-point (nose) radius R_n (m). Smaller noses heat MORE: q ∝ 1/√R_n. */
  noseRadius: number;
  /** TPS surface emissivity ε for the radiative-equilibrium wall temperature. */
  emissivity?: number;
  /** Per-call Sutton-Graves k (W·s³·m⁻⁴·kg^−½·…, SI). Defaults by atmosphere
   *  composition (CO₂ for Mars/Venus, air otherwise). */
  suttonGravesK?: number;
}

/** Conditions at the atmospheric interface (top of the integrated arc). */
export interface EntryConditions {
  /** Speed at the interface (m/s). For an aerocapture this is the hyperbolic
   *  arrival speed at interface radius; for a deorbit, ~orbital. */
  entrySpeed: number;
  /** Flight-path angle BELOW the local horizontal (rad), > 0 descending. Shallow
   *  (a few °) skips out; steep over-heats / crushes. */
  flightPathAngle: number;
}

export type EntryOutcome = "landed" | "captured" | "skip-out";

export interface EntryResult {
  outcome: EntryOutcome;
  peakDecel: number; // peak drag deceleration |D/m| (m/s²)
  peakDecelG: number; // … in g0
  peakHeatFlux: number; // peak Sutton-Graves stagnation flux (W/m²)
  peakWallTemp: number; // radiative-equilibrium wall T at the peak flux (K)
  heatLoad: number; // ∫ q dt over the pass (J/m²) — sizes the TPS
  peakDecelAlt: number; // altitude of peak deceleration (m)
  peakFluxAlt: number; // altitude of peak heat flux (m)
  exitSpeed: number; // speed at the end of the arc (m/s)
  exitAlt: number; // altitude at the end of the arc (m); 0 if landed
  exitAngle: number; // flight-path angle below horizontal at exit (rad)
  minAlt: number; // deepest altitude reached (m) — periapsis of the pass
  duration: number; // integrated time in the atmosphere (s)
  exitEnergy: number; // specific orbital energy at exit ε = v²/2 − μ/r (J/kg); < 0 ⇒ bound
}

/**
 * Integrate a ballistic entry from the atmospheric interface to its outcome.
 * Returns null for an airless body. Mirrors surface.ts::ascentBudget: a flat
 * RK4 state, a fixed step, and physical stop conditions, with the heating peaks
 * tracked as running maxima alongside the integrated state.
 */
export function entryTrajectory(
  body: BodyDef,
  vehicle: EntryVehicle,
  cond: EntryConditions,
): EntryResult | null {
  const atm = body.atmosphere;
  if (!atm) return null;

  const R = body.radius;
  const mu = body.mu;
  const beta = vehicle.ballisticCoef ?? DEFAULT_ENTRY_BETA;
  const Rn = vehicle.noseRadius;
  const eps = vehicle.emissivity ?? DEFAULT_ENTRY_EMISSIVITY;
  const k = vehicle.suttonGravesK ?? defaultSuttonGravesK(body);
  const hIface = entryInterfaceAlt(body);

  // State y = [h, v, gamma, heatLoad]; gamma is POSITIVE-UP internally (the
  // textbook entry convention), so an entry starts descending with gamma < 0.
  const deriv = (_t: number, s: number[]): number[] => {
    const h = s[0]!, v = s[1]!, g = s[2]!;
    const r = R + h;
    const grav = mu / (r * r);
    const rho = atmosphericDensity(body, h);
    const dragAcc = (0.5 * rho * v * v) / beta; // D/m = ½ρv²/β
    return [
      v * Math.sin(g), // dh/dt
      -dragAcc - grav * Math.sin(g), // dv/dt
      v > 1e-6 ? (v / r - grav / v) * Math.cos(g) : 0, // dγ/dt (curvature; lift = 0)
      suttonGravesFlux(k, rho, Rn, v), // d(heatLoad)/dt = q
    ];
  };

  let y = [hIface, cond.entrySpeed, -cond.flightPathAngle, 0];
  let t = 0;
  const dt = 0.1; // s — fine: the v³ heat peak near periapsis is sharp
  const tMax = 6000; // time guard (slow thick-atmosphere passes: Venus, Titan)

  let peakDecel = 0, peakDecelAlt = hIface;
  let peakFlux = 0, peakFluxAlt = hIface;
  let minAlt = hIface;

  while (t < tMax) {
    const h = y[0]!, v = y[1]!, g = y[2]!;
    const rho = atmosphericDensity(body, h);
    const dragAcc = (0.5 * rho * v * v) / beta;
    if (dragAcc > peakDecel) { peakDecel = dragAcc; peakDecelAlt = h; }
    const q = suttonGravesFlux(k, rho, Rn, v);
    if (q > peakFlux) { peakFlux = q; peakFluxAlt = h; }
    if (h < minAlt) minAlt = h;

    if (h <= 0) { y[0] = 0; break; } // landed: reached the surface
    if (h >= hIface && g > 0) break; // exited the atmosphere climbing
    if (v <= 1) break; // stalled in thick air (terminal descent)

    y = rk4(y, t, dt, deriv);
    t += dt;
    if (y[1]! < 0) y[1] = 0; // never fly backwards
  }

  const exitAlt = Math.max(y[0]!, 0);
  const r = R + exitAlt;
  const v = y[1]!;
  const exitEnergy = 0.5 * v * v - mu / r;

  let outcome: EntryOutcome;
  if (y[0]! <= 0) outcome = "landed";
  else if (exitEnergy < 0) outcome = "captured";
  else outcome = "skip-out";

  return {
    outcome,
    peakDecel,
    peakDecelG: peakDecel / G0,
    peakHeatFlux: peakFlux,
    peakWallTemp: wallTemp(peakFlux, eps),
    heatLoad: y[3]!,
    peakDecelAlt,
    peakFluxAlt,
    exitSpeed: v,
    exitAlt,
    exitAngle: -y[2]!, // back to below-horizontal convention
    minAlt,
    duration: t,
    exitEnergy,
  };
}

// ── In-sim flyable entry leg ─────────────────────────────────────────────────
//
// The same ballistic EOM as entryTrajectory, but carried as a PLANAR state so a
// ship can fly the pass in-sim and be watched at any time-warp. We add a downrange
// angle θ (dθ/dt = v·cosγ/r) to the [h, v, γ] state; (h, θ) plus an orbital-plane
// basis (built from the interface-crossing r0, v0) reconstruct the body-relative
// 3D position. Deterministic: a pure function of the fixed start and the fixed step,
// re-integrated on demand — exactly the read-time philosophy of the spiral /
// interstellar legs, just integrated rather than closed-form (drag has no closed
// form). First cut: planar, ballistic (lift = 0), atmospheric co-rotation ignored.

/** A snapshot of a flying entry at `elapsed` seconds past the interface crossing. */
export interface EntryPlanarStep {
  elapsed: number; // s since the entry started
  h: number; // altitude (m)
  v: number; // speed (m/s)
  gamma: number; // flight-path angle, positive-UP (rad) — descending is < 0
  theta: number; // downrange angle swept in the orbital plane (rad)
  heatLoad: number; // ∫ q dt so far (J/m²)
  q: number; // instantaneous stagnation heat flux (W/m²)
  decelG: number; // instantaneous drag deceleration (g0)
  wallTempK: number; // instantaneous radiative-equilibrium wall temperature (K)
  terminal: boolean; // a stop condition (landed / exited / stalled) was reached at/before elapsed
}

/**
 * Integrate the planar ballistic entry from the interface to `maxElapsed` seconds
 * (or to its terminal condition, whichever is first). Returns the state at the stop
 * time. Shares entryTrajectory's EOM, step, and stop conditions; null if airless.
 */
export function integrateEntryPlanar(
  body: BodyDef,
  vehicle: EntryVehicle,
  entrySpeed: number,
  flightPathAngle: number,
  maxElapsed = Infinity,
): EntryPlanarStep | null {
  const atm = body.atmosphere;
  if (!atm) return null;
  const R = body.radius, mu = body.mu;
  const beta = vehicle.ballisticCoef ?? DEFAULT_ENTRY_BETA;
  const Rn = vehicle.noseRadius;
  const eps = vehicle.emissivity ?? DEFAULT_ENTRY_EMISSIVITY;
  const k = vehicle.suttonGravesK ?? defaultSuttonGravesK(body);
  const hIface = entryInterfaceAlt(body);

  const deriv = (_t: number, s: number[]): number[] => {
    const h = s[0]!, v = s[1]!, g = s[2]!;
    const r = R + h;
    const grav = mu / (r * r);
    const rho = atmosphericDensity(body, h);
    const dragAcc = (0.5 * rho * v * v) / beta;
    return [
      v * Math.sin(g), // dh/dt
      -dragAcc - grav * Math.sin(g), // dv/dt
      v > 1e-6 ? (v / r - grav / v) * Math.cos(g) : 0, // dγ/dt
      v > 1e-6 ? (v * Math.cos(g)) / r : 0, // dθ/dt (downrange)
      suttonGravesFlux(k, rho, Rn, v), // d(heatLoad)/dt
    ];
  };

  let y = [hIface, entrySpeed, -flightPathAngle, 0, 0];
  let t = 0;
  const dt = 0.1, tMax = 6000;
  let terminal = false;
  while (t < tMax && t < maxElapsed) {
    const h = y[0]!, g = y[2]!;
    if (h <= 0) { y[0] = 0; terminal = true; break; } // landed
    if (h >= hIface && g > 0) { terminal = true; break; } // exited climbing
    if (y[1]! <= 1) { terminal = true; break; } // stalled in thick air
    const step = Math.min(dt, maxElapsed - t);
    y = rk4(y, t, step, deriv);
    t += step;
    if (y[1]! < 0) y[1] = 0;
  }

  const h = Math.max(y[0]!, 0), v = y[1]!;
  const rho = atmosphericDensity(body, h);
  const q = suttonGravesFlux(k, rho, Rn, v);
  const dragAcc = (0.5 * rho * v * v) / beta;
  return {
    elapsed: t, h, v, gamma: y[2]!, theta: y[3]!, heatLoad: y[4]!,
    q, decelG: dragAcc / G0, wallTempK: wallTemp(q, eps), terminal,
  };
}

/** Where a coasting orbit first enters the atmosphere. */
export interface InterfaceCrossing {
  dtToInterface: number; // s from the elements' epoch to the inbound interface crossing
  r0: Vec3; // body-relative position at the crossing (m)
  v0: Vec3; // body-relative velocity at the crossing (m/s)
  entrySpeed: number; // |v0| (m/s)
  flightPathAngle: number; // below-horizontal angle of v0 (rad), > 0 descending
}

/**
 * Find where an osculating orbit (elements about `body`, valid at dt = 0) first
 * descends through the atmospheric interface. Returns null if the periapsis stays
 * above the interface (the orbit never enters). Deterministic sample-then-bisect on
 * the analytic Kepler propagation — no integration.
 */
export function entryInterfaceCrossing(body: BodyDef, el: KeplerElements): InterfaceCrossing | null {
  const atm = body.atmosphere;
  if (!atm) return null;
  const mu = body.mu;
  const rIface = body.radius + entryInterfaceAlt(body);
  const rp = el.a * (1 - el.e); // periapsis radius (a < 0 for hyperbola ⇒ still > 0)
  if (!(rp < rIface)) return null; // never reaches the atmosphere

  const radiusAt = (dt: number): number => length(elementsToState(propagate(el, mu, dt), mu).r);
  // Scan forward for the first downward crossing of rIface, then bisect. For an
  // elliptic orbit one period covers it; for a hyperbola the inbound crossing is
  // before periapsis (time-to-periapsis = −M/n for the inbound M < 0 — which can be
  // DAYS from an SOI-edge arrival, far longer than a low-orbit deorbit), so size the
  // window to that rather than a fixed guess.
  const n = meanMotion(el.a, mu);
  const scanMax = el.a > 0 ? period(el.a, mu) * 1.01 : el.M < 0 ? 1.3 * (-el.M / n) : 12 * 3600;
  const steps = 720;
  const dtStep = scanMax / steps;
  let prevT = 0, prevR = radiusAt(0);
  let lo = NaN, hi = NaN;
  for (let i = 1; i <= steps; i++) {
    const tt = i * dtStep;
    const rr = radiusAt(tt);
    if (prevR > rIface && rr <= rIface) { lo = prevT; hi = tt; break; } // inbound crossing
    prevT = tt; prevR = rr;
  }
  if (Number.isNaN(lo)) return null;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (radiusAt(mid) > rIface) lo = mid; else hi = mid;
  }
  const dtX = 0.5 * (lo + hi);
  const st = elementsToState(propagate(el, mu, dtX), mu);
  const speed = length(st.v);
  const rHat = normalize(st.r);
  const vr = dot(st.v, rHat); // radial rate (negative inbound)
  const fpa = Math.asin(Math.max(-1, Math.min(1, -vr / speed))); // below-horizontal, > 0 descending
  return { dtToInterface: dtX, r0: st.r, v0: st.v, entrySpeed: speed, flightPathAngle: fpa };
}

/** Apoapsis radius (m) of the osculating orbit at an entry's exit state, or
 *  Infinity if the exit is unbound (energy ≥ 0). */
function exitApoapsis(body: BodyDef, res: EntryResult): number {
  const mu = body.mu;
  if (res.exitEnergy >= 0) return Infinity;
  const r = body.radius + res.exitAlt;
  const v = res.exitSpeed;
  const a = -mu / (2 * res.exitEnergy);
  const hAng = r * v * Math.cos(res.exitAngle); // specific angular momentum
  const e = Math.sqrt(Math.max(0, 1 + (2 * res.exitEnergy * hAng * hAng) / (mu * mu)));
  return a * (1 + e);
}

// ── Aerocapture ──────────────────────────────────────────────────────────────

export interface AerocaptureParams {
  /** Hyperbolic excess speed v∞ at the body (m/s). The interface speed follows
   *  from energy: v = √(v∞² + 2μ/r_iface). */
  vInf: number;
  /** Target captured-orbit apoapsis ALTITUDE above the surface (m). */
  targetApoAlt: number;
  /** Periapsis altitude to raise to after the pass (m). Default 200 km-class. */
  targetPeriAlt?: number;
  /** Wall-temperature ceiling for a survivable corridor (K). Default 3000. */
  maxWallTemp?: number;
  /** Deceleration ceiling for a survivable corridor (g0). Default 15. */
  maxDecelG?: number;
}

export interface AerocaptureResult {
  feasible: boolean;
  /** Why infeasible, when feasible is false. */
  reason?: "corridor-too-narrow" | "overheats" | "never-captures";
  entryAngle: number; // solved flight-path angle below horizontal (rad)
  periapsisAlt: number; // periapsis altitude of the solved pass (m)
  apoapsisAlt: number; // resulting captured-orbit apoapsis altitude (m)
  dvPropulsive: number; // the propulsive-capture burn this replaces (m/s)
  trimDv: number; // post-pass periapsis-raise burn (m/s)
  dvSaved: number; // dvPropulsive − trimDv (m/s)
  entry: EntryResult; // the heat/decel budget of the solved pass
}

/**
 * Solve the single-pass aerocapture corridor for a hyperbolic arrival. Scans the
 * entry flight-path angle, then bisects (deterministic, fixed iteration count)
 * for the angle whose pass leaves the vehicle bound at the target apoapsis, and
 * reports the Δv it saves against a propulsive capture burn. Returns null for an
 * airless body.
 *
 * The apoapsis is monotone in the entry angle within the captured corridor —
 * shallower sheds less (higher apoapsis, → skip-out), steeper sheds more (lower
 * apoapsis, → landing) — so a bisection is well-posed.
 */
export function aerocapture(
  body: BodyDef,
  vehicle: EntryVehicle,
  p: AerocaptureParams,
): AerocaptureResult | null {
  const atm = body.atmosphere;
  if (!atm) return null;

  const R = body.radius;
  const mu = body.mu;
  const rIface = R + entryInterfaceAlt(body);
  const entrySpeed = Math.sqrt(p.vInf * p.vInf + (2 * mu) / rIface);
  const targetPeriAlt = p.targetPeriAlt ?? 2e5;
  const raTarget = R + p.targetApoAlt;
  const maxWallTemp = p.maxWallTemp ?? 3000;
  const maxDecelG = p.maxDecelG ?? 15;

  const pass = (gamma: number): EntryResult =>
    entryTrajectory(body, vehicle, { entrySpeed, flightPathAngle: gamma })!;
  // Apoapsis as a monotone-decreasing function of entry angle: a skip-out tops out
  // unbound (+∞, above any target), a landing bottoms out (−∞, below any target),
  // and a capture is the finite apoapsis in between. Bisecting this against the
  // target apoapsis lands on the capturing angle.
  const apoVal = (res: EntryResult): number =>
    res.outcome === "skip-out" ? Infinity : res.outcome === "landed" ? -Infinity : exitApoapsis(body, res);

  // Scan shallow→steep and bracket the first crossing of the target apoapsis.
  const N = 120;
  const gLo = 0.05 * (Math.PI / 180);
  const gHi = 60 * (Math.PI / 180);
  let anyCaptured = false, sawSkip = false, sawLanded = false;
  let bracketLo = NaN, bracketHi = NaN;
  let prevG = gLo;
  let prevVal = apoVal(pass(gLo));
  for (let i = 1; i <= N; i++) {
    const g = gLo + ((gHi - gLo) * i) / N;
    const res = pass(g);
    if (res.outcome === "captured") anyCaptured = true;
    else if (res.outcome === "skip-out") sawSkip = true;
    else sawLanded = true;
    const val = apoVal(res);
    if (isNaN(bracketLo) && prevVal > raTarget && val <= raTarget) {
      bracketLo = prevG;
      bracketHi = g;
    }
    prevG = g;
    prevVal = val;
  }

  if (isNaN(bracketLo) || !anyCaptured) {
    // No capturing angle straddles the target apoapsis. Either every pass skips
    // back out (too fast for this atmosphere) or the skip→land transition is
    // narrower than the scan can resolve.
    const reason: AerocaptureResult["reason"] =
      anyCaptured || (sawSkip && sawLanded) ? "corridor-too-narrow" : "never-captures";
    return solveAt(isNaN(bracketLo) ? 0.5 * (gLo + gHi) : bracketLo, body, vehicle, entrySpeed, R, mu, targetPeriAlt, maxWallTemp, maxDecelG, reason);
  }

  // Bisect for the entry angle whose pass apoapsis matches the target.
  let lo = bracketLo, hi = bracketHi;
  for (let i = 0; i < 50; i++) {
    const mid = 0.5 * (lo + hi);
    if (apoVal(pass(mid)) > raTarget) lo = mid; else hi = mid; // steeper lowers apoapsis
  }
  return solveAt(0.5 * (lo + hi), body, vehicle, entrySpeed, R, mu, targetPeriAlt, maxWallTemp, maxDecelG, null);
}

/** Build the AerocaptureResult at a solved entry angle: charge the post-pass
 *  periapsis-raise trim, compare against the propulsive-capture burn, and flag
 *  overheat / over-g (or a forced infeasibility reason) as infeasible. */
function solveAt(
  gamma: number,
  body: BodyDef,
  vehicle: EntryVehicle,
  entrySpeed: number,
  R: number,
  mu: number,
  targetPeriAlt: number,
  maxWallTemp: number,
  maxDecelG: number,
  forced: AerocaptureResult["reason"] | null,
): AerocaptureResult {
  const res = entryTrajectory(body, vehicle, { entrySpeed, flightPathAngle: gamma })!;
  const ra = exitApoapsis(body, res);
  const raFin = isFinite(ra) ? ra : R + Math.max(res.exitAlt, res.minAlt);
  const rpPass = R + Math.max(0, res.minAlt);

  // Post-pass periapsis-raise trim: burn at apoapsis to lift periapsis from the
  // pass depth to the target parking altitude (two co-apoapsis ellipses).
  const rpTarget = R + targetPeriAlt;
  const a1 = 0.5 * (rpPass + raFin);
  const a2 = 0.5 * (rpTarget + raFin);
  const trimDv = Math.abs(visVivaSpeed(mu, raFin, a2) - visVivaSpeed(mu, raFin, a1));

  const vInf = Math.sqrt(Math.max(0, entrySpeed * entrySpeed - (2 * mu) / (R + entryInterfaceAlt(body))));
  const dvPropulsive = hyperbolicBurnDv(vInf, mu, rpTarget);
  const dvSaved = dvPropulsive - trimDv;

  const overheats = res.peakWallTemp > maxWallTemp || res.peakDecelG > maxDecelG;
  const reason: AerocaptureResult["reason"] | null = forced ?? (overheats ? "overheats" : null);
  const feasible = reason === null && res.outcome === "captured";

  return {
    feasible,
    ...(feasible ? {} : { reason: reason ?? "corridor-too-narrow" }),
    entryAngle: gamma,
    periapsisAlt: res.minAlt,
    apoapsisAlt: isFinite(ra) ? raFin - R : Infinity,
    dvPropulsive,
    trimDv,
    dvSaved,
    entry: res,
  };
}
