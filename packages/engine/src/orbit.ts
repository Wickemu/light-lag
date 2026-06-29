/**
 * Orbit helpers built on the Kepler primitives: energies, speeds, apsides, and
 * the local frame (prograde / radial / normal) a burn is steered in.
 *
 * SI throughout; mu = GM of the body being orbited.
 */

import { type Vec3, cross, normalize, neg, dot } from "./math/vec3.ts";
import { type KeplerElements } from "./math/kepler.ts";
import { JULIAN_YEAR, DEG } from "./constants.ts";

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
 * Δv to CAPTURE an arrival hyperbola (excess speed vInf) into a BOUND orbit with periapsis
 * `rPeri` and apoapsis `rApo`, burning once at periapsis (where speed is highest, so the Oberth
 * effect is strongest). With `rApo === rPeri` this is the circular capture and reduces exactly to
 * `hyperbolicBurnDv`; a high apoapsis (a loose, eccentric capture ellipse) is far cheaper — you
 * shed only enough energy to drop just below escape. This is how real deep-well arrivals (a
 * Jupiter/Saturn orbit insertion) are flown: a low periapsis + a huge ellipse, not a low circular
 * orbit. `rApo` is clamped to ≥ `rPeri`.
 */
export function ellipticalCaptureDv(vInf: number, mu: number, rPeri: number, rApo: number): number {
  const ra = Math.max(rApo, rPeri);
  const a = (rPeri + ra) / 2;
  const vHypPeri = Math.sqrt(vInf * vInf + 2 * mu / rPeri);
  const vEllPeri = Math.sqrt(mu * (2 / rPeri - 1 / a));
  return vHypPeri - vEllPeri;
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

/** Secular precession rates (rad/s) of a near-circular/elliptic orbit from a
 *  body's J2 oblateness — the leading non-spherical gravity term. The node
 *  regresses (Ω̇ < 0 for prograde), the apsides precess, and the mean anomaly
 *  picks up a small secular rate. These are LINEAR in time, so they keep the
 *  analytic propagation exact at any time-warp. Zero if J2 is absent or the orbit
 *  is unbound. */
export interface J2Rates {
  nodeDot: number; // Ω̇ (rad/s) — nodal regression
  periDot: number; // ω̇ (rad/s) — apsidal precession
  anomalyDot: number; // secular Ṁ from J2 (rad/s)
}

/** `R` is the body's EQUATORIAL radius — the reference J2 is conventionally
 *  normalized to (the rate prefactor is ∝ R², so a mean radius is wrong by several
 *  % for an oblate giant). Callers pass `j2RefRadius(body)` (constants.ts). */
export function j2Rates(mu: number, R: number, J2: number, a: number, e: number, i: number): J2Rates {
  if (!J2 || a <= 0 || e >= 1) return { nodeDot: 0, periDot: 0, anomalyDot: 0 };
  const n = Math.sqrt(mu / (a * a * a)); // mean motion
  const p = a * (1 - e * e); // semi-latus rectum
  const f = n * J2 * (R / p) * (R / p);
  const ci = Math.cos(i);
  return {
    nodeDot: -1.5 * f * ci,
    periDot: 0.75 * f * (5 * ci * ci - 1), // frozen apsides at the critical i ≈ 63.43°
    anomalyDot: 0.75 * f * Math.sqrt(1 - e * e) * (3 * ci * ci - 1),
  };
}

/**
 * The inclination of a SUN-SYNCHRONOUS orbit: the J2 nodal regression exactly
 * matches the body's ~1 rev/year around the Sun, so the orbit plane keeps a fixed
 * angle to the Sun. Returns the inclination (rad, > 90° — retrograde) or null if
 * no inclination achieves it at this altitude. (For Earth at ~700 km this is the
 * familiar ≈ 98°.)
 */
export function sunSyncInclination(mu: number, R: number, J2: number, a: number, e = 0): number | null {
  if (!J2 || a <= 0) return null;
  const n = Math.sqrt(mu / (a * a * a));
  const p = a * (1 - e * e);
  const cosi = -(2 * Math.PI) / JULIAN_YEAR / (1.5 * n * J2 * (R / p) * (R / p));
  if (Math.abs(cosi) > 1) return null;
  return Math.acos(cosi);
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

/**
 * Radius (m) of a circular SYNCHRONOUS orbit about a body of GM `mu` whose sidereal
 * rotation period is `rotPeriod` (s; sign ignored — a retrograde spinner still has a
 * synchronous radius). From Kepler's third law with period = rotation period:
 * a = ∛(mu·T²/4π²). This is GEO for Earth (≈42,164 km radius ⇒ ≈35,786 km altitude) and
 * the areostationary radius for Mars (≈20,428 km).
 */
export function synchronousRadius(mu: number, rotPeriod: number): number {
  const T = Math.abs(rotPeriod);
  return Math.cbrt((mu * T * T) / (4 * Math.PI * Math.PI));
}

/** A synchronous orbit is offered only well inside the sphere of influence, so it stays
 *  bound and stable rather than being stripped by the parent. The Moon's synchronous radius
 *  (≈88,000 km) exceeds its SOI (≈66,000 km), so a lunar "GEO" is excluded by this bound. */
export const SYNC_SOI_FRACTION = 0.4;

/**
 * Is a synchronous orbit physically usable at this body? It needs a rotation period, a
 * synchronous radius above the surface, and one comfortably inside the SOI
 * (≤ `SYNC_SOI_FRACTION`·rSoi). Returns false for a tidally-locked / slow rotator whose
 * synchronous radius falls outside its SOI (the Moon), and for a body with no rotation period.
 */
export function synchronousFeasible(
  mu: number, rotPeriod: number | undefined, radius: number, rSoi: number,
): boolean {
  if (!rotPeriod) return false;
  const aSync = synchronousRadius(mu, rotPeriod);
  return aSync > radius && aSync <= SYNC_SOI_FRACTION * rSoi;
}

/**
 * Unit spin pole of a body from its obliquity (axial tilt from the ecliptic +Z, in degrees).
 * Only the tilt MAGNITUDE is recorded per body (not the pole's ecliptic longitude), so the axis
 * is taken tilted about the ecliptic +X — a canonical choice that fixes the equatorial plane's
 * normal at (0, −sin ε, cos ε). The body's EQUATOR is the plane perpendicular to this; a
 * geostationary orbit lies in it.
 */
export function spinPole(obliquityDeg = 0): Vec3 {
  const e = obliquityDeg * DEG;
  return { x: 0, y: -Math.sin(e), z: Math.cos(e) };
}

/** Inclination (rad) of an orbit (whose plane normal is the unit `orbitNormal` = r×v normalized)
 *  to a body's equatorial plane — i.e. the plane-change angle that would make it equatorial. */
export function inclinationToEquator(orbitNormal: Vec3, obliquityDeg = 0): number {
  const c = Math.max(-1, Math.min(1, dot(normalize(orbitNormal), spinPole(obliquityDeg))));
  return Math.acos(c);
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
