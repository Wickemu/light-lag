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

/** Hyperbolic impact parameter b — the perpendicular miss-distance of the incoming
 *  asymptote from the body centre: b = |a|·√(e²−1) = rp·√((e+1)/(e−1)), with
 *  |a| = μ/v∞². This is the targeting handle a B-plane aim actually controls: pick
 *  b (and its direction in the B-plane), and the periapsis — hence the bend — follows. */
export function impactParameter(vInf: number, mu: number, rp: number): number {
  const e = flybyEccentricity(vInf, mu, rp);
  return rp * Math.sqrt((e + 1) / (e - 1));
}

export interface BPlaneAim {
  turn: number; // bend angle between in/out asymptotes (rad)
  e: number; // hyperbola eccentricity that bends by exactly `turn`
  rp: number; // periapsis radius for that bend at v∞_in (m)
  b: number; // impact-parameter magnitude (m)
  bHat: Vec3; // unit B-vector: in the B-plane (⊥ v∞_in), in the bend plane
  planeNormal: Vec3; // unit normal of the flyby plane (v̂∞_in × v̂∞_out)
}

/**
 * The free-bend B-plane aim that rotates the incoming excess velocity into the
 * direction of the outgoing one (an unpowered pass preserves |v∞|, so only the
 * DIRECTION is targeted). Returns the hyperbola (e, rp) that bends by exactly the
 * required angle, the impact parameter b, and the B-vector direction — the
 * perpendicular aim offset that, threaded through the body's B-plane, produces the
 * bend. The B-plane is ⊥ to v∞_in; the trajectory curves toward periapsis, so the
 * B-vector points the opposite way (toward where the asymptote pierces the plane).
 */
export function bPlaneAim(vInfInVec: Vec3, vInfOutVec: Vec3, mu: number): BPlaneAim {
  const vIn = length(vInfInVec);
  const inHat = normalize(vInfInVec);
  const outHat = normalize(vInfOutVec);
  const cosT = Math.max(-1, Math.min(1, dot(inHat, outHat)));
  const turn = Math.max(Math.acos(cosT), 1e-9); // guard the no-bend limit (b → ∞)
  const e = 1 / Math.sin(turn / 2); // eccentricity that bends by `turn`
  const rp = ((e - 1) * mu) / (vIn * vIn); // periapsis for this e at v∞_in
  const b = rp * Math.sqrt((e + 1) / (e - 1));
  // Bend direction = outHat's component ⊥ inHat; periapsis is on that side, so the
  // B-vector (the asymptote's piercing point) sits on the opposite side.
  const perp = sub(outHat, scale(inHat, dot(outHat, inHat)));
  const bHat = length(perp) > 1e-12
    ? scale(normalize(perp), -1)
    : normalize(cross(inHat, { x: 0, y: 0, z: 1 }));
  const planeNormal = normalize(cross(vInfInVec, vInfOutVec));
  return { turn, e, rp, b, bHat, planeNormal };
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
