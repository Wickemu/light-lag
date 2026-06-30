/**
 * Forecast a ship's near-future world path for the live trajectory overlay.
 *
 * The renderer used to draw a ship's path as the *closed* osculating ellipse
 * about its current primary — so it looked frozen while coasting and snapped to a
 * different conic at every patched-conic event (depart → SOI crossing → capture),
 * and hyperbolic/escape legs were not drawn at all. Instead we sample the ship's
 * actual world position forward in time from `shipWorldState` — the SAME function
 * that places the marker — over a horizon capped at the ship's NEXT scheduled
 * event.
 *
 * Why this removes the "snap": the drawn arc is the live state, continuous in
 * world space, and stops exactly where the current leg stops being valid (the
 * next event). When the event fires, the next frame re-samples against the new
 * leg from the same world position — nothing jumps. A bound orbit with no pending
 * event samples one full revolution, recovering the familiar closed ellipse; a
 * hyperbolic or transfer leg becomes the swept arc it actually flies.
 *
 * Pure and analytic (no THREE, no mutation): exact at any time-warp.
 */

import { type Ship } from "./world.ts";
import { type Vec3, sub, length } from "./math/vec3.ts";
import { period } from "./math/kepler.ts";
import { shipRelativeState, shipOsculatingElements, primaryMu, spinAxis } from "./ships.ts";
import { BODY_BY_ID, MU_SUN, j2RefRadius } from "./constants.ts";
import { bodyState, bodyElements, bodyStateRelative } from "./ephemeris.ts";
import { soiRadius } from "./orbit.ts";
import { thirdBodyAccel } from "./perturbations.ts";
import { integratePerturbed, selectPerturbers, type Perturber } from "./perturbed.ts";

export interface SampledPath {
  /** Points relative to `primary`, in metres, ordered tail → head → horizon.
   *  Relative (not world) so the renderer can anchor the arc at the primary's
   *  CURRENT position — a bound ellipse then reads as a clean frozen loop instead
   *  of smearing into a cycloid as the primary drifts over the horizon. */
  points: Vec3[];
  /** The body id the points are relative to (the ship's primary). */
  primary: string;
  /** Parallel sample times (s since J2000). */
  times: number[];
  /** Index of the sample at the ship's current position (the comet-tail head). */
  headIndex: number;
  /** True when a full bound period was sampled (the arc closes on the ship). */
  closed: boolean;
}

export interface ForecastOpts {
  /** Earliest scheduled event time for this ship; caps the forward horizon. */
  nextEventT?: number;
  /** Hard forward cap for unbound (hyperbolic/escape) legs (s). */
  lookahead?: number;
  /** Forward cap while thrusting — the integrated path is only linearly known. */
  thrustLookahead?: number;
  /** Trailing past arc as a fraction of the forward span (grounding the tail). */
  backFraction?: number;
  /** Total sample intervals (points = segments + 1). */
  segments?: number;
}

const DEFAULT_LOOKAHEAD = 2 * 365.25 * 86400; // ~2 yr — generous for an open arc
const DEFAULT_THRUST_LOOKAHEAD = 3600; // 1 hr of straight-line thrust direction
const DEFAULT_SEGMENTS = 256;
const DEFAULT_BACK_FRACTION = 0.18;

/**
 * Sample a ship's forecast path at time t. Returns null for ships that have no
 * meaningful conic to draw here (landed, or on an interstellar leg — the latter
 * keeps its bespoke star-shell streak in the ship view).
 */
export function shipForecastPath(ship: Ship, t: number, opts: ForecastOpts = {}): SampledPath | null {
  if (ship.landed || ship.interstellarLeg) return null;

  const nextEventT = opts.nextEventT ?? Infinity;
  const lookahead = opts.lookahead ?? DEFAULT_LOOKAHEAD;
  const thrustLookahead = opts.thrustLookahead ?? DEFAULT_THRUST_LOOKAHEAD;
  const segments = opts.segments ?? DEFAULT_SEGMENTS;
  const backFraction = opts.backFraction ?? DEFAULT_BACK_FRACTION;

  const mu = primaryMu(ship);
  const el = shipOsculatingElements(ship, t);
  const thrusting = ship.mode === "thrust";
  // During thrust the forward state is a linear extrapolation, not the true
  // curved burn, so treat it as a short straight look-ahead rather than a period.
  const bound = !thrusting && el.e < 1 && el.a > 0;
  const per = bound ? period(el.a, mu) : Infinity;
  const fwdCap = thrusting ? thrustLookahead : bound ? per : lookahead;

  // Forward horizon: stop at the next event (where the conic changes) or the cap.
  let tEnd = Math.min(nextEventT, t + fwdCap);
  if (tEnd < t) tEnd = t; // never go backwards if a stale event sits in the past
  const fwd = tEnd - t;
  const fullPeriod = bound && tEnd >= t + per - 1;

  // A trailing past arc grounds the motion — but never for a full closed period
  // (the forward sweep already returns to the ship) and never before the current
  // leg began (else we'd draw a coast tail behind a ship that just departed).
  const legStart = ship.epoch ?? -Infinity;
  const back = fullPeriod ? 0 : Math.max(0, Math.min(backFraction * fwd, t - legStart));
  const tStart = t - back;

  const span = tEnd - tStart;
  if (span <= 0) return null; // event imminent and no tail — nothing to draw this frame

  const points: Vec3[] = new Array(segments + 1);
  const times: number[] = new Array(segments + 1);
  for (let k = 0; k <= segments; k++) {
    const tk = tStart + (span * k) / segments;
    points[k] = shipRelativeState(ship, tk).r;
    times[k] = tk;
  }
  const headIndex = Math.round(((t - tStart) / span) * segments);
  return { points, primary: ship.primary, times, headIndex, closed: fullPeriod };
}

const DEFAULT_FORECAST_HORIZON = 30 * 86400; // 30 days — generous to expose a slow third-body drift

/** Per-perturber peak differential (tidal) acceleration over a forecast arc. */
export interface PerturberContribution {
  id: string;
  peakAccel: number; // peak |third-body differential accel| over the arc (m/s²)
}

/** A higher-fidelity forecast of a ship's path under continuous third-body (and
 *  optional numerical-J2) perturbations — the "perturbed" / "high-fidelity planning"
 *  tier of the fidelity ladder. Pure read-time and analytic (the perturbers are read
 *  from the analytic ephemeris); it NEVER mutates `WorldState`. */
export interface PerturbedForecast {
  /** The perturbed arc as a renderer-ready path (relative points, like the two-body
   *  `shipForecastPath`), so the overlay can draw it alongside the game-model arc. */
  path: SampledPath;
  /** |perturbed − game-model coast| at the horizon (m): how far the true perturbed
   *  trajectory ends from where the default two-body + secular-J2 model predicts —
   *  i.e. how much fidelity the higher tier buys here. */
  divergenceAtHorizon: number;
  /** Per-perturber peak differential acceleration over the arc, dominant first. */
  perturbers: PerturberContribution[];
  /** Elapsed seconds actually forecast (clamped below the requested horizon if the arc
   *  reaches the primary's SOI boundary). */
  horizon: number;
  /** True when the horizon was clamped because the arc left the primary's SOI (a
   *  patched-conic boundary the continuous model cannot honour). */
  clampedAtSoi: boolean;
}

export interface PerturbedForecastOpts {
  /** Override the auto-selected perturber set (`selectPerturbers`). */
  perturbers?: Perturber[];
  /** Include the body's numerical J2 zonal term (default: true when the body has J2). */
  includeJ2?: boolean;
}

/**
 * Forecast a coasting ship's path under continuous third-body perturbations, for the
 * preview overlay and the "how wrong is the two-body coast here" readout. Returns null
 * for ships with no plain coasting conic to perturb (landed, thrusting, on an
 * interstellar / entry / approach / powered / spiral leg). Seeds from the SAME
 * `shipRelativeState` that places the marker, integrates with `integratePerturbed`, and
 * compares the result to the engine's default coast at the horizon. Read-only and
 * deterministic — golden-hash-neutral by construction (it touches nothing).
 */
export function perturbedForecast(
  ship: Ship, t: number, horizon = DEFAULT_FORECAST_HORIZON, opts: PerturbedForecastOpts = {},
): PerturbedForecast | null {
  if (ship.landed || ship.interstellarLeg || ship.mode === "thrust") return null;
  if (ship.entryLeg || ship.approachLeg || ship.launchLeg || ship.descentLeg || ship.spiral) return null;
  const primaryDef = BODY_BY_ID.get(ship.primary);
  if (!primaryDef) return null;

  const mu = primaryMu(ship);
  const start = shipRelativeState(ship, t);
  const perturbers = opts.perturbers ?? selectPerturbers(ship.primary, t);
  const useJ2 = (opts.includeJ2 ?? true) && !!primaryDef.J2;

  const res = integratePerturbed({
    mu, primaryId: ship.primary, t0: t, r0: start.r, v0: start.v, horizon, perturbers,
    ...(useJ2 ? { J2: primaryDef.J2, Req: j2RefRadius(primaryDef), pole: spinAxis(primaryDef) } : {}),
  });

  // SOI clamp: cut the displayed arc where it would leave the primary's SOI. The Sun
  // has no parent ⇒ no SOI bound (Infinity), so heliocentric arcs are never clamped.
  let soiR = Infinity;
  if (primaryDef.parent) {
    const a = bodyElements(primaryDef, t)?.a ?? length(bodyStateRelative(primaryDef, t).r);
    const parentMu = BODY_BY_ID.get(primaryDef.parent)?.mu ?? MU_SUN;
    soiR = soiRadius(a, primaryDef.mu, parentMu);
  }
  let cut = res.samples.length;
  for (let i = 0; i < res.samples.length; i++) {
    if (length(res.samples[i]!.r) > soiR) { cut = i + 1; break; }
  }
  const clampedAtSoi = cut < res.samples.length;
  const used = cut < res.samples.length ? res.samples.slice(0, cut) : res.samples;
  const effHorizon = used[used.length - 1]?.t ?? 0;

  // Per-perturber peak differential acceleration over the (clamped) arc.
  const perturberContrib: PerturberContribution[] = perturbers.map((p) => {
    const body = BODY_BY_ID.get(p.id);
    let peak = 0;
    if (body) {
      for (const s of used) {
        const tt = t + s.t;
        const rB = sub(bodyState(body, tt).r, bodyState(primaryDef, tt).r);
        peak = Math.max(peak, length(thirdBodyAccel(s.r, { x: 0, y: 0, z: 0 }, rB, p.mu)));
      }
    }
    return { id: p.id, peakAccel: peak };
  }).sort((a, b) => b.peakAccel - a.peakAccel);

  // Divergence at the (clamped) horizon vs the engine's default game-model coast.
  const keplerEnd = shipRelativeState(ship, t + effHorizon).r;
  const perturbedEnd = used[used.length - 1]?.r ?? start.r;
  const divergenceAtHorizon = length(sub(perturbedEnd, keplerEnd));

  const path: SampledPath = {
    points: used.map((s) => s.r),
    primary: ship.primary,
    times: used.map((s) => t + s.t),
    headIndex: 0,
    closed: false,
  };
  return { path, divergenceAtHorizon, perturbers: perturberContrib, horizon: effHorizon, clampedAtSoi };
}
