/**
 * Porkchop plot: sweep a grid of (departure date, time-of-flight) and solve
 * Lambert at each cell to get the departure and arrival Δv. The low-Δv island
 * that appears IS the launch window — there is no separate "window" rule, it
 * falls out of orbital geometry. The minimum cell is the cheapest transfer.
 *
 * SI: times in seconds since J2000, Δv in m/s.
 */

import { BODY_BY_ID } from "../constants.ts";
import { bodyState } from "../ephemeris.ts";
import { length, sub } from "../math/vec3.ts";
import { hyperbolicBurnDv } from "../orbit.ts";
import { lambert, type LambertSolution } from "./lambert.ts";

/** Best Lambert leg over the direct and the first couple of multi-rev branches,
 *  scored by the characteristic energy (departure + arrival v∞²). A long-TOF cell
 *  that a 1- or 2-rev transfer flies more cheaply than the direct path picks the
 *  cheaper branch — the multi-rev island the direct solver can't see. */
function bestLeg(r1: { x: number; y: number; z: number }, r2: { x: number; y: number; z: number },
  tof: number, mu: number, vDep: { x: number; y: number; z: number },
  vArr: { x: number; y: number; z: number }): LambertSolution | null {
  let best: LambertSolution | null = null;
  let bestC3 = Infinity;
  const consider = (sol: LambertSolution | null): void => {
    if (!sol) return;
    const vInfDep = length(sub(sol.v1, vDep));
    const vInfArr = length(sub(sol.v2, vArr));
    const c3 = vInfDep * vInfDep + vInfArr * vInfArr;
    if (c3 < bestC3) { bestC3 = c3; best = sol; }
  };
  consider(lambert(r1, r2, tof, mu, true));
  for (let n = 1; n <= 2; n++) {
    consider(lambert(r1, r2, tof, mu, true, { nrev: n, lowPath: true }));
    consider(lambert(r1, r2, tof, mu, true, { nrev: n, lowPath: false }));
  }
  return best;
}

export interface PorkCell {
  depT: number; // departure time (s since J2000)
  tof: number; // time of flight (s)
  arrT: number;
  dvDepart: number; // Oberth-aware injection burn from the parking orbit (m/s)
  dvArrive: number; // Oberth-aware capture burn into the target parking orbit (m/s)
  total: number;
}

export interface Porkchop {
  fromId: string;
  toId: string;
  depStart: number;
  depStep: number;
  depN: number;
  tofStart: number;
  tofStep: number;
  tofN: number;
  cells: PorkCell[][]; // [depIndex][tofIndex]
  best: PorkCell | null;
  maxFinite: number; // largest finite total (for colour scaling)
}

export interface PorkchopParams {
  fromId: string;
  toId: string;
  depStart: number;
  depEnd: number;
  depN: number;
  tofMin: number;
  tofMax: number;
  tofN: number;
  /** Radius (m) of the departure parking orbit, for the Oberth-aware injection. */
  rParkFrom: number;
  /** Radius (m) of the target capture orbit, for the Oberth-aware capture. */
  rParkTo: number;
}

/** Compute a porkchop grid of heliocentric transfers from one body to another. */
export function computePorkchop(p: PorkchopParams): Porkchop {
  const muSun = BODY_BY_ID.get("sun")!.mu;
  const from = BODY_BY_ID.get(p.fromId)!;
  const to = BODY_BY_ID.get(p.toId)!;

  const depStep = (p.depEnd - p.depStart) / Math.max(1, p.depN - 1);
  const tofStep = (p.tofMax - p.tofMin) / Math.max(1, p.tofN - 1);

  const cells: PorkCell[][] = [];
  let best: PorkCell | null = null;
  let maxFinite = 0;

  for (let i = 0; i < p.depN; i++) {
    const depT = p.depStart + i * depStep;
    const depState = bodyState(from, depT);
    const col: PorkCell[] = [];
    for (let j = 0; j < p.tofN; j++) {
      const tof = p.tofMin + j * tofStep;
      const arrT = depT + tof;
      const arrState = bodyState(to, arrT);

      const sol = bestLeg(depState.r, arrState.r, tof, muSun, depState.v, arrState.v);
      let dvDepart = Infinity, dvArrive = Infinity, total = Infinity;
      if (sol) {
        const vInfDep = length(sub(sol.v1, depState.v));
        const vInfArr = length(sub(sol.v2, arrState.v));
        dvDepart = hyperbolicBurnDv(vInfDep, from.mu, p.rParkFrom);
        dvArrive = hyperbolicBurnDv(vInfArr, to.mu, p.rParkTo);
        total = dvDepart + dvArrive;
        if (isFinite(total)) {
          if (total > maxFinite) maxFinite = total;
          if (!best || total < best.total) {
            best = { depT, tof, arrT, dvDepart, dvArrive, total };
          }
        }
      }
      col.push({ depT, tof, arrT, dvDepart, dvArrive, total });
    }
    cells.push(col);
  }

  return {
    fromId: p.fromId, toId: p.toId,
    depStart: p.depStart, depStep, depN: p.depN,
    tofStart: p.tofMin, tofStep, tofN: p.tofN,
    cells, best, maxFinite,
  };
}
