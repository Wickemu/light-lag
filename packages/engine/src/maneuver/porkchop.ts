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
import { type State } from "../math/kepler.ts";
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

/** Where a transfer's destination is, and what arriving there costs. Decouples the porkchop
 *  sweep from "the target is a body": a body uses `bodyState` + an Oberth capture burn; a
 *  Lagrange point uses its co-moving ephemeris + a velocity-match (`captureDv: vInf => vInf`). */
export interface TargetModel {
  /** Cruise-frame state of the destination at time t. */
  stateAt: (t: number) => State;
  /** Capture Δv (m/s) from the arrival excess speed v∞. */
  captureDv: (vInf: number) => number;
}

/** Grid bounds for a porkchop sweep (departure-date span × time-of-flight band). */
export interface PorkGrid {
  depStart: number; depEnd: number; depN: number;
  tofMin: number; tofMax: number; tofN: number;
}

/**
 * Core porkchop sweep against an arbitrary cruise frame, departure-state function, and
 * `TargetModel`. Each cell solves Lambert in `cruiseMu`, costs departure via `injectionDv(v∞)`
 * (an Oberth escape for an interplanetary leg, a direct burn for an in-SOI leg) and arrival via
 * `target.captureDv(v∞)`. `computePorkchop` is the heliocentric-body wrapper over this.
 */
export function computePorkchopTo(
  fromId: string,
  toId: string,
  cruiseMu: number,
  depStateAt: (t: number) => State,
  target: TargetModel,
  injectionDv: (vInf: number) => number,
  grid: PorkGrid,
): Porkchop {
  const depStep = (grid.depEnd - grid.depStart) / Math.max(1, grid.depN - 1);
  const tofStep = (grid.tofMax - grid.tofMin) / Math.max(1, grid.tofN - 1);

  const cells: PorkCell[][] = [];
  let best: PorkCell | null = null;
  let maxFinite = 0;

  for (let i = 0; i < grid.depN; i++) {
    const depT = grid.depStart + i * depStep;
    const depState = depStateAt(depT);
    const col: PorkCell[] = [];
    for (let j = 0; j < grid.tofN; j++) {
      const tof = grid.tofMin + j * tofStep;
      const arrT = depT + tof;
      const arrState = target.stateAt(arrT);

      const sol = bestLeg(depState.r, arrState.r, tof, cruiseMu, depState.v, arrState.v);
      let dvDepart = Infinity, dvArrive = Infinity, total = Infinity;
      if (sol) {
        const vInfDep = length(sub(sol.v1, depState.v));
        const vInfArr = length(sub(sol.v2, arrState.v));
        dvDepart = injectionDv(vInfDep);
        dvArrive = target.captureDv(vInfArr);
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
    fromId, toId,
    depStart: grid.depStart, depStep, depN: grid.depN,
    tofStart: grid.tofMin, tofStep, tofN: grid.tofN,
    cells, best, maxFinite,
  };
}

/** Compute a porkchop grid of heliocentric transfers from one body to another. A thin wrapper
 *  over `computePorkchopTo` (behaviour-preserving): heliocentric cruise, Oberth injection from
 *  the departure body's well, Oberth capture into the target's parking orbit. */
export function computePorkchop(p: PorkchopParams): Porkchop {
  const muSun = BODY_BY_ID.get("sun")!.mu;
  const from = BODY_BY_ID.get(p.fromId)!;
  const to = BODY_BY_ID.get(p.toId)!;
  return computePorkchopTo(
    p.fromId, p.toId, muSun,
    (t) => bodyState(from, t),
    { stateAt: (t) => bodyState(to, t), captureDv: (vInf) => hyperbolicBurnDv(vInf, to.mu, p.rParkTo) },
    (vInf) => hyperbolicBurnDv(vInf, from.mu, p.rParkFrom),
    { depStart: p.depStart, depEnd: p.depEnd, depN: p.depN, tofMin: p.tofMin, tofMax: p.tofMax, tofN: p.tofN },
  );
}
