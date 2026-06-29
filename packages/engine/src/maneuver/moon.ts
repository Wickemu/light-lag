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
import type { BodyDef } from "../constants.ts";
import type { Porkchop, PorkCell } from "./porkchop.ts";
import { hyperbolicBurnDv, ellipticalCaptureDv, soiRadius } from "../orbit.ts";
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
  captureApoAlt?: number, // capture into an ellipse reaching this apoapsis alt (else low circular)
): MoonWindow | null {
  const parent = BODY_BY_ID.get(parentId);
  const moon = BODY_BY_ID.get(moonId);
  if (!parent || !moon || moon.parent !== parentId) return null;
  const rMoon = length(bodyStateRelative(moon, t0).r);
  const moonPeriod = 2 * Math.PI * Math.sqrt((rMoon * rMoon * rMoon) / parent.mu);
  const parkPeriod = 2 * Math.PI * Math.sqrt((aPark * aPark * aPark) / parent.mu);
  const hTof = hohmann(parent.mu, aPark, rMoon).tof;
  const rParkTo = moon.radius + DEFAULT_CAPTURE_ALT;
  // Capture about the moon: a low circular burn, or — given an apoapsis — the Oberth-cheap loose
  // ellipse (the same circular-vs-ellipse split moonTour/planMoonTransfer use).
  const captureDv = (vInf: number): number => captureApoAlt !== undefined
    ? ellipticalCaptureDv(vInf, moon.mu, rParkTo, moon.radius + captureApoAlt)
    : hyperbolicBurnDv(vInf, moon.mu, rParkTo);

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
        const dvArrive = captureDv(length(sub(sol.v2, moonArr.v)));
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
    const dvArrive = captureDv(aim.vInf ?? 0);
    const total = dvDepart + dvArrive;
    if (total < bestTotal) { bestTotal = total; best = { tDepart: c.tDep, tArrive: c.tArr, dvDepart, dvArrive }; }
  }
  return best;
}

/**
 * Apoapsis ALTITUDE (m) of a sensible loose elliptical capture about `moon`: half its SOI above the
 * surface (floored at the default capture altitude). The pure-core twin of the planner's
 * `looseCaptureApoAlt`, so the in-sim auto-chain can size a moon's own loose ellipse without
 * reaching into the app layer. Scales naturally — a Ganymede ellipse is large, a Phobos one tiny.
 */
export function moonLooseApoAlt(parent: BodyDef, moon: BodyDef, t: number): number {
  const rMoon = length(bodyStateRelative(moon, t).r);
  const rSoi = soiRadius(rMoon, moon.mu, parent.mu);
  return Math.max(DEFAULT_CAPTURE_ALT, 0.5 * rSoi - moon.radius);
}

/**
 * A parent-centric porkchop for a single moon hop — the intra-system twin of the heliocentric
 * `computePorkchop`, returning the same `Porkchop` shape so the planner's canvas/crosshair render
 * it unchanged. The departure axis spans one moon period (the geometry that opens the window); the
 * TOF axis spans the Hohmann band.
 *
 * A parking orbit is fast (a LEO is ~90 min) next to the moon geometry (~27 days), so a cheap
 * in-plane injection exists only at a narrow, fast-recurring departure node (see `searchMoonWindow`'s
 * header). A grid sampled only on the slow moon phase would alias right over it. So each cell scans
 * the parking-orbit phase within its departure column and keeps the cheapest injection — collapsing
 * the fast oscillation into the cell so the plotted Δv is the achievable minimum at that
 * (departure-window, TOF), and storing the REFINED departure instant that achieved it so a committed
 * hop flies the real cheap node. Cells are scored with the cheap centre-aimed Lambert (no B-plane
 * bisection — like `searchMoonWindow` Stage 1); the exact J2-aware aim is done by `planMoonTransfer`
 * at commit, the same porkchop-estimate / real-plan split the heliocentric planner uses.
 */
export function computeMoonPorkchop(
  parentId: string, moonId: string, t0: number,
  shipState: (t: number) => { r: Vec3; v: Vec3 }, aPark: number, captureApoAlt?: number,
): Porkchop | null {
  const parent = BODY_BY_ID.get(parentId);
  const moon = BODY_BY_ID.get(moonId);
  if (!parent || !moon || moon.parent !== parentId) return null;
  const rMoon = length(bodyStateRelative(moon, t0).r);
  const moonPeriod = 2 * Math.PI * Math.sqrt((rMoon * rMoon * rMoon) / parent.mu);
  const parkPeriod = 2 * Math.PI * Math.sqrt((aPark * aPark * aPark) / parent.mu);
  const hTof = hohmann(parent.mu, aPark, rMoon).tof;
  const rParkTo = moon.radius + DEFAULT_CAPTURE_ALT;
  const captureDv = (vInf: number): number => captureApoAlt !== undefined
    ? ellipticalCaptureDv(vInf, moon.mu, rParkTo, moon.radius + captureApoAlt)
    : hyperbolicBurnDv(vInf, moon.mu, rParkTo);

  const depN = 32, tofN = 24, N_PARK = 8;
  const depStep = moonPeriod / depN;            // one moon period across the columns
  const tofMin = 0.7 * hTof, tofMax = 1.4 * hTof;
  const tofStep = (tofMax - tofMin) / Math.max(1, tofN - 1);

  const cells: PorkCell[][] = [];
  let best: PorkCell | null = null;
  let maxFinite = 0;

  for (let i = 0; i < depN; i++) {
    const depBase = t0 + i * depStep;
    const col: PorkCell[] = [];
    for (let j = 0; j < tofN; j++) {
      const tof = tofMin + j * tofStep;
      // Scan parking-orbit phase within this column; keep the cheapest achievable injection.
      let cell: PorkCell = { depT: depBase, tof, arrT: depBase + tof, dvDepart: Infinity, dvArrive: Infinity, total: Infinity };
      for (let k = 0; k < N_PARK; k++) {
        const tDep = depBase + (parkPeriod * k) / N_PARK;
        const tArr = tDep + tof;
        const dep = shipState(tDep);
        const moonArr = bodyStateRelative(moon, tArr);
        const sol = lambert(dep.r, moonArr.r, tof, parent.mu, true);
        if (!sol) continue;
        if (!outboundClearsParent(dep.r, sol.v1, parent.mu, parent.radius)) continue;
        const dvDepart = length(sub(sol.v1, dep.v));
        const dvArrive = captureDv(length(sub(sol.v2, moonArr.v)));
        const total = dvDepart + dvArrive;
        if (total < cell.total) cell = { depT: tDep, tof, arrT: tArr, dvDepart, dvArrive, total };
      }
      if (isFinite(cell.total)) {
        if (cell.total > maxFinite) maxFinite = cell.total;
        if (!best || cell.total < best.total) best = cell;
      }
      col.push(cell);
    }
    cells.push(col);
  }

  return {
    fromId: parentId, toId: moonId,
    depStart: t0, depStep, depN,
    tofStart: tofMin, tofStep, tofN,
    cells, best, maxFinite,
  };
}
