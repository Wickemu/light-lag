/**
 * Special-relativistic kinematics in a flat (inertial) frame.
 *
 * The engine integrates powered flight in the primary-centred frame, treated as
 * inertial (the existing patched-conic approximation). At a meaningful fraction of
 * c the Newtonian `dv/dt = F/m` is wrong: a proper-frame force does not add
 * coordinate velocity linearly. This module supplies the exact transform from a
 * proper-frame specific force to the coordinate 3-acceleration, so the in-sim
 * finite-thrust integrator composes velocity relativistically (capped below c) and
 * reduces to the Newtonian form at v ≪ c.
 *
 * SI throughout (metres, metres/second, seconds).
 */

import { type Vec3 } from "./vec3.ts";
import { C } from "../constants.ts";

/**
 * The coordinate 3-acceleration `a = dv/dt` of a particle moving at velocity `v`
 * under a proper-frame specific force `aProper` (force per unit current rest mass,
 * m/s² — i.e. the acceleration felt in the instantaneous rest frame, e.g. a rocket
 * engine's thrust/m).
 *
 * A proper acceleration maps to coordinate acceleration anisotropically (Rindler):
 * the component along v is suppressed by γ³, the component across v by γ². So,
 * decomposing aProper into α∥ (along v̂) and α⊥ (across):
 *
 *   a = α∥/γ³ + α⊥/γ²,   γ = 1/√(1 − |v|²/c²)
 *
 * (Using a single 1/γ on the whole vector would be the *lab-3-force* law dp/dt = F,
 * which scales the transverse part by 1/γ, not 1/γ² — wrong for a rest-frame engine
 * push.) At v ≪ c (γ → 1) both channels reduce to the identity, so a caller passing
 * the Newtonian specific force recovers `a ≈ aProper` (to ~1e-9 at orbital speeds,
 * exactly at v = 0). |v| is clamped just below c so γ stays finite even if a hard
 * RK4 sub-step momentarily proposes a superluminal intermediate state.
 */
export function properToCoordinateAccel(v: Vec3, aProper: Vec3): Vec3 {
  const c2 = C * C;
  const v2 = v.x * v.x + v.y * v.y + v.z * v.z;
  if (v2 === 0) return { x: aProper.x, y: aProper.y, z: aProper.z }; // γ = 1
  // γ from |v| clamped just below c (the converged dynamics keep |v| < c; this only
  // tames explicit RK4 stages and prevents a NaN/∞ lock-up).
  const vc2 = Math.min(v2, c2 * (1 - 1e-12));
  const gamma = 1 / Math.sqrt(1 - vc2 / c2);
  const g2 = gamma * gamma, g3 = g2 * gamma;
  // Project aProper onto v̂ (use the true |v|² for the geometry); α∥ = par·v.
  const par = (v.x * aProper.x + v.y * aProper.y + v.z * aProper.z) / v2;
  const parX = par * v.x, parY = par * v.y, parZ = par * v.z;
  return {
    x: parX / g3 + (aProper.x - parX) / g2,
    y: parY / g3 + (aProper.y - parY) / g2,
    z: parZ / g3 + (aProper.z - parZ) / g2,
  };
}
