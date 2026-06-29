/**
 * J2-perturbed planetary approach — what an oblate body does to a single inbound
 * hyperbolic pass on the way to periapsis.
 *
 * The secular J2 model (orbit.ts `j2Rates`) is the orbit-AVERAGED drift of a BOUND
 * orbit and is identically zero on a hyperbola — it cannot describe a one-shot
 * flyby/capture approach. The real effect is the NON-secular perturbation integrated
 * along the open arc: at an oblate giant the periapsis a fast pass actually reaches
 * differs from the two-body `a(1−e)` by hundreds of km, and the sign/size depend on
 * the approach's inclination to the body's equator (it passes through zero near the
 * ~55° critical inclination). So this integrates the pass directly.
 *
 * Like `entry.ts`, this is a pure deterministic integrator over a fixed start
 * (the SOI-entry state): same inputs ⇒ same trajectory, independent of how sim time
 * is chunked. The acceleration is the point-mass term plus the J2 zonal term
 * referenced to the body's spin POLE `n` (a unit vector in the inertial frame —
 * ships.ts `spinAxis`, the same pole the globe rotates about):
 *
 *   a = −μ r̂/r² − (3 J2 μ Rₑ²)/(2 r⁴) · [ (1 − 5σ²) r̂ + 2σ n ],   σ = (r·n)/r
 *
 * (σ = sin of the latitude above the equator; the bracket reduces to the textbook
 * cartesian J2 acceleration when n = ẑ). SI throughout; μ = GM, Rₑ = equatorial radius.
 */

import { type Vec3, add, sub, scale, dot, length } from "../math/vec3.ts";

export interface ApproachState {
  r: Vec3; // body-relative position (m)
  v: Vec3; // body-relative velocity (m/s)
}

/** One sampled point of the approach arc; `t` is elapsed seconds since SOI entry
 *  (warp/epoch-independent), so a stored leg replays chunk-invariantly. */
export interface ApproachSample {
  t: number;
  r: Vec3;
  v: Vec3;
}

export interface J2ApproachResult {
  tPeri: number; // elapsed s from SOI entry to periapsis (closest approach)
  peri: ApproachState; // body-relative state at periapsis — sizes the capture burn
  periR: number; // |peri.r| (m)
  samples: ApproachSample[]; // SOI entry … periapsis, for the rendered arc + read-time interp
}

export interface J2ApproachParams {
  mu: number; // GM of the body (m³/s²)
  J2: number; // zonal harmonic (0 ⇒ pure two-body)
  Req: number; // equatorial reference radius for J2 (m)
  pole: Vec3; // unit spin axis in the inertial frame
  r0: Vec3; // body-relative state at SOI entry (m)
  v0: Vec3; // body-relative velocity at SOI entry (m/s)
}

/** Point-mass + J2 acceleration referenced to the (unit) pole `n`. */
function accel(r: Vec3, mu: number, J2: number, Req: number, n: Vec3): Vec3 {
  const R = length(r);
  const grav = scale(r, -mu / (R * R * R));
  if (!J2) return grav;
  const sigma = dot(r, n) / R;
  const c = (-1.5 * J2 * mu * Req * Req) / (R * R * R * R);
  const rHat = scale(r, 1 / R);
  const aJ2 = add(scale(rHat, c * (1 - 5 * sigma * sigma)), scale(n, c * 2 * sigma));
  return add(grav, aJ2);
}

/** One classical RK4 step of size `dt` on the {r, v} state. */
function rk4(s: ApproachState, dt: number, p: J2ApproachParams): ApproachState {
  const a = (r: Vec3): Vec3 => accel(r, p.mu, p.J2, p.Req, p.pole);
  const k1r = s.v, k1v = a(s.r);
  const k2r = add(s.v, scale(k1v, dt / 2)), k2v = a(add(s.r, scale(k1r, dt / 2)));
  const k3r = add(s.v, scale(k2v, dt / 2)), k3v = a(add(s.r, scale(k2r, dt / 2)));
  const k4r = add(s.v, scale(k3v, dt)), k4v = a(add(s.r, scale(k3r, dt)));
  return {
    r: add(s.r, scale(add(add(k1r, scale(k2r, 2)), add(scale(k3r, 2), k4r)), dt / 6)),
    v: add(s.v, scale(add(add(k1v, scale(k2v, 2)), add(scale(k3v, 2), k4v)), dt / 6)),
  };
}

const STEP_FRACTION = 1 / 600; // dt = STEP_FRACTION · r/v: tightens near periapsis, coarse far out
const MIN_STEP = 0.5; // s
const TARGET_SAMPLES = 80; // arc-render resolution
const MAX_STEPS = 4_000_000; // hard guard

/**
 * Integrate a J2-perturbed inbound hyperbolic approach from SOI entry to periapsis.
 * The step is state-adaptive (∝ r/v) so it is fine at the fast periapsis and coarse
 * in the slow outer arc; the periapsis instant is refined by bisection on the radial
 * rate r·v = 0. Deterministic in the start state ⇒ chunk-invariant when the result
 * is stored once and replayed. With J2 = 0 it recovers the two-body periapsis (the
 * oracle the tests check).
 */
export function j2Approach(p: J2ApproachParams): J2ApproachResult {
  let s: ApproachState = { r: p.r0, v: p.v0 };
  let t = 0;
  const samples: ApproachSample[] = [{ t, r: s.r, v: s.v }];
  // Sample cadence from a rough total-time estimate (outer arc dominates the clock).
  const sampleEvery = Math.max(MIN_STEP * 4, (length(p.r0) / Math.max(length(p.v0), 1)) / TARGET_SAMPLES);
  let nextSampleAt = sampleEvery;
  let prevRdot = dot(s.r, s.v);

  for (let step = 0; step < MAX_STEPS; step++) {
    const R = length(s.r), V = length(s.v);
    const dt = Math.max(MIN_STEP, (STEP_FRACTION * R) / Math.max(V, 1));
    const next = rk4(s, dt, p);
    const rdot = dot(next.r, next.v);

    if (prevRdot < 0 && rdot >= 0) {
      // Periapsis lies within this step — bisect the sub-step on r·v = 0.
      let lo = 0, hi = dt, sm = next;
      for (let i = 0; i < 48; i++) {
        const mid = (lo + hi) / 2;
        sm = rk4(s, mid, p);
        if (dot(sm.r, sm.v) < 0) lo = mid;
        else hi = mid;
      }
      const tPeri = t + (lo + hi) / 2;
      samples.push({ t: tPeri, r: sm.r, v: sm.v });
      return { tPeri, peri: { r: sm.r, v: sm.v }, periR: length(sm.r), samples };
    }

    t += dt;
    s = next;
    prevRdot = rdot;
    if (t >= nextSampleAt) {
      samples.push({ t, r: s.r, v: s.v });
      nextSampleAt += sampleEvery;
    }
  }
  // Degenerate (never reached periapsis within the guard) — treat the last state as the end.
  return { tPeri: t, peri: { r: s.r, v: s.v }, periR: length(s.r), samples };
}

/** Read the approach state at elapsed time `tau` (s since SOI entry) by linear
 *  interpolation of the stored samples. Pure in (samples, tau) ⇒ chunk-invariant. */
export function approachSampleAt(samples: ApproachSample[], tau: number): ApproachState {
  const n = samples.length;
  if (n === 0) return { r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } };
  if (tau <= samples[0]!.t) return { r: samples[0]!.r, v: samples[0]!.v };
  const last = samples[n - 1]!;
  if (tau >= last.t) return { r: last.r, v: last.v };
  // Binary search for the bracketing pair.
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.t <= tau) lo = mid;
    else hi = mid;
  }
  const a = samples[lo]!, b = samples[hi]!;
  const f = (tau - a.t) / Math.max(b.t - a.t, 1e-9);
  return {
    r: add(a.r, scale(sub(b.r, a.r), f)),
    v: add(a.v, scale(sub(b.v, a.v), f)),
  };
}
