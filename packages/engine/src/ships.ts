/**
 * Helpers that turn the raw Ship record into physical quantities: its current
 * mass (which falls as propellant burns and stages drop), its state about its
 * primary, its absolute state in the root frame, and the osculating orbit it is
 * currently on — coasting or mid-burn.
 */

import { type Ship, type InterstellarLeg, type EntryLeg, type LaunchLeg, type DescentLeg, type PoweredSample, type ApproachLeg } from "./world.ts";
import { type Stage, deltaVBudget, stageWetMass, consumeStageDv, boosterCount, liveJetPowerW } from "./propulsion.ts";
import {
  type State,
  type KeplerElements,
  elementsToState,
  stateToElements,
  propagate,
  meanMotion,
  wrapPi,
} from "./math/kepler.ts";
import { j2Rates, circularSpeed } from "./orbit.ts";
import { bodyState } from "./ephemeris.ts";
import { retardedTime, dopplerFactor, redshiftZ } from "./comms.ts";
import { STAR_BY_ID, starPosition } from "./stars.ts";
import { BODY_BY_ID, C, DEG, j2RefRadius, type BodyDef } from "./constants.ts";
import { type Vec3, add, addScaled, sub, scale, dot, cross, normalize, length, distance } from "./math/vec3.ts";
import { integrateEntryPlanar, entryTrajectory } from "./maneuver/entry.ts";
import { j2Approach, approachSampleAt } from "./maneuver/approach.ts";
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

/** Signed diurnal rate Ω (rad/s) of a body's spin; negative ⇒ retrograde, 0 if it
 *  has no rotation period. */
export function bodySpinRate(body: BodyDef): number {
  const T = body.rotationPeriod ?? 0;
  return T !== 0 ? (2 * Math.PI) / T : 0;
}

/** The body's spin axis (unit) in the inertial/ecliptic frame: ecliptic +Z tilted by
 *  the obliquity about +X — the SAME tilt the renderer applies to the globe (the node
 *  rotation in render/bodyViews), so physics and graphics share one pole. */
export function spinAxis(body: BodyDef): Vec3 {
  const e = (body.obliquityDeg ?? 0) * DEG;
  return { x: 0, y: -Math.sin(e), z: Math.cos(e) };
}

/** The body's surface angular-velocity vector ω = Ω·n̂ (n̂ = spin axis). A point at
 *  parent-relative position r co-rotates with the surface at v = ω × r. */
export function surfaceAngularVelocity(body: BodyDef): Vec3 {
  return scale(spinAxis(body), bodySpinRate(body));
}

/** Map a BODY-FIXED surface direction to its inertial (parent-relative) unit direction
 *  at time t: spin it by θ=Ω·t about the pole, then tilt the equator into the ecliptic
 *  by the obliquity (about +X). The inverse is `inertialDirToSurface`. */
export function surfaceDirToInertial(body: BodyDef, d: Vec3, t: number): Vec3 {
  const th = bodySpinRate(body) * t;
  const c = Math.cos(th), s = Math.sin(th);
  // Diurnal spin about the (untilted) pole.
  const ax = d.x * c - d.y * s, ay = d.x * s + d.y * c, az = d.z;
  // Tilt the equatorial frame into the ecliptic by the obliquity (about +X).
  const e = (body.obliquityDeg ?? 0) * DEG;
  const ce = Math.cos(e), se = Math.sin(e);
  return { x: ax, y: ay * ce - az * se, z: ay * se + az * ce };
}

/** Inverse of `surfaceDirToInertial`: recover the BODY-FIXED surface direction from an
 *  inertial (parent-relative) unit direction at time t — untilt by the obliquity, then
 *  de-spin by θ=Ω·t. Used when a touchdown/impact site is captured and stored. */
export function inertialDirToSurface(body: BodyDef, u: Vec3, t: number): Vec3 {
  // Untilt the ecliptic into the equatorial frame (about +X).
  const e = (body.obliquityDeg ?? 0) * DEG;
  const ce = Math.cos(e), se = Math.sin(e);
  const ax = u.x, ay = u.y * ce + u.z * se, az = -u.y * se + u.z * ce;
  // De-spin by the body's rotation angle so the site is stored body-fixed.
  const th = bodySpinRate(body) * t;
  const c = Math.cos(th), s = Math.sin(th);
  return { x: ax * c + ay * s, y: -ax * s + ay * c, z: az };
}

/** Parent-relative state of a ship sitting on the surface, co-rotating with the body:
 *  the landing-site body-fixed direction is carried to its inertial position about the
 *  body's TILTED pole (matching the rendered globe) and the velocity is ω×r, so the ship
 *  moves at SURFACE speed, not orbital speed — and stays put on the turning surface. */
export function landedRelativeState(ship: Ship, t: number): State {
  const leg = ship.landed!;
  const body = BODY_BY_ID.get(leg.bodyId);
  if (!body) return { r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } };
  const r = scale(surfaceDirToInertial(body, leg.surfaceDir, t), body.radius);
  return { r, v: cross(surfaceAngularVelocity(body), r) }; // ω × r
}

/**
 * A coasting ship's osculating elements at time t, advanced by Kepler AND by the
 * primary's J2 secular precession (node, apsides, mean anomaly), and — for a ship
 * carrying a `drag` term that is NOT station-kept — by a constant-rate secular
 * atmospheric decay. Every rate here is constant, so this stays exact at any
 * time-warp — a LEO orbit's node regresses ~5°/day, its plane visibly rotating, with
 * no integration. Spherical primaries (no J2) and drag-free orbits reduce to plain
 * Kepler.
 */
export function coastElements(ship: Ship, t: number): KeplerElements {
  const mu = primaryMu(ship);
  const dt = t - (ship.epoch ?? 0);
  const el = propagate(ship.elements!, mu, dt);
  const body = BODY_BY_ID.get(ship.primary);
  // Secular precession applies to BOUND orbits only — a hyperbolic mean anomaly is
  // not mod-2π, so it must never be wrapped (and a brief flyby barely precesses).
  if (body?.J2 && el.e < 1) {
    const r = j2Rates(mu, j2RefRadius(body), body.J2, el.a, el.e, el.i);
    el.Omega = wrapPi(el.Omega + r.nodeDot * dt);
    el.omega = wrapPi(el.omega + r.periDot * dt);
    el.M = wrapPi(el.M + r.anomalyDot * dt);
  }
  // Secular atmospheric drag (rung-1): a constant ṅ advances the along-track angle
  // by ½·ṅ·dt² and shrinks the orbit consistently — n(t) = n0 + ṅ·dt, and n²a³ = μ
  // gives a = a0·(n0/n)^⅔. Bound orbits only (an unbound flyby is not drag-modelled).
  // SUPPRESSED for a station-kept orbit: its altitude is held against drag, so it
  // coasts on Kepler+J2 instead of spiralling in / ballooning out far past epoch.
  if (ship.drag && !ship.stationKept && el.e < 1) {
    const { nDot } = ship.drag;
    el.M = wrapPi(el.M + 0.5 * nDot * dt * dt);
    const n0 = meanMotion(el.a, mu);
    const n = n0 + nDot * dt;
    if (n > 0) el.a = el.a * Math.pow(n0 / n, 2 / 3);
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

/** Linearly interpolate a powered ascent/descent spline at `elapsed` seconds since the
 *  leg started, returning the planar `{h, v, gamma, theta}` `reconstructEntry` consumes.
 *  Binary search (O(log n)); clamps to the endpoints outside the sampled range. */
function sampleSpline(samples: PoweredSample[], elapsed: number): { h: number; v: number; gamma: number; theta: number } {
  const n = samples.length;
  if (n === 0) return { h: 0, v: 0, gamma: 0, theta: 0 };
  const first = samples[0]!;
  if (elapsed <= first.t) return { h: first.h, v: first.v, gamma: first.gamma, theta: first.theta };
  const last = samples[n - 1]!;
  if (elapsed >= last.t) return { h: last.h, v: last.v, gamma: last.gamma, theta: last.theta };
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.t <= elapsed) lo = mid;
    else hi = mid;
  }
  const a = samples[lo]!, b = samples[hi]!;
  const span = b.t - a.t;
  const f = span > 0 ? (elapsed - a.t) / span : 0;
  return {
    h: a.h + (b.h - a.h) * f,
    v: a.v + (b.v - a.v) * f,
    gamma: a.gamma + (b.gamma - a.gamma) * f,
    theta: a.theta + (b.theta - a.theta) * f,
  };
}

/** Body-relative state of a ship flying an in-sim powered ascent (LaunchLeg) or descent
 *  (DescentLeg) at time t. Interpolates the precomputed spline and reconstructs the 3D
 *  state in the launch/descent plane (the exact `planeBasis`/`reconstructEntry` geometry
 *  the entry leg uses). At/after tEnd it returns the PINNED exit state (the finalize takes
 *  over). Read-time deterministic and exact at any time-warp (the spline is fixed at commit,
 *  so the read at t is independent of how the sim was stepped there). */
export function poweredLegState(leg: LaunchLeg | DescentLeg, t: number): State {
  if (t >= leg.tEnd) return { r: leg.exitR, v: leg.exitV };
  const body = BODY_BY_ID.get(leg.bodyId);
  if (!body) return { r: leg.r0, v: leg.v0 };
  const { er0, et0 } = planeBasis(leg.r0, leg.v0);
  const s = sampleSpline(leg.samples, Math.max(0, t - leg.tStart));
  return reconstructEntry(er0, et0, body.radius, s);
}

/** Body-relative state of a ship flying an in-sim J2-perturbed approach (ApproachLeg) at
 *  time t. Interpolates the precomputed 3D arc spline (sampled once at SOI entry); at/after
 *  tEnd it returns the PINNED periapsis state (the capture finalize takes over). Read-time
 *  deterministic and exact at any time-warp — the spline is fixed at commit, so the read at
 *  t is independent of how the sim was stepped there. */
export function approachLegState(leg: ApproachLeg, t: number): State {
  if (t >= leg.tEnd) return { r: leg.exitR, v: leg.exitV };
  return approachSampleAt(leg.samples, Math.max(0, t - leg.tStart));
}

/** Build a J2-perturbed approach leg from the SOI-entry state `r0,v0` (body-relative) at
 *  `tStart`: integrate the inbound hyperbola ONCE under the body's J2 (referenced to its
 *  spin pole) to periapsis, and carry the 3D arc spline + pinned periapsis state. Returns
 *  null for a spherical body (no J2) — that arrival stays a pure-Kepler coast. The SAME
 *  `j2Approach` integrator backs the arrival aim, so the flown periapsis matches the aim. */
export function buildApproachLeg(body: BodyDef, r0: Vec3, v0: Vec3, tStart: number): ApproachLeg | null {
  if (!body.J2) return null;
  const res = j2Approach({ mu: body.mu, J2: body.J2, Req: j2RefRadius(body), pole: spinAxis(body), r0, v0 });
  return {
    bodyId: body.id, tStart, tEnd: tStart + res.tPeri, r0, v0,
    samples: res.samples, exitR: res.peri.r, exitV: res.peri.v,
  };
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

/** The arc-end (downrange) radial & tangential unit vectors in the launch/descent plane,
 *  given the plane basis and the spline's final downrange angle θ. The leg's pinned exit
 *  is placed along these so the visual arc connects seamlessly to the finalize state. */
function arcEndFrame(er0: Vec3, et0: Vec3, theta: number): { dir: Vec3; tang: Vec3 } {
  const ct = Math.cos(theta), st = Math.sin(theta);
  return { dir: add(scale(er0, ct), scale(et0, st)), tang: add(scale(er0, -st), scale(et0, ct)) };
}

/** Build a powered ASCENT leg from the liftoff state `r0,v0` at `tStart`. The `samples`
 *  spline (from `ascentBudget`, h ∈ [0, natural-insertion]) is rescaled in altitude so the
 *  arc climbs to the requested `parkingAlt` (the budget's impulsive Hohmann raise shown as a
 *  continuous climb), and the exit is PINNED to a clean circular parking-orbit insertion at
 *  the arc's downrange end — so the visual arc connects seamlessly to the post-arc orbit. */
export function buildLaunchLeg(
  body: BodyDef,
  r0: Vec3, v0: Vec3, parkingAlt: number, tStart: number, burnTime: number, samples: PoweredSample[],
): LaunchLeg {
  const insAlt = samples[samples.length - 1]!.h; // natural gravity-turn insertion altitude
  const hScale = parkingAlt / Math.max(insAlt, 1);
  for (const s of samples) s.h *= hScale;
  const { er0, et0 } = planeBasis(r0, v0);
  const { dir, tang } = arcEndFrame(er0, et0, samples[samples.length - 1]!.theta);
  const rEnd = body.radius + parkingAlt;
  return {
    bodyId: body.id, tStart, tEnd: tStart + burnTime, r0, v0, samples,
    exitR: scale(dir, rEnd), exitV: scale(tang, circularSpeed(body.mu, rEnd)),
  };
}

/** Build a powered DESCENT leg (airless bodies) from the orbital state `r0,v0` at `tStart`.
 *  The `samples` spline (from `descentBudget`, the time-reversed ascent, h ∈ [0, insertion])
 *  is rescaled so the arc starts at the actual parking altitude and ends at the surface; the
 *  exit is PINNED to the co-rotating touchdown site at the arc's downrange end. The finalize
 *  (`land-arrive`) de-rotates `exitR` to the body-fixed landing site. */
export function buildDescentLeg(
  body: BodyDef,
  r0: Vec3, v0: Vec3, tStart: number, burnTime: number, samples: PoweredSample[],
): DescentLeg {
  const parkingAlt = length(r0) - body.radius;
  const startAlt = samples[0]!.h; // the descent begins at the ascent's natural insertion alt
  const hScale = parkingAlt / Math.max(startAlt, 1);
  for (const s of samples) s.h *= hScale;
  const { er0, et0 } = planeBasis(r0, v0);
  const { dir } = arcEndFrame(er0, et0, samples[samples.length - 1]!.theta);
  const exitR = scale(dir, body.radius); // touchdown on the surface
  const exitV = cross(surfaceAngularVelocity(body), exitR); // ω × r — surface co-rotation
  return { bodyId: body.id, tStart, tEnd: tStart + burnTime, r0, v0, samples, exitR, exitV };
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
  outcome: "landed" | "captured" | "skip-out" | "crashed";
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
  if (ship.launchLeg) return poweredLegState(ship.launchLeg, t);
  if (ship.descentLeg) return poweredLegState(ship.descentLeg, t);
  if (ship.landed) return landedRelativeState(ship, t);
  if (ship.entryLeg) return entryLegState(ship.entryLeg, t);
  if (ship.approachLeg) return approachLegState(ship.approachLeg, t);
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

/** The Doppler readout for the telemetry a control node receives from a ship NOW. */
export interface TelemetryDoppler {
  factor: number; // f_obs / f_emit (< 1 redshift, > 1 blueshift)
  z: number; // redshift z = Δλ/λ = 1/factor − 1
  retardedTime: number; // the (past) emission time whose light arrives now
  lightDelay: number; // one-way light delay of this telemetry (s)
}

/**
 * The Doppler shift of the telemetry a `controlNodeId` body observes from `ship`
 * at the current time `t` — a pure read-time quantity (no world mutation, nothing
 * serialized). The signal arriving now left the ship at its RETARDED time, so the
 * shift is set by the ship's velocity THEN against the control node's velocity NOW,
 * projected on the (retarded) line of sight. For an in-system ship the shift is
 * ~1e-6 (orbital speeds); for an accelerating torchship it is dramatic and inverts
 * sign at the flip. Returns null if the body is unknown or the ship is out of
 * contact (light cannot bridge the gap within the contact horizon).
 */
export function shipTelemetryDoppler(ship: Ship, controlNodeId: string, t: number): TelemetryDoppler | null {
  const control = BODY_BY_ID.get(controlNodeId);
  if (!control) return null;
  const obs = bodyState(control, t); // observer (control node) state at reception
  const tRet = retardedTime(obs.r, (tt) => shipWorldState(ship, tt).r, t);
  if (!isFinite(tRet)) return null;
  const emit = shipWorldState(ship, tRet); // ship state at emission
  const factor = dopplerFactor(emit.v, obs.v, emit.r, obs.r);
  return { factor, z: redshiftZ(factor), retardedTime: tRet, lightDelay: t - tRet };
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
  if (ship.launchLeg) {
    const st = poweredLegState(ship.launchLeg, t);
    return stateToElements(st.r, st.v, primaryMu(ship));
  }
  if (ship.descentLeg) {
    const st = poweredLegState(ship.descentLeg, t);
    return stateToElements(st.r, st.v, primaryMu(ship));
  }
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
  if (ship.approachLeg) {
    const st = approachLegState(ship.approachLeg, t);
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

  // Drive waste heat (radiators + plume), only while thrusting. Uses the SAME live
  // engine set the burn integrator flies — the core's distance-derated thrust (a
  // solar-electric drive far from the Sun is power-starved and radiates less, not the
  // full rated heat) plus every live strap-on booster — via `liveJetPowerW`.
  let driveWasteW = 0;
  if (ship.mode === "thrust") {
    const stage = activeStage(ship);
    if (stage) driveWasteW = (liveJetPowerW(stage, r) * (1 - driveEfficiency)) / driveEfficiency;
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
