/**
 * Third-body perturbed propagation — the higher-fidelity tier of the engine's
 * explicit fidelity ladder (see `ROADMAP.md` "Higher-fidelity propagation" and
 * `docs/deliberate-omissions.md` §1). The default "game" model coasts a ship as a
 * two-body conic about ONE primary (with patched-conic SOI switches) and so never
 * lets it *continuously* feel a third body — the Sun in Earth orbit, the Moon on a
 * high orbit, sibling moons inside a planet's SOI. This integrates a ship's
 * body-relative state under central gravity + a chosen set of third bodies (and,
 * optionally, the body's J2 zonal term), so those perturbations are actually felt.
 *
 * Like `maneuver/approach.ts` (which this is cloned from), it is a PURE deterministic
 * integrator over a fixed start state: same inputs ⇒ same trajectory, independent of
 * how sim time is chunked. The one structural difference is that a third-body
 * acceleration is TIME-DEPENDENT — each perturber's position is read from the analytic
 * ephemeris at the arc's absolute time `t0 + τ`. Because the ephemeris is itself a
 * closed-form pure function of `t` (`ephemeris.ts bodyState`), the arc stays fully
 * re-derivable and analytic-at-read-time-compatible: we integrate only the SHIP, never
 * the perturbers.
 *
 * Determinism rule (load-bearing): the step size is a pure function of the CURRENT
 * state only (`dt = clamp(STEP_FRACTION·r/v, MIN_STEP, MAX_STEP)`) — never of the
 * horizon. So a short forecast and a long forecast share an identical step sequence on
 * their overlap (the "prefix-invariance" the tests check), and a stored leg replays
 * chunk-invariantly. The horizon only bounds the loop and sets the sample cadence.
 *
 * SI throughout; mu = GM (m³/s²).
 */

import { type Vec3, add, scale, sub, length } from "./math/vec3.ts";
import { BODY_BY_ID } from "./constants.ts";
import { bodyState } from "./ephemeris.ts";
import { centralAccel, j2ZonalAccel, thirdBodyAccel } from "./perturbations.ts";

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };

/** A perturbing body: its id (for the analytic ephemeris) and GM. */
export interface Perturber {
  id: string;
  mu: number;
}

export interface PerturbedState {
  r: Vec3; // body-relative position (m)
  v: Vec3; // body-relative velocity (m/s)
}

/** One sampled point of the perturbed arc; `t` is elapsed seconds since the start
 *  (warp/epoch-independent), so a stored leg replays chunk-invariantly. */
export interface PerturbedSample {
  t: number;
  r: Vec3;
  v: Vec3;
}

export interface PerturbedParams {
  mu: number; // GM of the primary (m³/s²)
  primaryId: string; // primary body id — the frame the state is relative to
  t0: number; // absolute time (s since J2000) at τ = 0
  r0: Vec3; // body-relative state at the start (m)
  v0: Vec3; // body-relative velocity at the start (m/s)
  horizon: number; // seconds to integrate forward
  perturbers: Perturber[]; // third bodies felt continuously (may be empty)
  // Optional numerical J2 zonal term (the high-fidelity tier; omit ⇒ point-mass primary).
  J2?: number;
  Req?: number; // equatorial reference radius for J2 (m)
  pole?: Vec3; // unit spin axis in the inertial frame
}

export interface PerturbedResult {
  samples: PerturbedSample[]; // start … horizon, for the rendered arc + read-time interp
  exitR: Vec3; // body-relative position at exactly `horizon` (interpolated)
  exitV: Vec3; // body-relative velocity at exactly `horizon`
  tEnd: number; // elapsed seconds actually integrated (≥ horizon by < one step)
}

/** Total specific acceleration on a body-relative state `r` at elapsed time `τ`:
 *  central + optional J2 + Σ third-body differential terms (perturbers read from the
 *  analytic ephemeris at absolute time `t0 + τ`, expressed relative to the primary). */
function accelAt(r: Vec3, tau: number, p: PerturbedParams): Vec3 {
  let a = centralAccel(r, p.mu);
  if (p.J2 && p.Req && p.pole) a = add(a, j2ZonalAccel(r, p.mu, p.J2, p.Req, p.pole));
  if (p.perturbers.length > 0) {
    const t = p.t0 + tau;
    const rPrim = bodyState(BODY_BY_ID.get(p.primaryId)!, t).r;
    for (const pert of p.perturbers) {
      const body = BODY_BY_ID.get(pert.id);
      if (!body) continue;
      const rB = sub(bodyState(body, t).r, rPrim); // perturber relative to the primary
      a = add(a, thirdBodyAccel(r, ORIGIN, rB, pert.mu));
    }
  }
  return a;
}

/** One classical RK4 step of size `dt` on the {r, v} state, with a TIME-DEPENDENT
 *  acceleration evaluated at the stage times τ, τ+dt/2, τ+dt. */
function rk4(s: PerturbedState, tau: number, dt: number, p: PerturbedParams): PerturbedState {
  const a = (r: Vec3, tt: number): Vec3 => accelAt(r, tt, p);
  const k1r = s.v, k1v = a(s.r, tau);
  const k2r = add(s.v, scale(k1v, dt / 2)), k2v = a(add(s.r, scale(k1r, dt / 2)), tau + dt / 2);
  const k3r = add(s.v, scale(k2v, dt / 2)), k3v = a(add(s.r, scale(k2r, dt / 2)), tau + dt / 2);
  const k4r = add(s.v, scale(k3v, dt)), k4v = a(add(s.r, scale(k3r, dt)), tau + dt);
  return {
    r: add(s.r, scale(add(add(k1r, scale(k2r, 2)), add(scale(k3r, 2), k4r)), dt / 6)),
    v: add(s.v, scale(add(add(k1v, scale(k2v, 2)), add(scale(k3v, 2), k4v)), dt / 6)),
  };
}

const STEP_FRACTION = 1 / 120; // dt = STEP_FRACTION · r/v — ~hundreds of steps per revolution
const MIN_STEP = 0.5; // s — floor
const MAX_STEP = 6 * 3600; // s — ceiling (bounds overshoot on slow far-out arcs; horizon-INDEPENDENT)
const TARGET_SAMPLES = 240; // arc-render / interpolation resolution
const MAX_STEPS = 4_000_000; // hard guard

/**
 * Integrate a perturbed body-relative arc forward by `horizon` seconds from the start
 * state. The step size depends on the current state only (so the step sequence is a
 * pure function of the start, independent of the horizon); the loop stops one step past
 * the horizon and the exit state is interpolated at exactly `horizon`. With no
 * perturbers and no J2 it reduces to a pure two-body RK4 coast (the oracle the tests
 * check against a Kepler propagation).
 */
export function integratePerturbed(p: PerturbedParams): PerturbedResult {
  let s: PerturbedState = { r: p.r0, v: p.v0 };
  let tau = 0;
  const samples: PerturbedSample[] = [{ t: 0, r: s.r, v: s.v }];
  const sampleEvery = Math.max(MIN_STEP * 4, p.horizon / TARGET_SAMPLES);
  let nextSampleAt = sampleEvery;

  for (let step = 0; step < MAX_STEPS && tau < p.horizon; step++) {
    const R = length(s.r), V = length(s.v);
    const dt = Math.min(MAX_STEP, Math.max(MIN_STEP, (STEP_FRACTION * R) / Math.max(V, 1)));
    s = rk4(s, tau, dt, p);
    tau += dt;
    if (tau >= nextSampleAt || tau >= p.horizon) {
      samples.push({ t: tau, r: s.r, v: s.v });
      nextSampleAt += sampleEvery;
    }
  }
  const exit = perturbedSampleAt(samples, p.horizon);
  return { samples, exitR: exit.r, exitV: exit.v, tEnd: tau };
}

/** Read the perturbed state at elapsed time `tau` (s since start) by linear
 *  interpolation of the stored samples. Pure in (samples, tau) ⇒ chunk-invariant.
 *  (Identical scheme to `approach.ts approachSampleAt`.) */
export function perturbedSampleAt(samples: PerturbedSample[], tau: number): PerturbedState {
  const n = samples.length;
  if (n === 0) return { r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } };
  if (tau <= samples[0]!.t) return { r: samples[0]!.r, v: samples[0]!.v };
  const last = samples[n - 1]!;
  if (tau >= last.t) return { r: last.r, v: last.v };
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

export interface SelectPerturbersOpts {
  /** Drop perturbers whose peak |third-body accel| over the horizon is below this
   *  fraction of the central acceleration at the start radius. Off (0) by default. */
  threshold?: number;
  /** Start radius (m) and horizon (s) used only when `threshold` is set, to score
   *  relevance. */
  r0?: Vec3;
  horizon?: number;
  mu?: number; // primary GM, for the central-accel reference when thresholding
}

/**
 * The third bodies worth feeling for a ship whose primary is `primaryId`, at time `t`:
 * the Sun (unless the primary IS the Sun), the primary's parent, the primary's siblings
 * (other children of that parent), and the primary's own moons (its children). Returned
 * in a FROZEN, id-sorted order so the floating-point summation order is reproducible
 * (determinism). The optional magnitude threshold prunes negligible perturbers; it is
 * OFF by default, so a preview feels everything.
 */
export function selectPerturbers(primaryId: string, t: number, opts: SelectPerturbersOpts = {}): Perturber[] {
  const primary = BODY_BY_ID.get(primaryId);
  if (!primary) return [];
  const ids = new Set<string>();
  if (primaryId !== "sun") ids.add("sun");
  if (primary.parent) {
    ids.add(primary.parent);
    for (const b of BODY_BY_ID.values()) if (b.parent === primary.parent && b.id !== primaryId) ids.add(b.id);
  }
  for (const b of BODY_BY_ID.values()) if (b.parent === primaryId) ids.add(b.id);
  ids.delete(primaryId);

  let list: Perturber[] = [...ids]
    .sort()
    .map((id) => ({ id, mu: BODY_BY_ID.get(id)!.mu }))
    .filter((p) => p.mu > 0);

  const { threshold, r0, horizon, mu } = opts;
  if (threshold && threshold > 0 && r0 && horizon && horizon > 0 && mu && mu > 0) {
    const rMag = Math.max(length(r0), 1);
    const aCentral = mu / (rMag * rMag);
    const rPrimAbs = (tt: number): Vec3 => bodyState(primary, tt).r;
    list = list.filter((p) => {
      const body = BODY_BY_ID.get(p.id)!;
      // Sample the peak differential magnitude over the horizon at a few instants.
      let peak = 0;
      for (let k = 0; k <= 4; k++) {
        const tt = t + (horizon * k) / 4;
        const rB = sub(bodyState(body, tt).r, rPrimAbs(tt));
        peak = Math.max(peak, length(thirdBodyAccel(r0, ORIGIN, rB, p.mu)));
      }
      return peak >= threshold * aCentral;
    });
  }
  return list;
}
