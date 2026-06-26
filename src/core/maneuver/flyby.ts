/**
 * Gravity-assist flyby physics.
 *
 * A spacecraft passing through a body's sphere of influence flies a hyperbola: it
 * enters with excess speed v∞, swings around periapsis, and leaves with the SAME
 * v∞ but rotated by the turn angle δ. In the body's frame nothing is gained — but
 * in the heliocentric frame the rotated v∞ adds to the body's orbital velocity
 * differently, so the ship's heliocentric speed changes for FREE. That is the
 * slingshot. A deeper (smaller rp) or slower (smaller v∞) pass bends more.
 *
 * The sim already flies the unpowered bend automatically (patched-conic SOI pass);
 * these are the closed-form relations the planner uses to design the assist.
 *
 * SI throughout; mu = GM of the flyby body.
 */

import { type Vec3, add, sub, scale, cross, dot, normalize, length } from "../math/vec3.ts";

/** Hyperbola eccentricity of a flyby at excess speed vInf and periapsis radius rp:
 *  e = 1 + rp·v∞²/μ. */
export function flybyEccentricity(vInf: number, mu: number, rp: number): number {
  return 1 + (rp * vInf * vInf) / mu;
}

/** Turn angle δ = 2·asin(1/e): how far the velocity rotates across the pass. */
export function flybyTurnAngle(vInf: number, mu: number, rp: number): number {
  return 2 * Math.asin(1 / flybyEccentricity(vInf, mu, rp));
}

/** The largest turn available — the closest safe pass (periapsis rpMin). Slower
 *  approaches bend more, so the assist is strongest at low v∞. */
export function maxTurnAngle(vInf: number, mu: number, rpMin: number): number {
  return flybyTurnAngle(vInf, mu, rpMin);
}

/** Rodrigues rotation of `v` about unit axis `k` by angle `theta`. */
function rotateAbout(v: Vec3, k: Vec3, theta: number): Vec3 {
  const c = Math.cos(theta), s = Math.sin(theta);
  return add(
    add(scale(v, c), scale(cross(k, v), s)),
    scale(k, dot(k, v) * (1 - c)),
  );
}

export interface FlybyOutcome {
  vHelioOut: Vec3; // heliocentric velocity after the flyby (m/s)
  turn: number; // applied turn angle (rad)
  e: number; // flyby hyperbola eccentricity
  assistDv: number; // |Δv| imparted to the heliocentric velocity (m/s) — the free gain
}

/**
 * Outgoing heliocentric velocity after an UNPOWERED flyby. The body-relative
 * excess velocity v∞_in = v_helio_in − v_body is rotated by the turn angle about
 * `planeNormal` (which side you pass sets the sign/normal), preserving |v∞|, then
 * the body velocity is added back. The heliocentric Δv it buys is returned.
 */
export function flybyOutgoing(
  vBody: Vec3, vHelioIn: Vec3, mu: number, rp: number, planeNormal: Vec3,
): FlybyOutcome {
  const vInfIn = sub(vHelioIn, vBody);
  const vInf = length(vInfIn);
  const turn = flybyTurnAngle(vInf, mu, rp);
  const k = normalize(planeNormal);
  const vInfOut = rotateAbout(vInfIn, k, turn);
  const vHelioOut = add(vBody, vInfOut);
  return { vHelioOut, turn, e: flybyEccentricity(vInf, mu, rp), assistDv: length(sub(vHelioOut, vHelioIn)) };
}

/**
 * Powered (Oberth) flyby: a prograde burn `dvBurn` at periapsis, where the ship is
 * deepest and fastest, converts to a larger excess speed than the same burn in
 * free space. Returns the new v∞ leaving the body. vp = √(v∞² + 2μ/rp) is the
 * periapsis speed; add dvBurn there, then v∞' = √((vp+dvBurn)² − 2μ/rp).
 */
export function poweredFlybyVInfOut(vInfIn: number, mu: number, rp: number, dvBurn: number): number {
  const vp = Math.sqrt(vInfIn * vInfIn + (2 * mu) / rp);
  const vpOut = vp + dvBurn;
  const ex = vpOut * vpOut - (2 * mu) / rp;
  return ex > 0 ? Math.sqrt(ex) : 0;
}
