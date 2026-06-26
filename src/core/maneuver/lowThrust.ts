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
