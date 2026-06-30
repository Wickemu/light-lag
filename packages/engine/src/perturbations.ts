/**
 * Shared gravitational acceleration TERMS — the single inverse-square law (and its
 * perturbations) the engine reuses across the force overlay (`forces.ts`), the
 * J2-perturbed approach integrator (`maneuver/approach.ts`), and the third-body
 * perturbed propagator (`perturbed.ts`). Centralising the terms here is the "one
 * gravity law" the physics audit asked for (`docs/physics-assessment.md` §C.5): the
 * arrow the player sees and the trajectory the ship flies can never drift apart,
 * because they are computed by the SAME function.
 *
 * Every term returns a bare specific-acceleration `Vec3` (m/s²) and is a pure
 * function of its arguments — no body lookups, no time, no `Math.random`/`Date` — so
 * callers stay deterministic and the engine stays DOM-free. Frames are the caller's
 * responsibility: pass every position in the SAME frame (all body-relative, or all
 * absolute root-frame).
 *
 * SI throughout; mu = GM (m³/s²).
 */

import { type Vec3, add, sub, scale, dot, length } from "./math/vec3.ts";

/** Point-mass central gravity `a = −μ r/|r|³`, with `r` the position relative to the
 *  attractor. Returns zero at r = 0 (degenerate guard). */
export function centralAccel(r: Vec3, mu: number): Vec3 {
  const R = length(r);
  if (R === 0) return { x: 0, y: 0, z: 0 };
  return scale(r, -mu / (R * R * R));
}

/**
 * J2 zonal acceleration referenced to the body's spin pole `n` (a unit vector in the
 * inertial frame — `ships.ts spinAxis`):
 *
 *   a = −(3 J2 μ Req²)/(2 r⁴) · [ (1 − 5σ²) r̂ + 2σ n ],   σ = (r·n)/r
 *
 * (the bracket reduces to the textbook cartesian J2 acceleration when n = ẑ). `r` is
 * the body-relative position; `Req` the equatorial reference radius. J2 = 0 ⇒ zero, so
 * a spherical body contributes nothing. This is built so J3/J4 zonals can be added as
 * further terms later without touching the callers.
 */
export function j2ZonalAccel(r: Vec3, mu: number, J2: number, Req: number, n: Vec3): Vec3 {
  if (!J2) return { x: 0, y: 0, z: 0 };
  const R = length(r);
  if (R === 0) return { x: 0, y: 0, z: 0 };
  const sigma = dot(r, n) / R;
  const c = (-1.5 * J2 * mu * Req * Req) / (R * R * R * R);
  const rHat = scale(r, 1 / R);
  return add(scale(rHat, c * (1 - 5 * sigma * sigma)), scale(n, c * 2 * sigma));
}

/**
 * Third-body (differential / tidal) acceleration on an object relative to its primary
 * from a perturber at `rB` of parameter `muB`: the DIRECT pull on the object minus the
 * INDIRECT pull on the primary (which accelerates the whole primary-centred frame) —
 *
 *   a = μB [ (rB − rObj)/|rB − rObj|³ − (rB − rPrim)/|rB − rPrim|³ ]
 *
 * This differential is what actually perturbs the primary-relative orbit; the raw
 * direct pull alone would be wrong, because it ignores that the primary-centred frame
 * is itself non-inertial (it is being pulled by the same third body). All three
 * positions must be in the SAME frame. (When `r` is already body-relative, pass
 * `rPrim = origin` and `rB` the perturber's body-relative position.)
 */
export function thirdBodyAccel(rObj: Vec3, rPrim: Vec3, rB: Vec3, muB: number): Vec3 {
  const pull = (from: Vec3): Vec3 => {
    const d = sub(rB, from);
    const r = length(d);
    return r === 0 ? { x: 0, y: 0, z: 0 } : scale(d, muB / (r * r * r));
  };
  return sub(pull(rObj), pull(rPrim));
}
