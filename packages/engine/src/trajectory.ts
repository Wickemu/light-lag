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
import { type Vec3 } from "./math/vec3.ts";
import { period } from "./math/kepler.ts";
import { shipRelativeState, shipOsculatingElements, primaryMu } from "./ships.ts";

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
