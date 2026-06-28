/**
 * Closed-loop burn guidance: at command delivery, find the burn Δv MAGNITUDE
 * (along a player-chosen direction) that makes the resulting osculating conic
 * meet an orbital goal, within a correction budget.
 *
 * This is the autonomous half of the light-lag bargain. The player aims from a
 * retarded snapshot and commits a goal + a correction cap; after the round-trip
 * the ship re-derives the magnitude against its OWN live state at delivery. It
 * does not erase light-lag (the goal was chosen from the past, the ship still
 * can't ask anything across the delay) — it makes light-lag's cost a choice.
 *
 * Single varied scalar only (magnitude). It deliberately does NOT solve a
 * multi-variable boundary-value problem (direction, timing, plane) — that is the
 * mission-ops tool this game is not.
 *
 * Determinism: pure function of its arguments. Fixed scan count + fixed
 * iteration cap, no Date.now()/Math.random(), no time/warp dependence — the
 * result is a scalar handed to the same finite-thrust integrator the open-loop
 * path uses, so it stays inside the analytic/impulsive determinism contract.
 *
 * The impulsive prediction (a single Δv along the initial orbit-frame direction)
 * is an estimate of the finite, continuously-steered burn — exactly how a real
 * guidance computer sizes a maneuver. The small impulsive-vs-finite gap is why
 * callers treat the achieved orbit with a tolerance, not as exact.
 */

import { type Vec3, addScaled, length } from "../math/vec3.ts";
import { stateToElements } from "../math/kepler.ts";
import { orbitFrame, periapsisRadius, apoapsisRadius } from "../orbit.ts";
import { type BurnDir, type BurnGoal } from "../world.ts";

const SCAN_N = 16; // coarse grid points used to bracket the root (fixed → deterministic)
const MAX_ITER = 64; // hard cap on the bracket-closing iteration
const TOL_MS = 1e-3; // converged bracket width, m/s (below the 12-sig-fig quantize)
const GOAL_TOL_M = 1; // "already at goal" radius tolerance, m (short-circuit to 0)
const E_TOL = 1e-3; // eccentricity tolerance for accepting a circularization

/** Unit vector of a burn direction in the local orbit frame at state (r, v). */
function dirUnit(r: Vec3, v: Vec3, dir: BurnDir): Vec3 {
  const f = orbitFrame(r, v);
  switch (dir) {
    case "prograde":
      return f.prograde;
    case "retrograde":
      return f.retrograde;
    case "radial-out":
      return f.radialOut;
    case "radial-in":
      return f.radialIn;
    case "normal":
      return f.normal;
    case "antinormal":
      return f.antinormal;
  }
}

/**
 * Signed residual (achieved metric − goal metric) after an impulsive Δv `s`
 * along `hat`. Zero at the solution; the solver brackets a sign change.
 * Monotonicity is NOT assumed — apsis-vs-Δv bends and an orbit can go unbound.
 * Unbound results that have no apoapsis/semi-major-axis return +∞ so "raised
 * past escape" reads as an overshoot (never NaN), keeping the sign well-defined.
 */
function residual(
  r: Vec3,
  v: Vec3,
  mu: number,
  hat: Vec3,
  rMag: number,
  goal: BurnGoal,
  s: number,
): number {
  const el = stateToElements(r, addScaled(v, hat, s), mu);
  const unbound = !Number.isFinite(el.a) || el.a <= 0 || el.e >= 1;
  switch (goal.kind) {
    case "periapsis":
      // Periapsis is real for hyperbolae too (a<0, 1−e<0 ⇒ a(1−e)>0).
      return periapsisRadius(el.a, el.e) - goal.rTarget;
    case "apoapsis":
      return unbound ? Infinity : apoapsisRadius(el.a, el.e) - goal.rTarget;
    case "sma":
      return unbound ? Infinity : el.a - goal.aTarget;
    case "circular":
      // Circularize where the ship actually is at delivery: drive a → |r|.
      return unbound ? Infinity : el.a - rMag;
  }
}

/** Resulting eccentricity after an impulsive Δv `s` along `hat` (for the
 *  circularization feasibility check). */
function resultingE(r: Vec3, v: Vec3, mu: number, hat: Vec3, s: number): number {
  return stateToElements(r, addScaled(v, hat, s), mu).e;
}

/** Close a sign-changed bracket [a,b] with Illinois-modified regula-falsi to a
 *  Δv tolerance. Same robust scheme as the comms light-time solver, but with a
 *  magnitude (m/s) tolerance instead of a time tolerance. */
function closeBracket(
  f: (x: number) => number,
  a0: number,
  fa0: number,
  b0: number,
  fb0: number,
): number {
  let a = a0;
  let b = b0;
  let fa = fa0;
  let fb = fb0;
  let side = 0;
  for (let i = 0; i < MAX_ITER && b - a > TOL_MS; i++) {
    let m = fb !== fa ? b - (fb * (b - a)) / (fb - fa) : 0.5 * (a + b);
    if (!(m > a && m < b)) m = 0.5 * (a + b); // keep the step inside the bracket
    const fm = f(m);
    if (fm === 0) return m;
    if ((fm < 0) === (fa < 0)) {
      a = m;
      fa = fm;
      if (side === -1) fb *= 0.5; // Illinois: shrink the stalled endpoint
      side = -1;
    } else {
      b = m;
      fb = fm;
      if (side === 1) fa *= 0.5;
      side = 1;
    }
  }
  return 0.5 * (a + b);
}

/**
 * Solve for the burn Δv magnitude in [0, dvCap] that makes the conic after an
 * impulsive burn along `dir` (from state r,v about a body of GM `mu`) meet
 * `goal`. Returns the magnitude, or null if the goal is unreachable within the
 * cap (no sign change on the coarse scan) or — for a circular goal — if the
 * geometry cannot reach a near-circular orbit (e.g. burning off-apsis).
 */
export function solveBurnMagnitude(
  r: Vec3,
  v: Vec3,
  mu: number,
  dir: BurnDir,
  goal: BurnGoal,
  dvCap: number,
): number | null {
  if (!(dvCap > 0)) return null;
  const hat = dirUnit(r, v, dir);
  const rMag = length(r);
  const f = (s: number): number => residual(r, v, mu, hat, rMag, goal, s);

  const f0 = f(0);
  // Already at the goal (within a metre): nothing to do — the caller NACKs s≈0.
  if (Number.isFinite(f0) && Math.abs(f0) <= GOAL_TOL_M) return 0;

  // Coarse fixed scan to bracket the first sign change in [0, dvCap].
  let prevS = 0;
  let prevF = f0;
  for (let i = 1; i <= SCAN_N; i++) {
    const s = (dvCap * i) / SCAN_N;
    const fs = f(s);
    if (Number.isFinite(prevF) && Number.isFinite(fs) && prevF * fs <= 0) {
      const root = closeBracket(f, prevS, prevF, s, fs);
      // Circular goal: only accept if the result is actually near-circular.
      if (goal.kind === "circular" && resultingE(r, v, mu, hat, root) > E_TOL) return null;
      return root;
    }
    prevS = s;
    prevF = fs;
  }
  return null; // unreachable within the correction budget
}
