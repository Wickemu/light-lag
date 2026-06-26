/**
 * Orbit helpers built on the Kepler primitives: energies, speeds, apsides, and
 * the local frame (prograde / radial / normal) a burn is steered in.
 *
 * SI throughout; mu = GM of the body being orbited.
 */

import { type Vec3, cross, normalize, neg } from "./math/vec3.ts";
import { type KeplerElements } from "./math/kepler.ts";

/** vis-viva: orbital speed at radius r on an orbit of semi-major axis a. */
export function visVivaSpeed(mu: number, r: number, a: number): number {
  return Math.sqrt(mu * (2 / r - 1 / a));
}

/** Circular orbital speed at radius r. */
export function circularSpeed(mu: number, r: number): number {
  return Math.sqrt(mu / r);
}

/**
 * Laplace sphere-of-influence radius of a body: a·(m/M_parent)^(2/5), the
 * distance within which the body's gravity dominates the parent's. Patched
 * conics switch the reference body at this boundary. Uses GM ratios (= mass
 * ratios). a = the body's semi-major axis about its parent (m).
 */
export function soiRadius(a: number, mu: number, parentMu: number): number {
  return a * Math.pow(mu / parentMu, 0.4);
}

/**
 * The impulsive Δv connecting a circular parking orbit (radius rPark about a
 * body of GM mu) and a hyperbolic trajectory of excess speed vInf — i.e. the
 * Oberth-aware injection burn at periapsis (and, symmetrically, the capture
 * burn). Always ≥ vInf, approaching vInf only as rPark → ∞: burning deep in a
 * gravity well is what makes interplanetary departures affordable.
 */
export function hyperbolicBurnDv(vInf: number, mu: number, rPark: number): number {
  const vPark = Math.sqrt(mu / rPark);
  const vPeri = Math.sqrt(vInf * vInf + 2 * mu / rPark);
  return vPeri - vPark;
}

/**
 * Δv for a PURE plane change of angle `di` (rad) at orbital speed `v`: rotating
 * the velocity vector by `di` without changing its magnitude is an isoceles
 * triangle, so Δv = 2·v·sin(di/2). This is why plane changes are done at apoapsis
 * (where v is lowest) — the cost scales directly with the speed you turn.
 */
export function planeChangeDv(v: number, di: number): number {
  return 2 * v * Math.sin(di / 2);
}

/**
 * Δv for a COMBINED maneuver that both changes speed (v1 → v2) and rotates the
 * velocity by `di` (rad), in a single burn — the law of cosines on the velocity
 * triangle: √(v1² + v2² − 2·v1·v2·cos di). Reduces to |v2 − v1| when di = 0 and to
 * planeChangeDv when v1 = v2. Always ≤ doing the two separately.
 */
export function combinedPlaneChangeDv(v1: number, v2: number, di: number): number {
  return Math.sqrt(v1 * v1 + v2 * v2 - 2 * v1 * v2 * Math.cos(di));
}

/** Specific orbital energy (J/kg). Negative = bound. */
export function specificEnergy(mu: number, a: number): number {
  return -mu / (2 * a);
}

export function apoapsisRadius(a: number, e: number): number {
  return a * (1 + e);
}

export function periapsisRadius(a: number, e: number): number {
  return a * (1 - e);
}

/** Orbital period (s) for a bound orbit; Infinity if unbound. */
export function orbitalPeriod(a: number, mu: number): number {
  if (a <= 0) return Infinity;
  return 2 * Math.PI * Math.sqrt((a * a * a) / mu);
}

/** Elements of a circular orbit of the given radius (m) and inclination (rad). */
export function circularOrbit(radius: number, i = 0, Omega = 0, M = 0): KeplerElements {
  return { a: radius, e: 0, i, Omega, omega: 0, M };
}

export interface OrbitFrame {
  prograde: Vec3;
  retrograde: Vec3;
  radialOut: Vec3;
  radialIn: Vec3;
  normal: Vec3;
  antinormal: Vec3;
}

/** The local maneuver frame at a state (r, v). */
export function orbitFrame(r: Vec3, v: Vec3): OrbitFrame {
  const prograde = normalize(v);
  const radialOut = normalize(r);
  const normal = normalize(cross(r, v));
  return {
    prograde,
    retrograde: neg(prograde),
    radialOut,
    radialIn: neg(radialOut),
    normal,
    antinormal: neg(normal),
  };
}

/** Summary of an orbit's shape for the HUD, relative to a body of `radius`. */
export interface OrbitSummary {
  periapsisAlt: number; // m above surface
  apoapsisAlt: number; // m above surface (Infinity if unbound)
  period: number; // s (Infinity if unbound)
  bound: boolean;
}

export function summarizeOrbit(el: KeplerElements, mu: number, bodyRadius: number): OrbitSummary {
  const bound = el.e < 1 && el.a > 0;
  const rp = periapsisRadius(el.a, el.e);
  const ra = apoapsisRadius(el.a, el.e);
  return {
    periapsisAlt: rp - bodyRadius,
    apoapsisAlt: bound ? ra - bodyRadius : Infinity,
    period: orbitalPeriod(el.a, mu),
    bound,
  };
}
