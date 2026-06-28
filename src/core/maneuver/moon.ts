/**
 * Intra-system (moon) transfer windows — a small parent-centric "porkchop" for hopping
 * from a parking orbit about a planet to one of its moons (LEO → the Moon, Jupiter orbit →
 * a Galilean, …). The transfer is a Lambert arc about the PARENT planet, not the Sun.
 *
 * Pure core: deterministic, bounded grid search. Used by the planner UI and by the in-sim
 * auto-chain that fires the moon leg of a cross-system mission on arrival at the planet.
 */

import { type Vec3, length, sub } from "../math/vec3.ts";
import { stateToElements } from "../math/kepler.ts";
import { hohmann } from "./hohmann.ts";
import { lambert } from "./lambert.ts";
import { aimMoonArrival } from "./arrival.ts";
import { hyperbolicBurnDv } from "../orbit.ts";
import { bodyStateRelative } from "../ephemeris.ts";
import { BODY_BY_ID, DEFAULT_CAPTURE_ALT } from "../constants.ts";

/**
 * Does the parent-centric outbound transfer (the ship seeded at `depR` with the injection
 * velocity `v1`) keep its PARENT-relative periapsis above the parent's surface? A moon
 * transfer is flown about the parent (the ship never leaves its SOI), so an injection solved
 * only against the moon-relative arrival can, for an unfavourable parking-orbit phase, put the
 * outbound conic's periapsis BELOW the parent — flying the ship straight into the planet at
 * departure. The sim's surface-impact guard then (correctly) destroys it. A real translunar
 * injection burns at the right point in the parking orbit so periapsis stays above the surface;
 * we enforce that here by rejecting windows whose outbound conic dips below the parent's radius.
 * The test is an ABSOLUTE surface comparison (periapsis >= parentRadius), so it scales across
 * every parent from Mars to Jupiter — a radius FRACTION would wrongly reject a low parking orbit
 * at a giant, whose altitude is a tiny fraction of its radius. The sim crashes a coasting ship
 * only at r <= R and the coast carries no drag, so clearing R is exactly the safe condition.
 * Hyperbolic/degenerate conics (a <= 0) clear by construction (no near-side periapsis below the
 * departure point on a departing arc).
 */
export function outboundClearsParent(depR: Vec3, v1: Vec3, parentMu: number, parentRadius: number): boolean {
  const el = stateToElements(depR, v1, parentMu);
  if (!isFinite(el.a) || !isFinite(el.e)) return false;
  if (el.a <= 0) return true; // unbound — periapsis is the closest approach of a departing arc
  const periapsis = el.a * (1 - el.e);
  return periapsis >= parentRadius;
}

/** A planned moon-transfer window: the cheapest departure/arrival found, with its costs. */
export interface MoonWindow {
  tDepart: number;
  tArrive: number;
  dvDepart: number; // injection from the parking orbit (m/s)
  dvArrive: number; // capture about the moon (m/s)
}

/**
 * Find a cheap parent-centric transfer window from a parking orbit about `parentId` to one of
 * its moons, ranked by injection + capture Δv. `shipState(t)` gives the parking orbit's
 * PARENT-relative state at time t, `aPark` its radius. Deterministic, bounded. null if the moon
 * doesn't orbit `parentId` or no solution is found.
 *
 * Two-stage search. A parking orbit inclined to the moon's plane — e.g. a Saturn V's ~39° LEO
 * about an axially-tilted Earth — only has a CHEAP injection from a narrow band of departure
 * points: those near the node where the parking plane meets the transfer plane, where the burn is
 * nearly in-plane. Depart anywhere else and the injection pays a steep plane change. That node
 * also sweeps past fast: a LEO is ~90 min while the Moon's geometry turns over ~27 days, so a grid
 * that samples only the slow moon phase aliases right over the cheap departure point and reports a
 * needlessly expensive window (or none). So we sample the PARKING-ORBIT phase finely too, but
 * score the dense grid with a cheap centre-aimed Lambert; only the few cheapest candidates are
 * then refined with the exact J2-aware B-plane aim the sim actually flies (aimMoonArrival), so the
 * chosen window stays consistent with the executed trajectory.
 */
export function searchMoonWindow(
  parentId: string, moonId: string, t0: number, shipState: (t: number) => { r: Vec3; v: Vec3 }, aPark: number,
): MoonWindow | null {
  const parent = BODY_BY_ID.get(parentId);
  const moon = BODY_BY_ID.get(moonId);
  if (!parent || !moon || moon.parent !== parentId) return null;
  const rMoon = length(bodyStateRelative(moon, t0).r);
  const moonPeriod = 2 * Math.PI * Math.sqrt((rMoon * rMoon * rMoon) / parent.mu);
  const parkPeriod = 2 * Math.PI * Math.sqrt((aPark * aPark * aPark) / parent.mu);
  const hTof = hohmann(parent.mu, aPark, rMoon).tof;
  const rParkTo = moon.radius + DEFAULT_CAPTURE_ALT;

  const N_MOON = 12; // arrival geometry samples over one moon period
  const N_TOF = 5;   // time-of-flight band around the Hohmann estimate
  const N_PARK = 12; // departure-POINT samples over one parking-orbit period (the new axis)
  const KEEP = 8;    // cheapest candidates to refine with the exact aim
  const MAX_REFINE = 24; // hard cap on exact-aim calls (skips over unflyable candidates)

  // ── Stage 1: cheap dense scan — moon geometry × time-of-flight × parking-orbit phase,
  // each scored with a plain centre-aimed Lambert (one solve, no B-plane bisection). ──
  const cands: { tDep: number; tArr: number; est: number }[] = [];
  for (let i = 0; i < N_MOON; i++) {
    const tArrBase = t0 + hTof + (moonPeriod * i) / N_MOON;
    for (let j = 0; j < N_TOF; j++) {
      const tof = hTof * (0.7 + (0.7 * j) / (N_TOF - 1));
      for (let k = 0; k < N_PARK; k++) {
        const tDep = tArrBase - tof + (parkPeriod * k) / N_PARK; // slide the departure point
        if (tDep <= t0) continue;
        const tArr = tDep + tof;
        const dep = shipState(tDep);
        const moonArr = bodyStateRelative(moon, tArr);
        const sol = lambert(dep.r, moonArr.r, tof, parent.mu, true);
        if (!sol) continue;
        if (!outboundClearsParent(dep.r, sol.v1, parent.mu, parent.radius)) continue;
        const dvDepart = length(sub(sol.v1, dep.v));
        const dvArrive = hyperbolicBurnDv(length(sub(sol.v2, moonArr.v)), moon.mu, rParkTo);
        cands.push({ tDep, tArr, est: dvDepart + dvArrive });
      }
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.est - b.est);

  // ── Stage 2: refine the cheapest candidates with the exact aim — the B-plane offset + J2
  // cruise the sim flies — and keep the best FLYABLE window. Scan past any candidate the exact
  // aim can't realise (offset never enters the moon's SOI), up to MAX_REFINE attempts. ──
  let best: MoonWindow | null = null;
  let bestTotal = Infinity;
  let refined = 0;
  for (let n = 0; n < cands.length && n < MAX_REFINE && refined < KEEP; n++) {
    const c = cands[n]!;
    const dep = shipState(c.tDep);
    const aim = aimMoonArrival(parent, moon, dep.r, c.tDep, c.tArr, rParkTo);
    if (!aim) continue;
    if (!outboundClearsParent(dep.r, aim.v1, parent.mu, parent.radius)) continue;
    refined++;
    const dvDepart = length(sub(aim.v1, dep.v));
    const dvArrive = hyperbolicBurnDv(aim.vInf ?? 0, moon.mu, rParkTo);
    const total = dvDepart + dvArrive;
    if (total < bestTotal) { bestTotal = total; best = { tDepart: c.tDep, tArrive: c.tArr, dvDepart, dvArrive }; }
  }
  return best;
}
