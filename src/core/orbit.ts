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
