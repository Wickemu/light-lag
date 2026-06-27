/**
 * Landing & takeoff Δv budgeting — what it costs to get off (or onto) a surface.
 *
 * The orbital-mechanics part is exact; the loss part is honestly hard. There is
 * no closed-form ascent Δv: the real cost depends on the trajectory flown. So we
 * decompose it the way mission designers do, into four separately-defensible
 * terms, and we INTEGRATE a real gravity-turn ascent (RK4, through an exponential
 * atmosphere, with the vehicle's real thrust-to-weight and ballistic coefficient)
 * to obtain the two loss terms rather than guessing them:
 *
 *     dvTotal = vOrbit + gravityLoss + dragLoss − rotationBonus
 *
 *   • vOrbit       — circular speed at the target orbit (vis-viva, EXACT).
 *   • gravityLoss  — ∫ g·sinγ dt over the powered ascent (integrated).
 *   • dragLoss     — ∫ (D/m) dt over the powered ascent (integrated, 0 if airless).
 *   • rotationBonus— equatorial surface speed an eastward launch inherits (EXACT).
 *
 * The ONE calibration is the ascent pitch program (PITCH_EXP): how the
 * flight-path angle rolls from vertical to horizontal as orbital speed builds. It
 * is tuned once so Earth→LEO reproduces the real ~9.3–9.5 km/s budget, then
 * applied unchanged to every body — exactly the documented-calibration pattern of
 * THERMAL_PARAMS/SENSOR in ships.ts. Everything else is physics. "Safe touchdown
 * is implicit": we budget the Δv and propellant, we do not simulate the guidance.
 *
 * SI throughout.
 */

import { type BodyDef } from "./constants.ts";
import { type Stage, deltaVBudget, stageWetMass, stageBurnCost } from "./propulsion.ts";
import { circularSpeed } from "./orbit.ts";
import { hohmann } from "./maneuver/hohmann.ts";
import { rk4 } from "./math/integrators.ts";
import { type PoweredSample } from "./world.ts";

/** Number of points sampled from the ascent/descent integrator into a leg's visual
 *  spline. The arc is minutes long and rendered, not physics-critical, so a few dozen
 *  points are smooth; the spline is interpolated at read time (see ships.ts). */
const POWERED_SAMPLE_COUNT = 32;

// ── Derived surface quantities (never stored — physics, not data) ────────────

/** Surface gravity g = μ/R² (m/s²). */
export function surfaceGravity(body: BodyDef): number {
  return body.mu / (body.radius * body.radius);
}

/** Surface escape velocity √(2μ/R) (m/s). */
export function escapeVelocity(body: BodyDef): number {
  return Math.sqrt((2 * body.mu) / body.radius);
}

/** Equatorial surface rotation speed v_rot = 2πR/|T_rot| (m/s); 0 if the body's
 *  rotation is unknown. The free Δv an eastward equatorial launch inherits and a
 *  westward (or retrograde-world) launch must overcome. */
export function rotationSpeed(body: BodyDef): number {
  if (!body.rotationPeriod) return 0;
  return (2 * Math.PI * body.radius) / Math.abs(body.rotationPeriod);
}

/** Atmospheric density at altitude h (m): ρ0·exp(−h/H). 0 for an airless body. */
export function atmosphericDensity(body: BodyDef, h: number): number {
  const atm = body.atmosphere;
  if (!atm) return 0;
  return atm.surfaceDensity * Math.exp(-h / atm.scaleHeight);
}

// ── Ascent model (gravity turn) ──────────────────────────────────────────────

/** Calibration of the ascent pitch program. The flight-path angle (from the
 *  horizontal) follows γ(v) = (π/2)·(1 − v/vOrbit)^PITCH_EXP: vertical at liftoff,
 *  horizontal once orbital speed is reached. PITCH_EXP is the single tuned knob —
 *  larger keeps the vehicle steeper for longer (more gravity loss, less drag). It
 *  is set so Earth→200 km LEO reproduces the real ~9.3–9.5 km/s budget, then used
 *  unchanged for every body. */
const PITCH_EXP = 3.3;
/** Default vehicle parameters when the caller doesn't supply a real ship. */
const DEFAULT_EXHAUST_VELOCITY = 3334; // m/s (Isp ≈ 340 s, kerolox upper-stage class)
/** Ballistic coefficient β = m/(Cd·A) (kg/m²) for ascent drag. A launch vehicle
 *  is slender/dense (high β ⇒ little drag loss). Documented calibration. */
const DEFAULT_ASCENT_BETA = 4000;
/** Ballistic coefficient for an ENTRY vehicle (kg/m²) — blunt, high-drag, so the
 *  atmosphere sheds far more of the orbital energy than a slender ascent body.
 *  Shared with the entry-heating model (maneuver/entry.ts) so both use one number. */
export const DEFAULT_ENTRY_BETA = 150;

export interface AscentParams {
  /** Target circular parking-orbit altitude above the surface (m). */
  parkingAlt: number;
  /** Initial liftoff thrust-to-weight against the body's LOCAL surface gravity. */
  twr: number;
  /** Effective exhaust velocity (m/s). Sets how fast the vehicle lightens during
   *  the climb (and thus the burn time and gravity loss). */
  exhaustVelocity?: number;
  /** Ballistic coefficient β = m/(Cd·A) (kg/m²) for the drag loss. */
  ballisticCoef?: number;
  /** Launch against the body's rotation (rotationBonus becomes a penalty). */
  retrograde?: boolean;
}

export interface AscentBudget {
  vOrbit: number; // circular speed at the target orbit (m/s) — the kinetic floor
  gravityLoss: number; // ∫ g·sinγ dt over the powered ascent (m/s)
  dragLoss: number; // ∫ (D/m) dt over the powered ascent (m/s); 0 if airless
  rotationBonus: number; // free Δv from an eastward equatorial launch (m/s)
  dvTotal: number; // net Δv the vehicle must provide (m/s)
  burnTime: number; // powered-ascent duration (s)
  insertionAlt: number; // altitude at which orbital velocity is reached (m)
  /** False if the vehicle could not reach orbital velocity within a ~16 km/s
   *  engine-Δv budget — drag-stalled in a thick lower atmosphere (Venus). The
   *  reported dvTotal is then a lower bound; direct surface ascent is impractical. */
  converged: boolean;
}

/**
 * Integrate a gravity-turn ascent in SPECIFIC (per-unit-initial-mass) terms, so
 * the loss budget depends only on the body, target orbit, TWR, exhaust velocity,
 * and ballistic coefficient — never on the vehicle's absolute mass (that enters
 * only when converting Δv to propellant, in surfaceManeuverCost). Returns null
 * for a body with no solid surface (the Sun, the gas giants).
 */
export function ascentBudget(
  body: BodyDef,
  p: AscentParams,
  /** When provided, the integrator pushes ~POWERED_SAMPLE_COUNT stride-sampled trajectory
   *  rows {t (elapsed), h, v, gamma, theta} into this array — the visual ascent spline. The
   *  downrange angle theta is a decoupled extra integrator state, so the returned budget
   *  numbers are byte-identical whether or not samples are requested. */
  samples?: PoweredSample[],
): AscentBudget | null {
  if (body.hasSurface === false) return null;

  const R = body.radius;
  const mu = body.mu;
  const gSurf = mu / (R * R);
  const ve = p.exhaustVelocity ?? DEFAULT_EXHAUST_VELOCITY;
  const beta = p.ballisticCoef ?? DEFAULT_ASCENT_BETA;
  const targetR = R + p.parkingAlt;
  const vOrbit = circularSpeed(mu, targetR); // circular speed at the destination
  const vRef = circularSpeed(mu, R); // pitch reference (near-surface circular speed)

  // Specific (m0 = 1) thrust acceleration and mass-flow: a0 = twr·gSurf at liftoff.
  const T = p.twr * gSurf; // initial thrust acceleration (m/s²)
  const mdot = T / ve; // fractional mass loss per second (1/s)

  // Prescribed pitch: γ (from the horizontal) goes 90°→0° as v→vRef.
  const pitch = (v: number): number =>
    (Math.PI / 2) * Math.pow(Math.max(0, 1 - v / vRef), PITCH_EXP);

  // State: [h, v, m, gravLoss, dragLoss, theta]. The gravity turn inserts into the
  // orbit it naturally reaches (local circular speed); the climb to a higher requested
  // parking orbit is then an impulsive Hohmann raise, keeping the budget monotonic
  // in altitude. theta (downrange angle) is a decoupled 6th state — it integrates FROM
  // (h,v) but feeds back into nothing, so the first five components (and every budget
  // number) are identical to before it was added; it only drives the visual spline.
  let y = [0, 0, 1, 0, 0, 0];
  let t = 0;
  const dt = 0.5; // s — fixed step; ascent is a few hundred seconds

  const deriv = (_t: number, s: number[]): number[] => {
    const h = s[0]!, v = s[1]!, m = s[2]!;
    const r = R + h;
    const g = mu / (r * r);
    const gamma = pitch(v);
    const sinG = Math.sin(gamma);
    const cosG = Math.cos(gamma);
    const rho = atmosphericDensity(body, h);
    const dragAcc = (0.5 * rho * v * v) / beta; // D/m = ½ρv²/β
    const thrustAcc = T / Math.max(m, 1e-6);
    return [
      v * sinG, // dh/dt
      thrustAcc - g * sinG - dragAcc, // dv/dt
      -mdot, // dm/dt
      g * sinG, // d(gravLoss)/dt
      dragAcc, // d(dragLoss)/dt
      (v * cosG) / r, // d(theta)/dt — downrange angular rate
    ];
  };

  // Optional visual spline: record every integration step, downsampled below.
  const rows: PoweredSample[] | null = samples ? [] : null;
  if (rows) rows.push({ t: 0, h: 0, v: 0, gamma: pitch(0), theta: 0 });

  // Stop at orbital insertion (the LOCAL circular speed is reached), at a ~150
  // mass ratio (≈16 km/s engine Δv — drag-stalled, no conventional vehicle reaches
  // orbit), or a time guard.
  const tMax = 8000;
  const massFloor = 1 / 150;
  const localCirc = (h: number): number => circularSpeed(mu, R + h);
  while (t < tMax && y[1]! < localCirc(y[0]!) && y[2]! > massFloor) {
    y = rk4(y, t, dt, deriv);
    t += dt;
    if (y[0]! < 0) y[0] = 0; // never sink below the surface
    if (y[1]! < 0) y[1] = 0; // never fly backwards
    if (rows) rows.push({ t, h: y[0]!, v: y[1]!, gamma: pitch(y[1]!), theta: y[5]! });
  }
  const insertionAlt = y[0]!;

  // Downsample the recorded trajectory to ~POWERED_SAMPLE_COUNT evenly-spaced rows
  // (fixed dt ⇒ evenly spaced in time), always keeping the first (liftoff) and last
  // (insertion) points.
  if (samples && rows) {
    const K = Math.min(POWERED_SAMPLE_COUNT, rows.length);
    if (K <= 1) {
      samples.push(rows[0]!);
    } else {
      for (let i = 0; i < K; i++) {
        samples.push(rows[Math.round((i * (rows.length - 1)) / (K - 1))]!);
      }
    }
  }
  const converged = y[1]! >= localCirc(insertionAlt);
  const gravityLoss = y[3]!;
  const dragLoss = y[4]!;

  // Impulsive Hohmann raise from the natural insertion orbit to the requested
  // parking orbit (zero when insertion already meets or exceeds the target).
  const raiseDv = targetR > R + insertionAlt
    ? hohmann(mu, R + insertionAlt, targetR).dvTotal
    : 0;

  const rotationBonus = (p.retrograde ? -1 : 1) * rotationSpeed(body);
  const vInsertion = circularSpeed(mu, R + insertionAlt);
  const dvTotal = vInsertion + gravityLoss + dragLoss + raiseDv - rotationBonus;

  return { vOrbit, gravityLoss, dragLoss, rotationBonus, dvTotal, burnTime: t, insertionAlt, converged };
}

// ── Descent model ────────────────────────────────────────────────────────────

export interface DescentBudget {
  vOrbit: number; // orbital speed shed during descent (m/s)
  aerobrakeFraction: number; // fraction of vOrbit the atmosphere sheds (0 airless)
  dvPowered: number; // powered Δv the vehicle must provide (m/s)
  dvTotal: number; // = dvPowered (the rest, if any, is free aerobraking)
  /** Powered-descent duration (s) for the AIRLESS branch — the time-reverse of the
   *  ascent burn, used to schedule the visual descent leg. Undefined for an atmosphere
   *  body (its descent is the drag pass, animated by EntryLeg, not this leg). */
  burnTime?: number;
}

/**
 * Descent (circular parking orbit → safe touchdown) Δv.
 *
 * Airless body: there is no free deceleration, so you must thrust away ~all of
 * the orbital speed plus the gravity losses of the powered descent — essentially
 * the ascent budget without the rotation help (you cannot lean on rotation to
 * stop). We reuse the ascent gravity loss for symmetry.
 *
 * Atmospheric body: aerobraking (and, implicitly, parachutes) shed most of the
 * orbital energy for free; only a small terminal/landing burn remains. The
 * aerobrake fraction follows from the atmospheric column mass ρ0·H against an
 * entry vehicle's ballistic coefficient — a documented calibration; the
 * exponential-atmosphere column itself is exact.
 */
export function descentBudget(
  body: BodyDef,
  p: AscentParams,
  /** When provided (AIRLESS bodies only), the time-reversed ascent spline is pushed here
   *  as the visual descent arc. Ignored for an atmosphere body. */
  samples?: PoweredSample[],
): DescentBudget | null {
  if (body.hasSurface === false) return null;

  const mu = body.mu;
  const vOrbit = circularSpeed(mu, body.radius + p.parkingAlt);
  const gSurf = mu / (body.radius * body.radius);

  if (!body.atmosphere) {
    // Symmetric to ascent (cancel all orbital speed, pay the same gravity losses)
    // but with no rotation help on the way down: descent = ascent + rotationBonus.
    // The descent ARC is the ascent spline reversed in time — a powered landing is the
    // kinematic mirror of a powered ascent (same pitch program, reversed): row i becomes
    // (T−tᵢ, hᵢ, vᵢ, −γᵢ, θ_T−θᵢ), so it starts at insertion altitude/orbital speed and
    // ends at a vertical, zero-speed touchdown.
    const ascSamples: PoweredSample[] | undefined = samples ? [] : undefined;
    const ascent = ascentBudget(body, p, ascSamples)!;
    const dvTotal = ascent.dvTotal + ascent.rotationBonus;
    if (samples && ascSamples && ascSamples.length > 0) {
      const T = ascent.burnTime;
      const thetaT = ascSamples[ascSamples.length - 1]!.theta;
      for (let i = ascSamples.length - 1; i >= 0; i--) {
        const a = ascSamples[i]!;
        samples.push({ t: T - a.t, h: a.h, v: a.v, gamma: -a.gamma, theta: thetaT - a.theta });
      }
    }
    return { vOrbit, aerobrakeFraction: 0, dvPowered: dvTotal, dvTotal, burnTime: ascent.burnTime };
  }

  const atm = body.atmosphere;
  const column = atm.surfaceDensity * atm.scaleHeight; // kg/m² the atmosphere can pile up
  const entryBeta = p.ballisticCoef ?? DEFAULT_ENTRY_BETA;
  const aerobrakeFraction = Math.min(0.99, 1 - Math.exp(-column / entryBeta));
  // Small terminal-descent reserve: a few seconds of hover-class authority.
  const terminalBurn = Math.max(50, 8 * gSurf);
  const dvPowered = vOrbit * (1 - aerobrakeFraction) + terminalBurn;
  return { vOrbit, aerobrakeFraction, dvPowered, dvTotal: dvPowered };
}

// ── Propellant / burn time for a real staged stack ───────────────────────────

export interface SurfaceManeuverCost {
  dv: number; // the maneuver Δv (m/s)
  propellant: number; // propellant burned (kg)
  burnTime: number; // total burn time (s)
  feasible: number; // dvAvailable − dv (≥0 ⇒ affordable)
}

/**
 * Propellant and burn time to deliver `dv` on a staged stack with `payload` on
 * top, walking stages exactly as the rocket equation requires (a spent stage is
 * dropped before the next ignites). Read-only — it mutates nothing. Booster-aware
 * via `stageBurnCost` (concurrent core+booster reservoirs), so the propellant/burn
 * time agree with the booster-aware `deltaVBudget` headroom; reduces to the serial
 * closed form when there are no boosters.
 */
export function surfaceManeuverCost(stages: Stage[], payload: number, dv: number): SurfaceManeuverCost {
  const available = deltaVBudget(stages, payload).total;
  let current = payload + stages.reduce((s, st) => s + stageWetMass(st), 0);
  let remaining = dv;
  let propellant = 0;
  let burnTime = 0;
  for (const st of stages) {
    if (remaining <= 0) break;
    const cost = stageBurnCost(st, current, remaining);
    propellant += cost.propUsed;
    burnTime += cost.burnTime;
    remaining -= cost.dvDelivered;
    current = cost.finalMass; // drop the spent stage (and its boosters)
  }
  return { dv, propellant, burnTime, feasible: available - dv };
}
