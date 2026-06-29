/**
 * Bi-elliptic transfer: a three-burn transfer between coplanar circular orbits
 * that routes through a high intermediate apoapsis rB ≫ r2.
 *
 * The counter-intuitive payoff: for a large enough radius ratio (r2/r1 ≳ 11.94)
 * the bi-elliptic beats the Hohmann transfer in TOTAL Δv, because the plane-change
 * /circularization burns happen way out where orbital speed is tiny. The price is
 * a far longer time of flight. The crossover is exact orbital mechanics, not a
 * heuristic — Hohmann (maneuver/hohmann.ts) is the two-burn special case.
 *
 * SI throughout; mu = GM of the central body.
 */

import { visVivaSpeed, circularSpeed } from "../orbit.ts";

export interface BiEllipticResult {
  dv1: number; // departure burn at r1 onto the first transfer ellipse (m/s)
  dv2: number; // burn at the intermediate apoapsis rB (m/s)
  dv3: number; // arrival burn at r2 (retrograde; circularizes) (m/s)
  dvTotal: number;
  tof: number; // time of flight (s) — both half-ellipses
  rIntermediate: number; // rB (m)
}

/** Bi-elliptic transfer between circular orbits r1 and r2 via apoapsis rB (rB ≥
 *  max(r1, r2)). */
export function biElliptic(mu: number, r1: number, r2: number, rB: number): BiEllipticResult {
  const a1 = (r1 + rB) / 2; // first transfer ellipse: periapsis r1, apoapsis rB
  const a2 = (r2 + rB) / 2; // second transfer ellipse: apoapsis rB, periapsis r2

  const vc1 = circularSpeed(mu, r1);
  const vc2 = circularSpeed(mu, r2);

  const vPeri1 = visVivaSpeed(mu, r1, a1); // speed at r1 on ellipse 1
  const vApo1 = visVivaSpeed(mu, rB, a1); // speed at rB on ellipse 1
  const vApo2 = visVivaSpeed(mu, rB, a2); // speed at rB on ellipse 2
  const vPeri2 = visVivaSpeed(mu, r2, a2); // speed at r2 on ellipse 2

  const dv1 = Math.abs(vPeri1 - vc1); // raise apoapsis to rB
  const dv2 = Math.abs(vApo2 - vApo1); // at rB, raise periapsis from r1 to r2
  const dv3 = Math.abs(vPeri2 - vc2); // at r2, circularize (a retro burn)

  const tof =
    Math.PI * Math.sqrt((a1 * a1 * a1) / mu) + Math.PI * Math.sqrt((a2 * a2 * a2) / mu);

  return { dv1, dv2, dv3, dvTotal: dv1 + dv2 + dv3, tof, rIntermediate: rB };
}
