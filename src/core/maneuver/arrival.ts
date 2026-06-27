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
import { stateToElements, elementsToState, propagate, wrapPi } from "../math/kepler.ts";
import { bodyState, bodyStateRelative, bodyElements } from "../ephemeris.ts";
import { soiRadius, j2Rates } from "../orbit.ts";
import { type BodyDef, BODY_BY_ID, MU_SUN } from "../constants.ts";

export interface AimResult {
  v1: Vec3; // heliocentric departure velocity to fly
  tSoi: number; // sphere-of-influence entry time (s since J2000)
  periapsis: number; // achieved target-relative periapsis radius (m)
  vInf?: number; // target-relative approach speed at SOI entry (m/s) — sized for the capture burn
}

interface Probe {
  peri: number;
  sol: LambertSolution;
  tSoi: number;
  vInf: number; // target-relative speed at SOI entry
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
    return { peri: el.a * (1 - el.e), sol, tSoi, vInf: length(sub(sh.v, tg.v)) };
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

  return { v1: best.sol.v1, tSoi: best.tSoi, periapsis: best.peri, vInf: best.vInf };
}

/**
 * The parent-frame twin of aimArrival for a MOON transfer: find the PARENT-centric transfer
 * from a fixed parking-orbit position `depPos` that arrives at `moon` with a moon-relative
 * periapsis ≈ rPeri, so the capture circularizes ABOVE the surface (not on a collision
 * course through the moon's centre). Everything is in the parent's frame (parent.mu and
 * parent-relative moon positions); otherwise identical bisection to aimArrival.
 */
export function aimMoonArrival(
  parent: BodyDef,
  moon: BodyDef,
  depPos: Vec3,
  tDepart: number,
  tArrive: number,
  rPeri: number,
): AimResult | null {
  const tof = tArrive - tDepart;
  const moonArr = bodyStateRelative(moon, tArrive);
  const center = lambert(depPos, moonArr.r, tof, parent.mu, true);
  if (!center) return null;

  const vInfVec = sub(center.v2, moonArr.v);
  let offDir = cross(vInfVec, { x: 0, y: 0, z: 1 });
  if (length(offDir) < 1e-9) offDir = cross(vInfVec, { x: 1, y: 0, z: 0 });
  offDir = normalize(offDir);

  const rSoi = soiRadius(bodyElements(moon, tArrive)!.a, moon.mu, parent.mu);

  const probe = (d: number): Probe | null => {
    const aim = add(moonArr.r, scale(offDir, d));
    const sol = lambert(depPos, aim, tof, parent.mu, true);
    if (!sol) return null;
    const shipEl = stateToElements(depPos, sol.v1, parent.mu);
    // Propagate the parent-centric cruise the SAME way the sim does (coastElements): with the
    // parent's J2 secular precession. A gas giant's J2 is large and a moon's SOI is small, so
    // omitting it (as a plain Kepler propagation would) drifts the ship clean out of the SOI and
    // the patched-conic aim misses — the aim must match the flown trajectory.
    const cruise = (t: number) => {
      const el = propagate(shipEl, parent.mu, t - tDepart);
      if (parent.J2 && el.e < 1) {
        const r = j2Rates(parent.mu, parent.radius, parent.J2, el.a, el.e, el.i);
        el.Omega = wrapPi(el.Omega + r.nodeDot * (t - tDepart));
        el.omega = wrapPi(el.omega + r.periDot * (t - tDepart));
        el.M = wrapPi(el.M + r.anomalyDot * (t - tDepart));
      }
      return elementsToState(el, parent.mu);
    };
    const dist = (t: number): number => distance(cruise(t).r, bodyStateRelative(moon, t).r);
    if (dist(tArrive) > rSoi) return null;
    let lo = tDepart, hi = tArrive;
    for (let i = 0; i < 64; i++) {
      const mid = (lo + hi) / 2;
      if (dist(mid) > rSoi) lo = mid; else hi = mid;
    }
    const tSoi = hi;
    const sh = cruise(tSoi);
    const tg = bodyStateRelative(moon, tSoi);
    const el = stateToElements(sub(sh.r, tg.r), sub(sh.v, tg.v), moon.mu);
    return { peri: el.a * (1 - el.e), sol, tSoi, vInf: length(sub(sh.v, tg.v)) };
  };

  // The aim OFFSET must stay inside the moon's SOI: a tight SOI (a Galilean is ~10⁴ km,
  // far smaller than the Moon's ~66·10³) can be smaller than the planet-arrival default of
  // rPeri·8, which would put the aim point OUTSIDE the SOI so the approach never enters it.
  const hiCap = 0.9 * rSoi;
  let lo = rPeri * 0.05;
  let hi = Math.min(rPeri * 8, hiCap);
  let best = probe(hi);
  let guard = 0;
  while ((!best || !isFinite(best.peri) || best.peri < rPeri) && hi < hiCap && guard++ < 40) {
    hi = Math.min(hi * 1.5, hiCap);
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

  return { v1: best.sol.v1, tSoi: best.tSoi, periapsis: best.peri, vInf: best.vInf };
}
