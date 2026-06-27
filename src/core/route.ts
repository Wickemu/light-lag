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
  flybyPoints?: Vec3[]; // flyby body centres at each tFlyby, in order (assist routes)
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
  /** Optional gravity-assist flyby chain between departure and the target, in order. */
  flybys?: { bodyId: string; tFlyby: number }[];
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

  // Gravity-assist: N+1 heliocentric legs meeting at each flyby body in the chain.
  if (args.flybys && args.flybys.length > 0) {
    // Waypoints: departure → each flyby body's centre → target, with strictly
    // increasing times.
    const times = [tDepart, ...args.flybys.map((f) => f.tFlyby), tArrive];
    const points: Vec3[] = [depPoint];
    const flybyPoints: Vec3[] = [];
    for (const f of args.flybys) {
      const fb = BODY_BY_ID.get(f.bodyId);
      if (!fb) return { legs: [], depPoint, arrPoint, ok: false };
      const p = bodyState(fb, f.tFlyby).r;
      points.push(p);
      flybyPoints.push(p);
    }
    points.push(arrPoint);
    for (let i = 1; i < times.length; i++) if (times[i]! <= times[i - 1]!) {
      return { legs: [], depPoint, arrPoint, flybyPoints, ok: false };
    }
    const per = Math.max(2, Math.round(segments / (times.length - 1)));
    if (args.rParkFrom) legs.push({ kind: "park-from", points: ring(depPoint, args.rParkFrom) });
    for (let i = 0; i < times.length - 1; i++) {
      const tof = times[i + 1]! - times[i]!;
      const leg = lambert(points[i]!, points[i + 1]!, tof, MU_SUN, true);
      if (!leg) return { legs: [], depPoint, arrPoint, flybyPoints, ok: false };
      legs.push({ kind: "helio", points: sampleConic(points[i]!, leg.v1, tof, per) });
    }
    if (args.rParkTo) legs.push({ kind: "park-to", points: ring(arrPoint, args.rParkTo) });
    return { legs, depPoint, arrPoint, flybyPoints, ok: true };
  }

  // Direct: one heliocentric leg.
  const sol = lambert(depPoint, arrPoint, tArrive - tDepart, MU_SUN, true);
  if (!sol) return { legs: [], depPoint, arrPoint, ok: false };
  if (args.rParkFrom) legs.push({ kind: "park-from", points: ring(depPoint, args.rParkFrom) });
  legs.push({ kind: "helio", points: sampleConic(depPoint, sol.v1, tArrive - tDepart, segments) });
  if (args.rParkTo) legs.push({ kind: "park-to", points: ring(arrPoint, args.rParkTo) });
  return { legs, depPoint, arrPoint, ok: true };
}
