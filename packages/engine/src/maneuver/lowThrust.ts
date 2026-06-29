/**
 * Low-thrust (electric) transfer estimation — Edelbaum's analytic solution.
 *
 * An ion/Hall craft can't do an impulsive Hohmann transfer; it thrusts gently and
 * continuously, spiralling between orbits over weeks to years. Edelbaum (1961)
 * gives the Δv of a constant-thrust spiral between circular orbits including a
 * plane change:  Δv = √(v0² + v1² − 2·v0·v1·cos(½π·Δi)).  For a coplanar transfer
 * this is just |v0 − v1| — and famously LEO→GEO costs ~4.6 km/s of spiral Δv, MORE
 * than the 3.9 km/s impulsive Hohmann, but at electric Isp the propellant is tiny.
 * The transfer time is the propellant divided by the mass flow.
 *
 * This is the honest planning model for electric craft (which the engine can't fly
 * as a months-long stepped burn). SI throughout; mu = GM of the central body.
 */

import { circularSpeed } from "../orbit.ts";
import { propellantForDv } from "../propulsion.ts";

/** Edelbaum Δv (m/s) for a constant-thrust spiral between circular orbits r0→r1
 *  with plane change `di` (rad). Reduces to |v0 − v1| when coplanar. */
export function edelbaumDv(mu: number, r0: number, r1: number, di = 0): number {
  const v0 = circularSpeed(mu, r0);
  const v1 = circularSpeed(mu, r1);
  return Math.sqrt(v0 * v0 + v1 * v1 - 2 * v0 * v1 * Math.cos((Math.PI / 2) * di));
}

export interface LowThrustTransfer {
  dv: number; // Edelbaum Δv (m/s)
  time: number; // transfer time (s) — long
  propellant: number; // kg
  v0: number; // start circular speed (m/s)
  v1: number; // end circular speed (m/s)
  feasible: boolean; // the stack has the Δv
}

/**
 * A constant-low-thrust spiral between circular orbits. `thrust` is the actual
 * (distance-derated) thrust, `ve` the exhaust velocity, `m0` the start mass. Time
 * = propellant / mass-flow; propellant from the rocket equation at the Edelbaum Δv.
 */
export function edelbaumTransfer(
  mu: number, r0: number, r1: number, di: number,
  thrust: number, ve: number, m0: number, dvAvailable = Infinity,
): LowThrustTransfer {
  const dv = edelbaumDv(mu, r0, r1, di);
  const propellant = propellantForDv(ve, m0, dv);
  const mdot = thrust / ve;
  const time = mdot > 0 ? propellant / mdot : Infinity;
  return {
    dv, time, propellant,
    v0: circularSpeed(mu, r0), v1: circularSpeed(mu, r1),
    feasible: dv <= dvAvailable,
  };
}

// ── Capture / escape spirals about a destination body ────────────────────────
//
// The heliocentric Edelbaum leg above spirals the SUN's well between planet
// orbits; these spiral a SINGLE BODY's well — down to a parking orbit on arrival
// (capture) or out of one to escape on departure. They are the same Edelbaum law
// taken to the limit r → ∞, where circularSpeed → 0:
//
//   spiral escape from r0  →  Δv = √(v0² + 0) = v_circ(r0)
//   spiral capture to  r1  ←  Δv = v_circ(r1)
//
// A low-thrust craft cannot brake impulsively, so it does NOT shed a hyperbolic
// excess at periapsis the way a chemical capture burn does. The honest, internally
// consistent picture is that the heliocentric spiral arrives MATCHED to the target
// (a rendezvous, vInf ≈ 0), then spirals down from the SOI edge to the parking
// orbit. Famously this costs the FULL local circular speed — e.g. ~7.7 km/s to
// spiral off LEO, versus the (√2−1)·v_circ ≈ 3.2 km/s of an impulsive escape —
// but at electric Isp the propellant is a fraction of the impulsive case. The
// plane change is "free" here (it couples through the 2·v0·v1 term, which vanishes
// as one speed → 0): re-orienting where the orbit is barely bound is cheap.

/** Low-thrust Δv (m/s) to spiral OUT of a circular orbit of radius `r0` about a
 *  body (GM `mu`) until escape (energy → 0). Equals the local circular speed. */
export function spiralEscapeDv(mu: number, r0: number): number {
  return circularSpeed(mu, r0);
}

/** Low-thrust Δv (m/s) to spiral DOWN from rest at the SOI edge to a circular
 *  parking orbit of radius `r1` about a body (GM `mu`). Equals v_circ(r1). */
export function spiralCaptureDv(mu: number, r1: number): number {
  return circularSpeed(mu, r1);
}

/** Spiral OUT of a circular orbit `r0` to escape: Δv, burn time, and propellant
 *  for the actual (distance-derated) `thrust`/`ve` from start mass `m0`. */
export function spiralEscapeTransfer(
  mu: number, r0: number, thrust: number, ve: number, m0: number, dvAvailable = Infinity,
): LowThrustTransfer {
  return edelbaumTransfer(mu, r0, Infinity, 0, thrust, ve, m0, dvAvailable);
}

/** Spiral DOWN from the SOI edge (vInf ≈ 0) to a circular parking orbit `r1`:
 *  Δv, burn time, and propellant for the actual `thrust`/`ve` from start mass `m0`. */
export function spiralCaptureTransfer(
  mu: number, r1: number, thrust: number, ve: number, m0: number, dvAvailable = Infinity,
): LowThrustTransfer {
  return edelbaumTransfer(mu, Infinity, r1, 0, thrust, ve, m0, dvAvailable);
}
