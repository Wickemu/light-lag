/**
 * Intra-system (moon) transfer windows — a small parent-centric "porkchop" for hopping
 * from a parking orbit about a planet to one of its moons (LEO → the Moon, Jupiter orbit →
 * a Galilean, …). The transfer is a Lambert arc about the PARENT planet, not the Sun.
 *
 * Pure core: deterministic, bounded grid search. Used by the planner UI and by the in-sim
 * auto-chain that fires the moon leg of a cross-system mission on arrival at the planet.
 */

import { type Vec3, length, sub } from "../math/vec3.ts";
import { hohmann } from "./hohmann.ts";
import { aimMoonArrival } from "./arrival.ts";
import { hyperbolicBurnDv } from "../orbit.ts";
import { bodyStateRelative } from "../ephemeris.ts";
import { BODY_BY_ID, DEFAULT_CAPTURE_ALT } from "../constants.ts";

/** A planned moon-transfer window: the cheapest departure/arrival found, with its costs. */
export interface MoonWindow {
  tDepart: number;
  tArrive: number;
  dvDepart: number; // injection from the parking orbit (m/s)
  dvArrive: number; // capture about the moon (m/s)
}

/**
 * Find a cheap parent-centric transfer window from a parking orbit about `parentId` to one
 * of its moons, searching departure phase over one moon period × a time-of-flight band around
 * the Hohmann estimate, ranked by injection + capture Δv. `shipState(t)` gives the parking
 * orbit's PARENT-relative state at time t, `aPark` its radius. Deterministic, bounded. null if
 * the moon doesn't orbit `parentId` or no solution is found.
 */
export function searchMoonWindow(
  parentId: string, moonId: string, t0: number, shipState: (t: number) => { r: Vec3; v: Vec3 }, aPark: number,
): MoonWindow | null {
  const parent = BODY_BY_ID.get(parentId);
  const moon = BODY_BY_ID.get(moonId);
  if (!parent || !moon || moon.parent !== parentId) return null;
  const rMoon = length(bodyStateRelative(moon, t0).r);
  const moonPeriod = 2 * Math.PI * Math.sqrt((rMoon * rMoon * rMoon) / parent.mu);
  const hTof = hohmann(parent.mu, aPark, rMoon).tof;
  const rParkTo = moon.radius + DEFAULT_CAPTURE_ALT;

  // Each cell is scored with the SAME J2-aware B-plane aim the sim flies (aimMoonArrival), not a
  // plain Lambert: a gas giant's J2 precesses the cruise enough over the short hop that a
  // Lambert-optimal window can be unflyable (the offset aim never enters the moon's small SOI).
  // Scoring with the real aim keeps the chosen window consistent with the executed trajectory.
  let best: MoonWindow | null = null;
  let bestTotal = Infinity;
  for (let i = 0; i < 24; i++) {
    const tDep = t0 + (moonPeriod * i) / 24;
    const dep = shipState(tDep);
    for (let j = 0; j < 7; j++) {
      const tof = hTof * (0.7 + (0.7 * j) / 6);
      const tArr = tDep + tof;
      const aim = aimMoonArrival(parent, moon, dep.r, tDep, tArr, rParkTo);
      if (!aim) continue;
      const dvDepart = length(sub(aim.v1, dep.v));
      const dvArrive = hyperbolicBurnDv(aim.vInf ?? 0, moon.mu, rParkTo);
      const total = dvDepart + dvArrive;
      if (total < bestTotal) { bestTotal = total; best = { tDepart: tDep, tArrive: tArr, dvDepart, dvArrive }; }
    }
  }
  return best;
}
