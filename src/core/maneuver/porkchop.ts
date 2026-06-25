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
import { lambert } from "./lambert.ts";

export interface PorkCell {
  depT: number; // departure time (s since J2000)
  tof: number; // time of flight (s)
  arrT: number;
  dvDepart: number; // |v_transfer(r1) − v_from| (m/s); Infinity if no solution
  dvArrive: number; // |v_transfer(r2) − v_to| (m/s)
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

      const sol = lambert(depState.r, arrState.r, tof, muSun, true);
      let dvDepart = Infinity, dvArrive = Infinity, total = Infinity;
      if (sol) {
        dvDepart = length(sub(sol.v1, depState.v));
        dvArrive = length(sub(sol.v2, arrState.v));
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
