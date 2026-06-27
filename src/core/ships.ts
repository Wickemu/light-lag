/**
 * Helpers that turn the raw Ship record into physical quantities: its current
 * mass (which falls as propellant burns and stages drop), its state about its
 * primary, its absolute state in the root frame, and the osculating orbit it is
 * currently on — coasting or mid-burn.
 */

import { type Ship, type InterstellarLeg, type EntryLeg } from "./world.ts";
import { type Stage, deltaVBudget, exhaustVelocity, stageWetMass, consumeStageDv, boosterCount } from "./propulsion.ts";
import {
  type State,
  type KeplerElements,
  elementsToState,
  stateToElements,
  propagate,
  wrapPi,
} from "./math/kepler.ts";
import { j2Rates } from "./orbit.ts";
import { bodyState } from "./ephemeris.ts";
import { STAR_BY_ID, starPosition } from "./stars.ts";
import { BODY_BY_ID, C } from "./constants.ts";
import { type Vec3, add, addScaled, sub, scale, dot, cross, normalize, length, distance } from "./math/vec3.ts";
import { integrateEntryPlanar, entryTrajectory } from "./maneuver/entry.ts";
import { DEFAULT_ENTRY_BETA } from "./surface.ts";
import {
  solarFlux, hullArea, equilibriumTemp, detectionRange, minDetectablePowerW, radiatorArea,
  type SensorSpec, DEFAULT_SENSOR,
} from "./thermal.ts";

/** GM of the body this ship orbits. */
export function primaryMu(ship: Ship): number {
  const body = BODY_BY_ID.get(ship.primary);
  if (!body) throw new Error(`Ship ${ship.id} has unknown primary ${ship.primary}`);
  return body.mu;
}

/** The currently firing stage, or undefined if the ship is out of stages. */
export function activeStage(ship: Ship): Stage | undefined {
  return ship.stages[ship.activeStage];
}

/** Total current mass: payload + every stage from the active one upward,
 *  including each stage's live (un-spent, un-dropped) strap-on boosters. */
export function totalMass(ship: Ship): number {
  let m = ship.payloadMass;
  for (let i = ship.activeStage; i < ship.stages.length; i++) {
    m += stageWetMass(ship.stages[i]!);
  }
  return m;
}

/** Δv still available from the remaining (un-spent) stages. */
export function dvRemaining(ship: Ship): number {
  const remaining = ship.stages.slice(ship.activeStage);
  return deltaVBudget(remaining, ship.payloadMass).total;
}

// ── Interstellar legs (analytic relativistic trajectory) ─────────────────────

/** Distance covered along a flip-and-burn at coordinate time `tc` into a leg of
 *  total duration T over distance D at proper acceleration a (two symmetric
 *  halves: accelerate to the midpoint, decelerate to rest). */
function brachDistance(a: number, D: number, T: number, tc: number): number {
  const distAt = (tt: number) => ((C * C) / a) * (Math.sqrt(1 + ((a * tt) / C) ** 2) - 1);
  return tc <= T / 2 ? distAt(tc) : D - distAt(T - tc);
}

/** Analytic state (root ecliptic-J2000 frame) of a ship on an interstellar leg at
 *  coordinate time t. Exact at any time-warp — no integration. */
export function interstellarLegState(leg: InterstellarLeg, t: number): State {
  const target = STAR_BY_ID.get(leg.targetStar);
  if (!target) return { r: leg.startPos, v: { x: 0, y: 0, z: 0 } };
  // Aim at where the star WILL BE on arrival (lead the target): a fixed straight
  // line for the whole leg, recomputed deterministically from (targetStar, tArrive)
  // so no extra state is stored. A zero-proper-motion star recovers the old aim.
  const targetPos = starPosition(target, leg.tArrive);
  const D = distance(targetPos, leg.startPos);
  const dir = D > 0 ? normalize(sub(targetPos, leg.startPos)) : { x: 1, y: 0, z: 0 };
  const T = leg.tArrive - leg.tDepart;
  const a = leg.properAccel;
  const tc = Math.max(0, Math.min(t, leg.tArrive) - leg.tDepart);
  const d = brachDistance(a, D, T, tc);
  const speedAt = (tt: number) => (a * tt) / Math.sqrt(1 + ((a * tt) / C) ** 2);
  const speed = tc <= T / 2 ? speedAt(tc) : speedAt(T - tc);
  return { r: add(leg.startPos, scale(dir, d)), v: scale(dir, speed) };
}

/** Proper (crew) time elapsed since departure at coordinate time t — the dilated
 *  clock the ship's `tau` advances by while on the leg. */
export function interstellarProperTime(leg: InterstellarLeg, t: number): number {
  const T = leg.tArrive - leg.tDepart;
  const a = leg.properAccel;
  const tc = Math.max(0, Math.min(t, leg.tArrive) - leg.tDepart);
  const tauAt = (tt: number) => (C / a) * Math.asinh((a * tt) / C);
  if (tc <= T / 2) return tauAt(tc);
  return 2 * tauAt(T / 2) - tauAt(T - tc); // symmetric deceleration half
}

/** Parent-relative state of a ship sitting on the surface, co-rotating with the
 *  body: the landing-site body-fixed direction is rotated by θ(t)=Ω·t (about the
 *  ecliptic-Z axis — a documented approximation that neglects axial tilt) and the
 *  velocity is ω×r, so the ship moves at SURFACE speed, not orbital speed. */
export function landedRelativeState(ship: Ship, t: number): State {
  const leg = ship.landed!;
  const body = BODY_BY_ID.get(leg.bodyId);
  if (!body) return { r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } };
  const T = body.rotationPeriod ?? 0;
  const om = T !== 0 ? (2 * Math.PI) / T : 0; // signed angular rate (retrograde T < 0)
  const th = om * t;
  const c = Math.cos(th), s = Math.sin(th);
  const d = leg.surfaceDir;
  const r = {
    x: (d.x * c - d.y * s) * body.radius,
    y: (d.x * s + d.y * c) * body.radius,
    z: d.z * body.radius,
  };
  return { r, v: { x: -om * r.y, y: om * r.x, z: 0 } }; // ω × r
}

/**
 * A coasting ship's osculating elements at time t, advanced by Kepler AND by the
 * primary's J2 secular precession (node, apsides, mean anomaly). The J2 rates are
 * constant, so this stays exact at any time-warp — a LEO orbit's node regresses
 * ~5°/day, its plane visibly rotating, with no integration. Spherical primaries
 * (no J2) reduce to plain Kepler.
 */
export function coastElements(ship: Ship, t: number): KeplerElements {
  const mu = primaryMu(ship);
  const dt = t - (ship.epoch ?? 0);
  const el = propagate(ship.elements!, mu, dt);
  const body = BODY_BY_ID.get(ship.primary);
  // Secular precession applies to BOUND orbits only — a hyperbolic mean anomaly is
  // not mod-2π, so it must never be wrapped (and a brief flyby barely precesses).
  if (body?.J2 && el.e < 1) {
    const r = j2Rates(mu, body.radius, body.J2, el.a, el.e, el.i);
    el.Omega = wrapPi(el.Omega + r.nodeDot * dt);
    el.omega = wrapPi(el.omega + r.periDot * dt);
    el.M = wrapPi(el.M + r.anomalyDot * dt);
  }
  return el;
}

/** Osculating (near-circular) elements of a ship mid low-thrust spiral: the
 *  semi-major axis grows linearly with time and the phase follows in closed form
 *  (θ = θ0 + ∫√(μ/a³) dt, integrated exactly for linear a). Exact at any time-warp. */
export function spiralElements(ship: Ship, t: number): KeplerElements {
  const leg = ship.spiral!;
  const mu = primaryMu(ship);
  const tc = Math.max(leg.tStart, Math.min(t, leg.tEnd));
  const span = leg.tEnd - leg.tStart;
  const frac = span > 0 ? (tc - leg.tStart) / span : 1;
  const a = leg.startRadius + (leg.endRadius - leg.startRadius) * frac;
  const k = span > 0 ? (leg.endRadius - leg.startRadius) / span : 0;
  let theta: number;
  if (Math.abs(k) < 1e-9) {
    theta = leg.phase0 + Math.sqrt(mu / (leg.startRadius ** 3)) * (tc - leg.tStart);
  } else {
    theta = leg.phase0 + ((2 * Math.sqrt(mu)) / k) * (1 / Math.sqrt(leg.startRadius) - 1 / Math.sqrt(a));
  }
  return { a, e: 0, i: leg.i, Omega: leg.Omega, omega: 0, M: wrapPi(theta) };
}

/** The nominal blunt-body entry vehicle used by the in-sim pass and the descent
 *  panel — one shared calibration (matches the panel's `entryHeatRows`). */
export const NOMINAL_ENTRY_VEHICLE = { noseRadius: 2, ballisticCoef: DEFAULT_ENTRY_BETA, emissivity: 0.85 };

/** Orbital-plane basis from an interface state: the radial unit êr0 and the in-plane
 *  downrange unit êt0 (the horizontal part of v0), with the entry speed and the
 *  below-horizontal flight-path angle derived from r0,v0. */
function planeBasis(r0: Vec3, v0: Vec3): { er0: Vec3; et0: Vec3; entrySpeed: number; fpa: number } {
  const er0 = normalize(r0);
  const speed = length(v0);
  const vr = dot(v0, er0);
  const horiz = sub(v0, scale(er0, vr));
  let et0: Vec3;
  if (length(horiz) > 1e-6) {
    et0 = normalize(horiz);
  } else {
    // Pure radial entry — pick any in-plane perpendicular to êr0.
    const ref: Vec3 = Math.abs(er0.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    et0 = normalize(cross(cross(er0, ref), er0));
  }
  const fpa = Math.asin(Math.max(-1, Math.min(1, -vr / speed)));
  return { er0, et0, entrySpeed: speed, fpa };
}

/** Reconstruct the body-relative 3D state from a planar entry step (altitude h,
 *  downrange angle θ, speed v, flight-path angle γ) and the orbital-plane basis. */
function reconstructEntry(er0: Vec3, et0: Vec3, R: number, s: { h: number; v: number; gamma: number; theta: number }): State {
  const r = R + s.h;
  const ct = Math.cos(s.theta), st = Math.sin(s.theta);
  const dir = add(scale(er0, ct), scale(et0, st)); // radial direction after sweeping θ
  const tang = add(scale(er0, -st), scale(et0, ct)); // downrange unit = d(dir)/dθ
  const vr = s.v * Math.sin(s.gamma); // γ positive-up: descending ⇒ vr < 0
  const vt = s.v * Math.cos(s.gamma);
  return { r: scale(dir, r), v: add(scale(dir, vr), scale(tang, vt)) };
}

/** Body-relative state of a ship flying an in-sim entry leg at time t. Re-integrates
 *  the planar ballistic trajectory from the fixed interface state to the elapsed time
 *  (deterministic, exact at any warp) and reconstructs the 3D state in the orbital
 *  plane. At/after tEnd it returns the stored exit state (the finalize takes over). */
export function entryLegState(leg: EntryLeg, t: number): State {
  if (t >= leg.tEnd) return { r: leg.exitR, v: leg.exitV };
  const body = BODY_BY_ID.get(leg.bodyId);
  if (!body) return { r: leg.r0, v: leg.v0 };
  const { er0, et0, entrySpeed, fpa } = planeBasis(leg.r0, leg.v0);
  const elapsed = Math.max(0, t - leg.tStart);
  const veh = { ballisticCoef: leg.ballisticCoef, noseRadius: leg.noseRadius, emissivity: leg.emissivity };
  const s = integrateEntryPlanar(body, veh, entrySpeed, fpa, elapsed);
  if (!s) return { r: leg.r0, v: leg.v0 };
  return reconstructEntry(er0, et0, body.radius, s);
}

/** Build a complete entry leg from the interface-crossing state `r0,v0` at `tStart`:
 *  run the fine entry pass for the outcome/duration/peak budget, integrate to the
 *  terminal planar state, and reconstruct the body-relative exit state the finalize
 *  uses. null for an airless body. */
export function buildEntryLeg(
  body: { id: string; radius: number; mu: number; atmosphere?: unknown },
  r0: Vec3, v0: Vec3, tStart: number,
  vehicle: { ballisticCoef: number; noseRadius: number; emissivity: number } = NOMINAL_ENTRY_VEHICLE,
): EntryLeg | null {
  const def = BODY_BY_ID.get(body.id);
  if (!def) return null;
  const { er0, et0, entrySpeed, fpa } = planeBasis(r0, v0);
  const res = entryTrajectory(def, vehicle, { entrySpeed, flightPathAngle: fpa });
  const term = integrateEntryPlanar(def, vehicle, entrySpeed, fpa);
  if (!res || !term) return null;
  const exit = reconstructEntry(er0, et0, def.radius, term);
  return {
    bodyId: body.id, tStart, tEnd: tStart + res.duration, r0, v0,
    ballisticCoef: vehicle.ballisticCoef, noseRadius: vehicle.noseRadius, emissivity: vehicle.emissivity,
    outcome: res.outcome, exitR: exit.r, exitV: exit.v,
    peakDecelG: res.peakDecelG, peakHeatFlux: res.peakHeatFlux, peakWallTemp: res.peakWallTemp, heatLoad: res.heatLoad,
  };
}

/** Live readout of a ship flying an entry leg: altitude/speed and the instantaneous
 *  heating/deceleration, plus the precomputed peak budget and the predicted outcome.
 *  null when the ship is not on an entry leg. */
export interface EntryReadout {
  bodyName: string;
  altitudeM: number;
  speedMS: number;
  currentG: number;
  currentHeatFluxW: number;
  wallTempK: number;
  heatLoad: number;
  progress: number; // 0..1 through the pass
  outcome: "landed" | "captured" | "skip-out";
  peakDecelG: number;
  peakHeatFlux: number;
  peakWallTemp: number;
}
export function shipEntryReadout(ship: Ship, t: number): EntryReadout | null {
  const leg = ship.entryLeg;
  if (!leg) return null;
  const body = BODY_BY_ID.get(leg.bodyId);
  if (!body) return null;
  const { entrySpeed, fpa } = planeBasis(leg.r0, leg.v0);
  const elapsed = Math.max(0, Math.min(t, leg.tEnd) - leg.tStart);
  const veh = { ballisticCoef: leg.ballisticCoef, noseRadius: leg.noseRadius, emissivity: leg.emissivity };
  const s = integrateEntryPlanar(body, veh, entrySpeed, fpa, elapsed)!;
  const span = leg.tEnd - leg.tStart;
  return {
    bodyName: body.name, altitudeM: s.h, speedMS: s.v, currentG: s.decelG,
    currentHeatFluxW: s.q, wallTempK: s.wallTempK, heatLoad: s.heatLoad,
    progress: span > 0 ? elapsed / span : 1, outcome: leg.outcome,
    peakDecelG: leg.peakDecelG, peakHeatFlux: leg.peakHeatFlux, peakWallTemp: leg.peakWallTemp,
  };
}

/** State of the ship relative to its primary (the Earth-centred frame, etc.). */
export function shipRelativeState(ship: Ship, t: number): State {
  if (ship.landed) return landedRelativeState(ship, t);
  if (ship.entryLeg) return entryLegState(ship.entryLeg, t);
  if (ship.interstellarLeg) return interstellarLegState(ship.interstellarLeg, t);
  if (ship.spiral) return elementsToState(spiralElements(ship, t), primaryMu(ship));
  if (ship.mode === "thrust" && ship.r && ship.v) {
    // Linear extrapolation from the integrated state's valid time, so callers
    // that query a different time (the light-lag chase, retarded telemetry) get
    // a moving target rather than a frozen point. Exact at t = epoch; over a
    // one-way light delay the neglected thrust curvature is second-order.
    const dt = t - (ship.epoch ?? t);
    return { r: addScaled(ship.r, ship.v, dt), v: ship.v };
  }
  return elementsToState(coastElements(ship, t), primaryMu(ship));
}

/** Absolute state of the ship in the root (heliocentric) frame. */
export function shipWorldState(ship: Ship, t: number): State {
  const rel = shipRelativeState(ship, t);
  const body = BODY_BY_ID.get(ship.primary)!;
  const primary = bodyState(body, t);
  return { r: add(primary.r, rel.r), v: add(primary.v, rel.v) };
}

/**
 * Apply an impulsive Δv (m/s), consuming propellant per the rocket equation and
 * staging across empty tanks as needed. Returns false if the ship cannot afford
 * the full Δv. Used for interplanetary injections, where the burn is short
 * relative to the months-long transfer and the impulsive idealization is
 * standard (the porkchop Δv is itself an impulsive metric).
 */
export function applyImpulsiveDv(ship: Ship, dv: number): boolean {
  if (dv <= 0) return true;
  // Affordability check FIRST, so a maneuver the ship can't pay for makes no
  // mutation — never fabricate Δv on an empty tank.
  if (dv > dvRemaining(ship) + 1e-6) return false;
  let remaining = dv;
  while (remaining > 1e-9) {
    const stage = activeStage(ship);
    // The affordability gate above already passed (within +1e-6), so running out of
    // stages here means a sub-tolerance rounding remainder, not an unaffordable
    // burn — stop cleanly (return true) rather than NACK after draining the tanks.
    if (!stage) break;
    // Consume from this stage (core + any live boosters) through the same
    // parallel-phase model the affordability check used, so they cannot disagree.
    remaining -= consumeStageDv(stage, totalMass(ship), remaining).dvDelivered;
    // Drop any booster group emptied by this burn.
    if (stage.boosters) stage.boosters = stage.boosters.filter((b) => b.propMass * boosterCount(b) > 1e-9);
    // Advance only when the whole stage (core AND all boosters) is spent; a
    // partial burn leaves it active with `remaining` already ~0.
    if (stage.propMass <= 1e-9 && (stage.boosters?.length ?? 0) === 0) ship.activeStage += 1;
    else break;
  }
  return true;
}

/** The osculating Keplerian orbit the ship is on right now (about its primary).
 *  An interstellar ship is not on a closed orbit; callers should check
 *  ship.interstellarLeg first — this returns a far placeholder to avoid crashing. */
export function shipOsculatingElements(ship: Ship, t: number): KeplerElements {
  if (ship.landed) {
    const b = BODY_BY_ID.get(ship.landed.bodyId);
    return { a: b?.radius ?? 1, e: 0, i: 0, Omega: 0, omega: 0, M: 0 };
  }
  if (ship.interstellarLeg) {
    return { a: length(interstellarLegState(ship.interstellarLeg, t).r), e: 0, i: 0, Omega: 0, omega: 0, M: 0 };
  }
  if (ship.spiral) return spiralElements(ship, t);
  if (ship.entryLeg) {
    const st = entryLegState(ship.entryLeg, t);
    return stateToElements(st.r, st.v, primaryMu(ship));
  }
  const mu = primaryMu(ship);
  if (ship.mode === "thrust" && ship.r && ship.v) {
    // Honour the requested time: linearly extrapolate the integrated state from
    // its epoch (the same acknowledged second-order approximation shipRelativeState
    // uses), so a retarded-time / light-lag query gets the orbit at t, not at epoch.
    const dt = t - (ship.epoch ?? t);
    return stateToElements(addScaled(ship.r, ship.v, dt), ship.v, mu);
  }
  return coastElements(ship, t);
}

// ── Thermal / power / detection ──────────────────────────────────────────────

/** Material parameters are physical. The sensor (NEP/aperture) and the plume
 *  radiated-fraction set only the detection SCALE — a documented calibration —
 *  while the 1/r², T⁴, and √-power relationships are exact. */
const THERMAL_PARAMS = {
  emissivity: 0.9, // hull IR emissivity
  absorptivity: 0.9, // solar absorptivity (albedo = 1 − absorptivity)
  housekeepingW: 2000, // baseline onboard electrical load → radiated by the hull
  driveEfficiency: 0.6, // useful jet fraction; (1−η)/η of the jet is waste heat to reject
  radiatorTempK: 1000, // assumed drive-radiator operating temperature
};
// A reference cooled-IR watching telescope (the radiometer equation: detector NEP,
// integration time τ, an SNR threshold, and the in-beam zodiacal-IR + CMB background
// it integrates against). Once the signal noise is background-dominated the range is
// sky-limited, not detector-limited — a documented calibration; the 1/√ falloff is exact.
const SENSOR: SensorSpec = { ...DEFAULT_SENSOR };

export interface ShipThermal {
  distanceFromSun: number; // m
  solarFlux: number; // W/m² at the ship
  hullArea: number; // m²
  hullTempK: number; // passive equilibrium temperature (NOT driven by thrust)
  thermalSignatureW: number; // hull thermal IR
  reflectedSignatureW: number; // reflected sunlight (the dominant cold-hull channel)
  driveWasteW: number; // drive waste heat that must be radiated (0 when coasting)
  radiatorAreaM2: number; // radiator area to reject driveWaste at radiatorTempK
  signatureW: number; // total detectable emission (thermal + reflected + drive)
  detectionRangeM: number; // range at which signatureW reaches the SNR threshold (m)
  minDetectablePowerW: number; // collected-power floor the sensor needs (W)
  integrationTimeS: number; // τ the detection assumes (s)
  snrThreshold: number; // SNR the detection assumes (σ)
  thrusting: boolean;
}

/**
 * The ship's thermodynamic + detection state. Three independent emitters, not
 * one algebraic identity:
 *  - the HULL radiates its passive load (absorbed sunlight + housekeeping) at an
 *    equilibrium temperature the drive does NOT change (a burning engine does not
 *    cook the hull to thousands of K — its energy leaves elsewhere);
 *  - the hull REFLECTS sunlight (the channel that actually gives away a cold,
 *    shiny hull at 1 AU — so low emissivity is no stealth, it just trades IR for
 *    glint);
 *  - a thrusting DRIVE rejects (1−η)/η of its jet power as waste heat from
 *    radiators (and a bright plume), a separate, large signature.
 * Detection range is set by the total. There is no stealth in space.
 */
export function shipThermalState(ship: Ship, t: number): ShipThermal {
  const { emissivity, absorptivity, housekeepingW, driveEfficiency, radiatorTempK } = THERMAL_PARAMS;
  const r = length(shipWorldState(ship, t).r); // heliocentric distance (Sun at origin)
  const flux = solarFlux(r);
  const A = hullArea(totalMass(ship));
  const cross = A / 4; // mean sun-facing cross-section of a sphere

  // Passive hull balance: absorbed sunlight + housekeeping, radiated over the
  // full hull area. The drive is deliberately excluded.
  const absorbed = flux * cross * absorptivity;
  const hullInput = absorbed + housekeepingW;
  const hullTempK = equilibriumTemp(hullInput, emissivity, A);
  const thermalSignatureW = hullInput; // steady state: radiated = absorbed + generated

  // Reflected sunlight — the optical channel that dominates cold-hull detection.
  const reflectedSignatureW = flux * cross * (1 - absorptivity);

  // Drive waste heat (radiators + plume), only while thrusting.
  let driveWasteW = 0;
  if (ship.mode === "thrust") {
    const stage = activeStage(ship);
    if (stage) {
      const jet = 0.5 * stage.thrust * exhaustVelocity(stage.isp); // ½·F·vₑ
      driveWasteW = (jet * (1 - driveEfficiency)) / driveEfficiency;
    }
  }

  const signatureW = thermalSignatureW + reflectedSignatureW + driveWasteW;
  return {
    distanceFromSun: r,
    solarFlux: flux,
    hullArea: A,
    hullTempK,
    thermalSignatureW,
    reflectedSignatureW,
    driveWasteW,
    radiatorAreaM2: driveWasteW > 0 ? radiatorArea(driveWasteW, radiatorTempK) : 0,
    signatureW,
    detectionRangeM: detectionRange(signatureW, SENSOR),
    minDetectablePowerW: minDetectablePowerW(SENSOR),
    integrationTimeS: SENSOR.integrationTimeS,
    snrThreshold: SENSOR.snrThreshold,
    thrusting: ship.mode === "thrust",
  };
}
