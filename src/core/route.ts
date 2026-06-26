/**
 * Reconstruct the full planned trajectory of an interplanetary transfer for the
 * route overlay: the heliocentric Lambert arc (one leg, or two for a gravity
 * assist) plus optional context rings at the departure and arrival bodies.
 *
 * The arc is built from the SAME calls the sim makes when it actually flies the
 * transfer (`lambert(... MU_SUN, true)` then `stateToElements(depPos, v1, MU_SUN)`
 * — see sim.executeDeparture), so the drawn route is the trajectory the ship will
 * fly, not a second model that could drift. It is sampled by propagating that
 * conic in time, which handles elliptic AND hyperbolic partial arcs without the
 * closed-ellipse artifact a full `orbitPath` would give.
 *
 * Pure (no THREE): returns world-frame (heliocentric) points in metres.
 */

import { type Vec3, add } from "./math/vec3.ts";
import { lambert } from "./maneuver/lambert.ts";
import { stateToElements, elementsToState, propagate, orbitPath } from "./math/kepler.ts";
import { circularOrbit } from "./orbit.ts";
import { bodyState } from "./ephemeris.ts";
import { BODY_BY_ID, MU_SUN } from "./constants.ts";

export type RouteLegKind = "park-from" | "helio" | "park-to";

export interface RouteLeg {
  kind: RouteLegKind;
  points: Vec3[]; // world (heliocentric) metres
}

export interface PlannedRoute {
  legs: RouteLeg[];
  depPoint: Vec3; // departure body centre at tDepart
  arrPoint: Vec3; // target body centre at tArrive
  flybyPoint?: Vec3; // flyby body centre at tFlyby (assist routes)
  ok: boolean; // false ⇒ degenerate geometry; renderer hides it
}

export interface RouteArgs {
  fromId: string;
  targetId: string;
  tDepart: number;
  tArrive: number;
  /** Optional context ring radii at the departure / arrival bodies (m). */
  rParkFrom?: number;
  rParkTo?: number;
  /** Optional gravity-assist leg between departure and the target. */
  flyby?: { bodyId: string; tFlyby: number };
  /** Heliocentric arc sample count (split across the two legs for an assist). */
  segments?: number;
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

/** Sample a heliocentric conic (seeded at r0 with velocity v1) over `tof`. */
function sampleConic(r0: Vec3, v1: Vec3, tof: number, segments: number): Vec3[] {
  const el0 = stateToElements(r0, v1, MU_SUN);
  const pts: Vec3[] = new Array(segments + 1);
  for (let k = 0; k <= segments; k++) {
    pts[k] = elementsToState(propagate(el0, MU_SUN, (tof * k) / segments), MU_SUN).r;
  }
  return pts;
}

/** A circular context ring (in the ecliptic plane) about a body at `bodyWorld`. */
function ring(bodyWorld: Vec3, rPark: number, segments = 64): Vec3[] {
  return orbitPath(circularOrbit(rPark, 0, 0, 0), segments).map((p) => add(bodyWorld, p));
}

export function planRoute(args: RouteArgs): PlannedRoute {
  const { fromId, targetId, tDepart, tArrive } = args;
  const segments = args.segments ?? 256;
  const from = BODY_BY_ID.get(fromId);
  const target = BODY_BY_ID.get(targetId);
  if (!from || !target || tArrive <= tDepart) {
    return { legs: [], depPoint: ZERO, arrPoint: ZERO, ok: false };
  }

  const depPoint = bodyState(from, tDepart).r;
  const arrPoint = bodyState(target, tArrive).r;
  const legs: RouteLeg[] = [];

  // Gravity-assist: two heliocentric legs meeting at the flyby body.
  if (args.flyby) {
    const fb = BODY_BY_ID.get(args.flyby.bodyId);
    const tFlyby = args.flyby.tFlyby;
    if (!fb || tFlyby <= tDepart || tArrive <= tFlyby) {
      return { legs: [], depPoint, arrPoint, ok: false };
    }
    const fbPoint = bodyState(fb, tFlyby).r;
    const leg1 = lambert(depPoint, fbPoint, tFlyby - tDepart, MU_SUN, true);
    const leg2 = lambert(fbPoint, arrPoint, tArrive - tFlyby, MU_SUN, true);
    if (!leg1 || !leg2) return { legs: [], depPoint, arrPoint, flybyPoint: fbPoint, ok: false };
    const half = Math.max(2, Math.round(segments / 2));
    if (args.rParkFrom) legs.push({ kind: "park-from", points: ring(depPoint, args.rParkFrom) });
    legs.push({ kind: "helio", points: sampleConic(depPoint, leg1.v1, tFlyby - tDepart, half) });
    legs.push({ kind: "helio", points: sampleConic(fbPoint, leg2.v1, tArrive - tFlyby, half) });
    if (args.rParkTo) legs.push({ kind: "park-to", points: ring(arrPoint, args.rParkTo) });
    return { legs, depPoint, arrPoint, flybyPoint: fbPoint, ok: true };
  }

  // Direct: one heliocentric leg.
  const sol = lambert(depPoint, arrPoint, tArrive - tDepart, MU_SUN, true);
  if (!sol) return { legs: [], depPoint, arrPoint, ok: false };
  if (args.rParkFrom) legs.push({ kind: "park-from", points: ring(depPoint, args.rParkFrom) });
  legs.push({ kind: "helio", points: sampleConic(depPoint, sol.v1, tArrive - tDepart, segments) });
  if (args.rParkTo) legs.push({ kind: "park-to", points: ring(arrPoint, args.rParkTo) });
  return { legs, depPoint, arrPoint, ok: true };
}
