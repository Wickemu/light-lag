/**
 * Arrival targeting (a B-plane aim).
 *
 * A Lambert solution aimed at a planet's centre is a collision course; a real
 * mission aims slightly off-centre so the approach hyperbola has periapsis at
 * the desired capture altitude. We solve for that aim by bisection on the
 * perpendicular offset — but we evaluate the periapsis at the ACTUAL
 * sphere-of-influence entry state, not at the arrival instant, because the
 * target body moves appreciably during the days-long SOI passage and the
 * Mars-relative hyperbola is what actually determines the periapsis.
 *
 * This is honest patched-conic navigation; the offset stands in for the
 * cruise-phase midcourse corrections every real mission performs.
 */

import { type Vec3, add, sub, scale, cross, normalize, length, distance } from "../math/vec3.ts";
import { lambert, type LambertSolution } from "./lambert.ts";
import { stateToElements, elementsToState, propagate } from "../math/kepler.ts";
import { bodyState, bodyElements } from "../ephemeris.ts";
import { soiRadius } from "../orbit.ts";
import { type BodyDef, BODY_BY_ID, MU_SUN } from "../constants.ts";

export interface AimResult {
  v1: Vec3; // heliocentric departure velocity to fly
  tSoi: number; // sphere-of-influence entry time (s since J2000)
  periapsis: number; // achieved target-relative periapsis radius (m)
}

interface Probe {
  peri: number;
  sol: LambertSolution;
  tSoi: number;
}

/**
 * Find the heliocentric transfer from `depBody` that arrives at `target` with a
 * target-relative periapsis ≈ rPeri. Returns null if no usable solution.
 */
export function aimArrival(
  depBody: BodyDef,
  target: BodyDef,
  tDepart: number,
  tArrive: number,
  rPeri: number,
): AimResult | null {
  const tof = tArrive - tDepart;
  const depPos = bodyState(depBody, tDepart).r;
  const tgtArr = bodyState(target, tArrive);

  const center = lambert(depPos, tgtArr.r, tof, MU_SUN, true);
  if (!center) return null;

  // Offset perpendicular to the approach (in the ecliptic where possible).
  const vInfVec = sub(center.v2, tgtArr.v);
  let offDir = cross(vInfVec, { x: 0, y: 0, z: 1 });
  if (length(offDir) < 1e-9) offDir = cross(vInfVec, { x: 1, y: 0, z: 0 });
  offDir = normalize(offDir);

  const parentMu = target.parent ? BODY_BY_ID.get(target.parent)!.mu : MU_SUN;
  const rSoi = soiRadius(bodyElements(target, tArrive)!.a, target.mu, parentMu);

  // Periapsis (evaluated at SOI entry) for a given perpendicular offset d.
  const probe = (d: number): Probe | null => {
    const aim = add(tgtArr.r, scale(offDir, d));
    const sol = lambert(depPos, aim, tof, MU_SUN, true);
    if (!sol) return null;
    const shipEl = stateToElements(depPos, sol.v1, MU_SUN); // heliocentric, epoch tDepart
    const shipAt = (t: number): Vec3 =>
      elementsToState(propagate(shipEl, MU_SUN, t - tDepart), MU_SUN).r;
    const dist = (t: number): number => distance(shipAt(t), bodyState(target, t).r);
    if (dist(tArrive) > rSoi) return null; // never enters the SOI

    let lo = tDepart, hi = tArrive;
    for (let i = 0; i < 64; i++) {
      const mid = (lo + hi) / 2;
      if (dist(mid) > rSoi) lo = mid;
      else hi = mid;
    }
    const tSoi = hi;
    const sh = elementsToState(propagate(shipEl, MU_SUN, tSoi - tDepart), MU_SUN);
    const tg = bodyState(target, tSoi);
    const el = stateToElements(sub(sh.r, tg.r), sub(sh.v, tg.v), target.mu);
    return { peri: el.a * (1 - el.e), sol, tSoi };
  };

  // Bisection on the offset: periapsis grows with d.
  let lo = rPeri * 0.05;
  let hi = rPeri * 8;
  let best = probe(hi);
  let guard = 0;
  while ((!best || !isFinite(best.peri) || best.peri < rPeri) && guard++ < 40) {
    hi *= 1.5;
    best = probe(hi);
  }
  if (!best) return null;

  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const r = probe(mid);
    if (!r || !isFinite(r.peri)) { lo = mid; continue; }
    if (r.peri > rPeri) { hi = mid; best = r; } else { lo = mid; }
    if (Math.abs(r.peri - rPeri) < 1) { best = r; break; }
  }

  return { v1: best.sol.v1, tSoi: best.tSoi, periapsis: best.peri };
}
