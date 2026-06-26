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
 * m/s² — i.e. the acceleration felt in the instantaneous rest frame):
 *
 *   a = (1/γ)·(aProper − (v·aProper) v / c²),   γ = 1/√(1 − |v|²/c²)
 *
 * This gives `aProper/γ³` for a force along v (longitudinal) and `aProper/γ` for a
 * force across v (transverse), and keeps |v| < c for any finite force. At v ≪ c
 * (γ → 1, v/c → 0) it reduces exactly to `a = aProper`, so callers that pass the
 * Newtonian specific force recover the classical dynamics to machine precision.
 */
export function properToCoordinateAccel(v: Vec3, aProper: Vec3): Vec3 {
  const v2 = v.x * v.x + v.y * v.y + v.z * v.z;
  const gamma = 1 / Math.sqrt(1 - v2 / (C * C));
  const vDotA = (v.x * aProper.x + v.y * aProper.y + v.z * aProper.z) / (C * C);
  return {
    x: (aProper.x - vDotA * v.x) / gamma,
    y: (aProper.y - vDotA * v.y) / gamma,
    z: (aProper.z - vDotA * v.z) / gamma,
  };
}
