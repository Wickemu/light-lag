/**
 * Lagrange points of a (primary, secondary) two-body pair — the five points that co-rotate
 * with the secondary's orbit where a small body can hold station. Keyed off the SECONDARY
 * body: the pair is (secondary.parent, secondary), so Sun–Earth L-points are keyed off Earth
 * (heliocentric) and Earth–Moon L-points off the Moon (geocentric).
 *
 * Like the planetary ephemeris this is a pure, deterministic function of t — the point's state
 * is derived live from the secondary's parent-relative state (ephemeris.ts), never stored. The
 * collinear points use the standard first-order expansion in the mass ratio; the triangular
 * points are exact equilateral. True halo orbits / libration / station-keeping about a point are
 * not modelled — the arrival is treated as a single velocity match (see commands.ts planLagrange).
 *
 * SI throughout (metres, m/s).
 */

import { type LagrangePoint } from "../world.ts";
import { type BodyDef, BODY_BY_ID, MU_SUN, DEG } from "../constants.ts";
import { type State } from "../math/kepler.ts";
import { add, scale, cross, normalize, rotateAboutAxis, lengthSq } from "../math/vec3.ts";
import { bodyState, bodyStateRelative } from "../ephemeris.ts";

/** GM of the primary of the pair `secondary` belongs to (its parent, or the Sun for a planet). */
function primaryMu(secondary: BodyDef): number {
  const parent = secondary.parent ? BODY_BY_ID.get(secondary.parent) : undefined;
  return parent ? parent.mu : MU_SUN;
}

/** First-order collinear offset ratio ξ = ∛(μ₂/3μ₁): the fractional distance of L1/L2 from
 *  the secondary along the primary–secondary line (≈0.01 for Sun–Earth, ≈0.16 for Earth–Moon). */
export function collinearRatio(mu1: number, mu2: number): number {
  return Math.cbrt(mu2 / (3 * mu1));
}

/**
 * State (r, v) of a Lagrange point in the PRIMARY-relative frame at time t — i.e. relative to
 * `secondary.parent` (Sun for a planet, the planet for a moon). Built from the secondary's
 * parent-relative state:
 *  - L1/L2: along the primary→secondary line at r_s·(1∓ξ);
 *  - L3: on the far side at ≈ −r_s·(1 + 5μ₂/12μ₁);
 *  - L4/L5: the secondary's state rotated ±60° about the orbit normal (exact equilateral,
 *    leading/trailing). Velocity for the collinear points co-rotates at the secondary's
 *    instantaneous angular rate ω = (r×v)/|r|²: v = ω × r_point.
 */
export function lagrangeStateRelative(secondary: BodyDef, point: LagrangePoint, t: number): State {
  const mu1 = primaryMu(secondary);
  const mu2 = secondary.mu;
  const s = bodyStateRelative(secondary, t); // secondary relative to its primary
  const n = normalize(cross(s.r, s.v)); // orbit normal (rotation axis)

  // Triangular points: exact equilateral configuration, co-moving with the secondary.
  if (point === "L4" || point === "L5") {
    const ang = (point === "L4" ? 60 : -60) * DEG;
    return { r: rotateAboutAxis(s.r, n, ang), v: rotateAboutAxis(s.v, n, ang) };
  }

  // Collinear points along the primary–secondary line. Scale the position vector; the velocity
  // is the angular co-rotation ω × r_point (exact for a circular orbit; first-order otherwise).
  const xi = collinearRatio(mu1, mu2);
  let k: number;
  if (point === "L1") k = 1 - xi;
  else if (point === "L2") k = 1 + xi;
  else k = -(1 + (5 * mu2) / (12 * mu1)); // L3 — opposite side of the primary
  const rPoint = scale(s.r, k);
  const omega = scale(cross(s.r, s.v), 1 / lengthSq(s.r)); // angular velocity vector
  return { r: rPoint, v: cross(omega, rPoint) };
}

/** Absolute (root-frame) state of a Lagrange point: the primary's absolute state plus the
 *  primary-relative point state. */
export function lagrangeState(secondary: BodyDef, point: LagrangePoint, t: number): State {
  const rel = lagrangeStateRelative(secondary, point, t);
  const parent = secondary.parent ? BODY_BY_ID.get(secondary.parent) : undefined;
  if (!parent) return rel; // secondary's primary is the root (Sun) — relative IS absolute
  const base = bodyState(parent, t);
  return { r: add(base.r, rel.r), v: add(base.v, rel.v) };
}

/** Whether Lagrange points are offered for this body: it must have a parent (so a pair exists).
 *  Excludes the Sun (no parent); every orbiting body — planet, moon, dwarf — qualifies. */
export function lagrangeEligible(secondary: BodyDef): boolean {
  return secondary.parent !== null && BODY_BY_ID.has(secondary.parent);
}

/** The cruise frame a transfer to this body's L-points is flown in: heliocentric (undefined)
 *  for a planet's Sun–planet points, or the parent planet id for a moon's planet–moon points. */
export function lagrangeCentral(secondary: BodyDef): string | undefined {
  const parent = secondary.parent ? BODY_BY_ID.get(secondary.parent) : undefined;
  return parent && parent.parent === "sun" ? parent.id : undefined; // moon → planet frame; planet → heliocentric
}
