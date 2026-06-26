/**
 * Force breakdown for the gravity / momentum overlay: for a focused body or ship,
 * the dominant gravitational pull (toward its primary), the perturbing influence
 * of a second body (the Sun), and the object's own velocity — the "inertia" that,
 * combined with the pull, resolves into the orbit you see.
 *
 * Two subtleties make this read the way intuition expects:
 *   - Velocity is PRIMARY-RELATIVE, so the Moon's arrow shows its ~1 km/s orbit
 *     about Earth, not its ~30 km/s heliocentric motion.
 *   - The secondary (Sun) term is the TIDAL/differential acceleration relative to
 *     the primary, not the raw solar pull. The raw solar force on the Moon is
 *     actually ~2× Earth's, which would be baffling; what perturbs the Moon's
 *     Earth-relative orbit is the DIFFERENCE between the Sun's pull on the Moon
 *     and on the Earth — a faint ~1% term, exactly the "small extra influence"
 *     the indicator is meant to convey.
 *
 * Pure (no THREE); same inverse-square law the integrator uses (sim.ts gfac).
 */

import { type Ship } from "./world.ts";
import { type Vec3, sub, scale, normalize, length } from "./math/vec3.ts";
import { type BodyDef, BODY_BY_ID, MU_SUN } from "./constants.ts";
import { bodyState, bodyStateRelative, bodyElements } from "./ephemeris.ts";
import { primaryMu, shipWorldState, shipRelativeState, shipOsculatingElements } from "./ships.ts";

export interface AttractorPull {
  attractorId: string;
  /** Acceleration vector (m/s²): the central pull points TOWARD the attractor; a
   *  secondary "tidal" pull is the differential perturbation (any direction). */
  gravAccel: Vec3;
  magnitude: number;
  /** True for the differential (tidal) secondary term, false for a direct pull. */
  tidal: boolean;
}

export interface ForceBreakdown {
  position: Vec3; // object world position (m)
  velocity: Vec3; // PRIMARY-relative velocity (m/s)
  speed: number;
  /** Dominant pull first, then the optional secondary (tidal) term. */
  pulls: AttractorPull[];
  a: number; // semi-major axis about the dominant attractor (m)
  gRefA: number; // muDom / a² — circular-gravity reference (constant over the orbit)
  vRefA: number; // sqrt(muDom / |a|) — circular-speed reference
}

/** Direct inverse-square pull of `muAtt` at `rAtt` on a body at `rObj`, pointing
 *  toward the attractor. */
function directPull(rObj: Vec3, rAtt: Vec3, muAtt: number, id: string): AttractorPull {
  const d = sub(rAtt, rObj);
  const r = length(d);
  if (r === 0) return { attractorId: id, gravAccel: { x: 0, y: 0, z: 0 }, magnitude: 0, tidal: false };
  const g = muAtt / (r * r);
  return { attractorId: id, gravAccel: scale(normalize(d), g), magnitude: g, tidal: false };
}

/** Tidal (differential) acceleration on `rObj` relative to its `rPrimary` from a
 *  third body `rB` of parameter `muB`: the perturbation that actually influences
 *  the primary-relative orbit. */
function tidalPull(rObj: Vec3, rPrimary: Vec3, rB: Vec3, muB: number, id: string): AttractorPull {
  const accel = (from: Vec3): Vec3 => {
    const d = sub(rB, from);
    const r = length(d);
    return r === 0 ? { x: 0, y: 0, z: 0 } : scale(d, muB / (r * r * r));
  };
  const aObj = accel(rObj);
  const aPrim = accel(rPrimary);
  const g = sub(aObj, aPrim);
  return { attractorId: id, gravAccel: g, magnitude: length(g), tidal: true };
}

function refs(muDom: number, a: number): { gRefA: number; vRefA: number } {
  const aAbs = Math.abs(a) || 1;
  return { gRefA: muDom / (aAbs * aAbs), vRefA: Math.sqrt(muDom / aAbs) };
}

/** Force breakdown for a natural body. Null for the Sun (no parent orbit). */
export function bodyForceBreakdown(def: BodyDef, t: number): ForceBreakdown | null {
  if (!def.parent) return null;
  const parent = BODY_BY_ID.get(def.parent);
  if (!parent) return null;
  const sun = BODY_BY_ID.get("sun")!;

  const position = bodyState(def, t).r;
  const velocity = bodyStateRelative(def, t).v; // parent-relative
  const a = bodyElements(def, t)?.a ?? length(bodyStateRelative(def, t).r);
  const muDom = parent.mu;
  const parentPos = bodyState(parent, t).r;

  const pulls: AttractorPull[] = [directPull(position, parentPos, muDom, parent.id)];
  // Secondary: the Sun's tidal perturbation on the primary-relative orbit (only
  // when the primary isn't already the Sun).
  if (parent.id !== "sun") {
    pulls.push(tidalPull(position, parentPos, bodyState(sun, t).r, MU_SUN, "sun"));
  }

  return { position, velocity, speed: length(velocity), pulls, a, ...refs(muDom, a) };
}

/** Force breakdown for a ship. Null on an interstellar leg (no local orbit). */
export function shipForceBreakdown(ship: Ship, t: number): ForceBreakdown | null {
  if (ship.interstellarLeg) return null;
  const primary = BODY_BY_ID.get(ship.primary);
  if (!primary) return null;
  const sun = BODY_BY_ID.get("sun")!;

  const position = shipWorldState(ship, t).r;
  const velocity = shipRelativeState(ship, t).v; // primary-relative
  const a = shipOsculatingElements(ship, t).a;
  const muDom = primaryMu(ship);
  const primaryPos = bodyState(primary, t).r;

  const pulls: AttractorPull[] = [directPull(position, primaryPos, muDom, primary.id)];
  if (primary.id !== "sun") {
    pulls.push(tidalPull(position, primaryPos, bodyState(sun, t).r, MU_SUN, "sun"));
  }

  return { position, velocity, speed: length(velocity), pulls, a, ...refs(muDom, a) };
}
