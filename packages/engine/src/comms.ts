/**
 * Light-lag: the defining constraint of the whole game.
 *
 * No signal — command or telemetry — travels faster than c. So you never see
 * the present and you never directly control the distant. The two primitives:
 *
 *  - signalArrival: when a signal emitted now from here reaches a moving target
 *    (light has to chase where the target WILL be).
 *  - retardedTime: the past instant whose light is reaching an observer now, so
 *    the state you actually know of a distant object is its retarded state.
 *
 * Both solve a light-cone intersection — the root of a residual that is strictly
 * monotonic in time (its derivative is 1 ∓ β_radial, and β_radial < 1 for any
 * sub-c target, so the root is unique). We bracket that root and close it with an
 * Illinois (regula-falsi) iteration, which converges superlinearly even when the
 * target moves at a relativistic fraction of c — where the older fixed-point
 * iteration contracted only at rate β_radial and stalled for a ship in transit.
 * Pure SI; the engine knows about propagation delay, not what a message means.
 */

import { C, JULIAN_YEAR } from "./constants.ts";
import { type Vec3, distance } from "./math/vec3.ts";

/** Convergence tolerance on the solved time (s). */
const TOL = 1e-3;
/** Hard cap on solver iterations (Illinois converges in ~10–20). */
const MAX_ITER = 100;
/** Longest light-chase we will solve for. A signal always catches a sub-c target
 *  eventually, but past this horizon the delay is "no contact" for gameplay; a
 *  signal needing longer is reported unreachable (Infinity). */
const MAX_DELAY = 1e7 * JULIAN_YEAR;

/** One-way light-time (s) between two points. */
export function lightTime(a: Vec3, b: Vec3): number {
  return distance(a, b) / C;
}

/**
 * The Doppler factor f_obs/f_emit of a signal sent from `fromPos` (emitter moving
 * at `vEmit`) to `toPos` (observer moving at `vObs`), all in the SAME inertial
 * frame — which is exactly what the whole sim is (heliocentric ecliptic-J2000). So
 * the fully relativistic both-moving form is just the ratio of each body's
 * frequency measured against the global photon, with n̂ the propagation direction
 * (emitter → observer) and β = v/c:
 *
 *   f_obs / f_emit = [γ_obs (1 − n̂·β_obs)] / [γ_emit (1 − n̂·β_emit)],  γ = 1/√(1−β²)
 *
 * < 1 ⇒ redshift (receding), > 1 ⇒ blueshift (approaching). The γ factors carry
 * the TRANSVERSE Doppler, so a torchship crossing the line of sight still reddens
 * by 1/γ even with zero radial speed. Reduces to the classical 1 − v_rel·n̂/c at
 * v ≪ c. Pure SI; |v| is clamped just below c so γ stays finite for a torchship.
 */
export function dopplerFactor(vEmit: Vec3, vObs: Vec3, fromPos: Vec3, toPos: Vec3): number {
  const dx = toPos.x - fromPos.x, dy = toPos.y - fromPos.y, dz = toPos.z - fromPos.z;
  const d = Math.hypot(dx, dy, dz);
  if (d === 0) return 1; // coincident: no line of sight to project onto
  const nx = dx / d, ny = dy / d, nz = dz / d;
  const c2 = C * C;
  // Each body's frequency relative to the global photon: γ(1 − n̂·β).
  const term = (v: Vec3): number => {
    const v2 = v.x * v.x + v.y * v.y + v.z * v.z;
    const gamma = 1 / Math.sqrt(1 - Math.min(v2, c2 * (1 - 1e-12)) / c2);
    const nDotBeta = (nx * v.x + ny * v.y + nz * v.z) / C;
    return gamma * (1 - nDotBeta);
  };
  return term(vObs) / term(vEmit);
}

/** Redshift z = Δλ/λ from a Doppler factor (f_obs/f_emit): z = 1/factor − 1.
 *  z > 0 is a redshift (receding), z < 0 a blueshift (approaching). */
export function redshiftZ(factor: number): number {
  return factor > 0 ? 1 / factor - 1 : Infinity;
}

/** Observed wavelength (m) of an emitted-rest wavelength `lambda` under a Doppler
 *  factor: λ_obs = λ_emit / factor (frequency and wavelength shift inversely). */
export function shiftedWavelength(lambda: number, factor: number): number {
  return factor > 0 ? lambda / factor : Infinity;
}

/**
 * Close a bracket [a, b] with f(a) ≤ 0 ≤ f(b) on the strictly-increasing residual
 * `f` to within TOL in time. Illinois-modified regula falsi: a secant step guarded
 * by the bracket, halving the stale endpoint's value so the bracket always shrinks
 * (avoids the one-sided stalling of plain false position). Superlinear in practice.
 */
function solveBracket(f: (x: number) => number, a: number, fa: number, b: number, fb: number): number {
  let side = 0;
  for (let i = 0; i < MAX_ITER && b - a > TOL; i++) {
    let m = fb !== fa ? b - (fb * (b - a)) / (fb - fa) : 0.5 * (a + b);
    if (!(m > a && m < b)) m = 0.5 * (a + b); // keep the step inside the bracket
    const fm = f(m);
    if (fm === 0) return m;
    if (fm < 0) {
      a = m; fa = fm;
      if (side === -1) fb *= 0.5; // Illinois: shrink the endpoint that hasn't moved
      side = -1;
    } else {
      b = m; fb = fm;
      if (side === 1) fa *= 0.5;
      side = 1;
    }
  }
  return 0.5 * (a + b);
}

/**
 * Time at which a signal emitted at `tEmit` from the fixed point `fromPos` catches
 * the moving target `posFn`. Solves t = tEmit + |posFn(t) − fromPos|/c, i.e. the
 * root of f(t) = (t − tEmit) − |posFn(t) − fromPos|/c (strictly increasing for a
 * sub-c target). Returns Infinity if the target recedes too fast to catch within
 * the contact horizon — the caller's signal that the target is out of reach.
 */
export function signalArrival(fromPos: Vec3, posFn: (t: number) => Vec3, tEmit: number): number {
  const f = (t: number): number => t - tEmit - distance(posFn(t), fromPos) / C;
  const fa = f(tEmit); // = −lightTime to the target's current position ≤ 0
  if (fa >= 0) return tEmit; // already coincident
  // Bracket the root above: f → +∞ for a sub-c target, so expand a light-time hop
  // until f turns non-negative (or we pass the horizon → unreachable).
  let span = Math.max(-fa, TOL); // −fa is the current one-way light-time (s)
  let b = tEmit + span;
  let fb = f(b);
  while (fb < 0) {
    span *= 2;
    if (span > MAX_DELAY) return Infinity;
    b = tEmit + span;
    fb = f(b);
  }
  return solveBracket(f, tEmit, fa, b, fb);
}

/**
 * The retarded time: the past instant whose light reaches `obsPos` at time `t`.
 * Solves tRet = t − |posFn(tRet) − obsPos|/c, i.e. the root of
 * f(x) = (x − t) + |posFn(x) − obsPos|/c (strictly increasing; f(t) ≥ 0 and f → −∞
 * as x → −∞, so a unique past solution always exists). The observer's *known*
 * state of the target is the target's state at this retarded time.
 */
export function retardedTime(obsPos: Vec3, posFn: (t: number) => Vec3, t: number): number {
  const f = (x: number): number => x - t + distance(posFn(x), obsPos) / C;
  const fb = f(t); // = +lightTime to the target's current position ≥ 0
  if (fb <= 0) return t; // coincident
  // Bracket the root below: step back a light-time hop until f turns non-positive.
  let span = fb; // current one-way light-time (s)
  let a = t - span;
  let fa = f(a);
  while (fa > 0) {
    span *= 2;
    if (span > MAX_DELAY) break; // monotonicity guarantees a sign change well before
    a = t - span;
    fa = f(a);
  }
  return solveBracket(f, a, fa, t, fb);
}
