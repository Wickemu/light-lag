/**
 * Hohmann transfer: the minimum-Δv two-impulse transfer between coplanar
 * circular orbits, and the launch-window cadence that follows from it.
 *
 * It is the analytic first cut — exact only for coplanar circular orbits — but
 * it gives the Δv scale, the time of flight, and (via the synodic period and the
 * required phase angle) when the window opens. Lambert + the porkchop plot do
 * the real, general planning.
 *
 * SI throughout; mu = GM of the central body.
 */

import { BODY_BY_ID } from "../constants.ts";
import { bodyState, bodyElements } from "../ephemeris.ts";
import { period as orbitalPeriod } from "../math/kepler.ts";

export interface HohmannResult {
  dv1: number; // departure burn (m/s)
  dv2: number; // arrival burn (m/s)
  dvTotal: number;
  tof: number; // time of flight (s) — half the transfer ellipse
  aTransfer: number; // semi-major axis of the transfer ellipse (m)
}

/** Hohmann transfer between circular orbits of radius r1 and r2 about `mu`. */
export function hohmann(mu: number, r1: number, r2: number): HohmannResult {
  const aT = (r1 + r2) / 2;
  const vCirc1 = Math.sqrt(mu / r1);
  const vCirc2 = Math.sqrt(mu / r2);
  const vPeri = Math.sqrt(mu * (2 / r1 - 1 / aT)); // transfer speed at r1
  const vApo = Math.sqrt(mu * (2 / r2 - 1 / aT)); // transfer speed at r2
  const dv1 = Math.abs(vPeri - vCirc1);
  const dv2 = Math.abs(vCirc2 - vApo);
  const tof = Math.PI * Math.sqrt((aT * aT * aT) / mu);
  return { dv1, dv2, dvTotal: dv1 + dv2, tof, aTransfer: aT };
}

/** Synodic period: how often the same relative geometry of two orbits recurs. */
export function synodicPeriod(T1: number, T2: number): number {
  return 1 / Math.abs(1 / T1 - 1 / T2);
}

/** Heliocentric ecliptic longitude of a body at time t (rad). */
function longitude(id: string, t: number): number {
  const s = bodyState(BODY_BY_ID.get(id)!, t).r;
  return Math.atan2(s.y, s.x);
}

/**
 * Estimate the next departure time (>= t0) for a Hohmann-like transfer from one
 * heliocentric body to another, using the required phase angle. Circular-orbit
 * approximation — good for centring a porkchop search; the porkchop minimum is
 * the precise answer.
 */
export function nextTransferWindow(fromId: string, toId: string, t0: number): number {
  const from = BODY_BY_ID.get(fromId)!;
  const to = BODY_BY_ID.get(toId)!;
  const aFrom = bodyElements(from, t0)!.a;
  const aTo = bodyElements(to, t0)!.a;
  const muSun = BODY_BY_ID.get("sun")!.mu;

  const tof = hohmann(muSun, aFrom, aTo).tof;
  const nTo = (2 * Math.PI) / orbitalPeriod(aTo, muSun);
  const nFrom = (2 * Math.PI) / orbitalPeriod(aFrom, muSun);

  // Target's required angular lead at departure so it arrives where the transfer
  // ends: phiReq = π − nTo·tof (wrapped to (−π, π]).
  let phiReq = Math.PI - nTo * tof;
  phiReq = Math.atan2(Math.sin(phiReq), Math.cos(phiReq));

  const phiNow = wrap(longitude(toId, t0) - longitude(fromId, t0));
  const rate = nTo - nFrom; // d(phi)/dt (negative for an outward transfer)

  // Smallest non-negative Δt with phi(t0+Δt) == phiReq.
  let dPhi = wrap(phiReq - phiNow);
  let dt = dPhi / rate;
  const synodic = synodicPeriod(orbitalPeriod(aFrom, muSun), orbitalPeriod(aTo, muSun));
  while (dt < 0) dt += synodic;
  return t0 + dt;
}

function wrap(x: number): number {
  return Math.atan2(Math.sin(x), Math.cos(x));
}
