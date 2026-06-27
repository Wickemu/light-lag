/**
 * Intra-system gravity-assist TOURS — a parent-centric moon-flyby chain.
 *
 * This is the parent-frame twin of the heliocentric assist stack (assist.ts): the
 * central body is a PLANET and the assist bodies are its MOONS. It is how real
 * deep-well orbiters reach a moon (Galileo / JUICE / Europa Clipper): capture into a
 * loose ellipse about the planet (see "elliptical capture"), then ratchet the
 * apoapsis down *for free* with repeated flybys of the planet's moons, settling into
 * a low moon orbit for a few hundred m/s of trim instead of a multi-km/s burn.
 *
 * Each leg is a Lambert arc about the PARENT (parent.mu, parent-relative moon
 * positions). At every interior moon the incoming/outgoing excess velocities define a
 * flyby that is FREE when a safe pass can bend it, else charged an Oberth bridge Δv —
 * the same per-flyby model as `flybyManeuver`. Two things differ from a heliocentric
 * assist: the ship is ALREADY in orbit about the parent, so the departure is a DIRECT
 * impulse from its current parking velocity (NOT an origin-body-well escape); and the
 * final leg aims with the J2-aware `aimMoonArrival` so the capture circularizes (or
 * settles into a loose ellipse) ABOVE the moon, inside its small SOI.
 *
 * Pure core: deterministic, bounded grid search. Reuses `flybyManeuver`/`minFlybyRadius`
 * (assist.ts), `maxTurnAngle` (flyby.ts), `aimMoonArrival` (arrival.ts) and the orbit.ts
 * capture helpers. Impulsive + analytic-coast + scheduled-event ⇒ chunk-invariant.
 */

import { type Vec3, length, sub } from "../math/vec3.ts";
import { lambert, type LambertSolution } from "./lambert.ts";
import { hohmann } from "./hohmann.ts";
import { flybyManeuver, minFlybyRadius } from "./assist.ts";
import { maxTurnAngle } from "./flyby.ts";
import { aimMoonArrival } from "./arrival.ts";
import { hyperbolicBurnDv, ellipticalCaptureDv } from "../orbit.ts";
import { bodyStateRelative } from "../ephemeris.ts";
import { type BodyDef, BODY_BY_ID, DEFAULT_CAPTURE_ALT } from "../constants.ts";

/** One moon flyby in a tour: the ship swings past `moonId`, bending its parent-relative
 *  velocity toward the next leg for free, and pays any powered residual. */
export interface MoonTourFlyby {
  moonId: string;
  t: number; // flyby time (s since J2000)
  rp: number; // chosen periapsis radius (m)
  dvFlyby: number; // powered Δv to bridge this flyby's |v∞|/turn mismatch (0 if free)
  vInfIn: number; // parent-relative excess speed arriving (m/s)
  vInfOut: number; // parent-relative excess speed leaving (m/s)
  turnRequired: number; // angle between in/out excess velocities (rad)
  turnMax: number; // largest bend a safe pass provides at vInfIn (rad)
  unpowered: boolean; // this flyby needs no burn
}

export interface MoonTourResult {
  tDepart: number;
  tArrive: number;
  dvDepart: number; // direct injection from the current parent orbit, |leg1.v1 − v0| (m/s)
  dvFlybyTotal: number; // summed powered-flyby Δv across all flybys (m/s)
  dvArrive: number; // capture about the target moon (m/s)
  dvTotal: number;
  vInfArrive: number; // parent-relative excess speed at the target moon SOI (m/s)
  flybys: MoonTourFlyby[]; // one per flyby moon, in order
  times: number[]; // [tDepart, tFlyby₁, …, tArrive]
  unpowered: boolean; // every flyby in the tour is free
}

/** Resolve and validate the parent + flyby/target moons; null if any body is unknown
 *  or doesn't orbit the parent. */
function resolveBodies(
  parentId: string, flybyMoonIds: string[], targetMoonId: string,
): { parent: BodyDef; flybyMoons: BodyDef[]; target: BodyDef } | null {
  const parent = BODY_BY_ID.get(parentId);
  const target = BODY_BY_ID.get(targetMoonId);
  if (!parent || !target || target.parent !== parentId) return null;
  if (flybyMoonIds.length < 1) return null;
  const flybyMoons: BodyDef[] = [];
  for (const id of flybyMoonIds) {
    const m = BODY_BY_ID.get(id);
    if (!m || m.parent !== parentId) return null;
    flybyMoons.push(m);
  }
  return { parent, flybyMoons, target };
}

/** The parent-frame Lambert arcs to each flyby moon's CENTRE (a patched-conic point,
 *  mirroring the heliocentric chain). `arcs[i]` arrives at flyby moon i; `moonV[i]` is
 *  that moon's parent-relative velocity at the flyby. null on any degenerate leg or
 *  out-of-order time. */
function tourArcs(
  parent: BodyDef, depR: Vec3, flybyMoons: BodyDef[], times: number[],
): { arcs: LambertSolution[]; moonR: Vec3[]; moonV: Vec3[] } | null {
  if (times.length !== flybyMoons.length + 2) return null;
  for (let i = 1; i < times.length; i++) if (times[i]! <= times[i - 1]!) return null;
  const arcs: LambertSolution[] = [];
  const moonR: Vec3[] = [];
  const moonV: Vec3[] = [];
  let prevPos = depR;
  let prevT = times[0]!;
  for (let i = 0; i < flybyMoons.length; i++) {
    const st = bodyStateRelative(flybyMoons[i]!, times[i + 1]!);
    const arc = lambert(prevPos, st.r, times[i + 1]! - prevT, parent.mu, true);
    if (!arc) return null;
    arcs.push(arc);
    moonR.push(st.r);
    moonV.push(st.v);
    prevPos = st.r;
    prevT = times[i + 1]!;
  }
  return { arcs, moonR, moonV };
}

/** The flyby ledger for the interior moons, given the arcs in and the outgoing velocity
 *  of each moon's departure leg. `outV[i]` is the velocity leaving flyby moon i. */
function flybyLedger(
  flybyMoons: BodyDef[], flybyMoonIds: string[], times: number[],
  arcs: LambertSolution[], moonV: Vec3[], outV: Vec3[],
): { flybys: MoonTourFlyby[]; dvFlybyTotal: number } | null {
  const flybys: MoonTourFlyby[] = [];
  let dvFlybyTotal = 0;
  for (let i = 0; i < flybyMoons.length; i++) {
    const moon = flybyMoons[i]!;
    const vMoon = moonV[i]!;
    const vInfInVec = sub(arcs[i]!.v2, vMoon);
    const vInfOutVec = sub(outV[i]!, vMoon);
    const vInfIn = length(vInfInVec);
    const vInfOut = length(vInfOutVec);
    if (vInfIn < 1e-3 || vInfOut < 1e-3) return null;
    const m = flybyManeuver(vInfInVec, vInfOutVec, moon);
    dvFlybyTotal += m.dvFlyby;
    flybys.push({
      moonId: flybyMoonIds[i]!, t: times[i + 1]!, rp: m.rp, dvFlyby: m.dvFlyby,
      vInfIn, vInfOut, turnRequired: m.turnRequired,
      turnMax: maxTurnAngle(vInfIn, moon.mu, minFlybyRadius(moon)),
      unpowered: m.dvFlyby < 1,
    });
  }
  return { flybys, dvFlybyTotal };
}

/**
 * Evaluate a parent-centric moon tour for a FIXED schedule: the ship departs its current
 * parent orbit (`dep` is its parent-relative state at `times[0]`), flies past each moon in
 * `flybyMoonIds` at `times[1..N]`, and captures at `targetMoonId` at `times[N+1]`. The final
 * leg is aimed with the J2-aware `aimMoonArrival` so the approach actually enters the moon's
 * SOI and the capture sits above the surface. Returns null on any degenerate leg / out-of-order
 * time / unknown body. Generalizes `assistTransfer`/`chainAssist` to the parent frame, but with
 * a direct (non-escape) departure and a moon capture.
 */
export function moonTour(
  parentId: string,
  dep: { r: Vec3; v: Vec3 },
  flybyMoonIds: string[],
  targetMoonId: string,
  times: number[],
  captureApoAlt?: number,
): MoonTourResult | null {
  const bodies = resolveBodies(parentId, flybyMoonIds, targetMoonId);
  if (!bodies) return null;
  const { parent, flybyMoons, target } = bodies;
  const built = tourArcs(parent, dep.r, flybyMoons, times);
  if (!built) return null;
  const { arcs, moonR, moonV } = built;
  const N = flybyMoons.length;
  const tArrive = times[times.length - 1]!;

  // Final leg: from the last flyby moon's position to the target moon, a J2-aware B-plane aim
  // (so the offset approach enters the moon's small SOI). Gives the outgoing velocity for the
  // last flyby and the arrival excess speed that sizes the capture.
  const rParkTo = target.radius + DEFAULT_CAPTURE_ALT;
  const aim = aimMoonArrival(parent, target, moonR[N - 1]!, times[N]!, tArrive, rParkTo);
  if (!aim) return null;

  // Each flyby's departure velocity: the next arc's v1, or — for the last flyby — the final aim.
  const outV: Vec3[] = [];
  for (let i = 0; i < N; i++) outV.push(i < N - 1 ? arcs[i + 1]!.v1 : aim.v1);
  const ledger = flybyLedger(flybyMoons, flybyMoonIds, times, arcs, moonV, outV);
  if (!ledger) return null;

  const dvDepart = length(sub(arcs[0]!.v1, dep.v)); // direct impulse from the current orbit
  const vInfArrive = aim.vInf ?? 0;
  const dvArrive = captureApoAlt !== undefined
    ? ellipticalCaptureDv(vInfArrive, target.mu, rParkTo, target.radius + captureApoAlt)
    : hyperbolicBurnDv(vInfArrive, target.mu, rParkTo);

  return {
    tDepart: times[0]!, tArrive,
    dvDepart, dvFlybyTotal: ledger.dvFlybyTotal, dvArrive,
    dvTotal: dvDepart + ledger.dvFlybyTotal + dvArrive,
    vInfArrive, flybys: ledger.flybys, times: [...times],
    unpowered: ledger.flybys.every((f) => f.unpowered),
  };
}

/**
 * A CHEAP total-Δv proxy for a fixed schedule, used only to rank schedules in the search:
 * it aims the final leg at the target moon's CENTRE (a plain Lambert) instead of the
 * expensive `aimMoonArrival` bisection. Returns null on a degenerate leg. The few best
 * proxies are then re-scored exactly with `moonTour`, so the returned tour is always flyable.
 */
function tourScore(
  parent: BodyDef, dep: { r: Vec3; v: Vec3 }, flybyMoons: BodyDef[], flybyMoonIds: string[],
  target: BodyDef, times: number[], captureApoAlt?: number,
): number | null {
  const built = tourArcs(parent, dep.r, flybyMoons, times);
  if (!built) return null;
  const { arcs, moonR, moonV } = built;
  const N = flybyMoons.length;
  const tArrive = times[times.length - 1]!;
  const tgt = bodyStateRelative(target, tArrive);
  const finalLeg = lambert(moonR[N - 1]!, tgt.r, tArrive - times[N]!, parent.mu, true);
  if (!finalLeg) return null;
  const outV: Vec3[] = [];
  for (let i = 0; i < N; i++) outV.push(i < N - 1 ? arcs[i + 1]!.v1 : finalLeg.v1);
  const ledger = flybyLedger(flybyMoons, flybyMoonIds, times, arcs, moonV, outV);
  if (!ledger) return null;
  const dvDepart = length(sub(arcs[0]!.v1, dep.v));
  const rParkTo = target.radius + DEFAULT_CAPTURE_ALT;
  const vInfArrive = length(sub(finalLeg.v2, tgt.v));
  const dvArrive = captureApoAlt !== undefined
    ? ellipticalCaptureDv(vInfArrive, target.mu, rParkTo, target.radius + captureApoAlt)
    : hyperbolicBurnDv(vInfArrive, target.mu, rParkTo);
  return dvDepart + ledger.dvFlybyTotal + dvArrive;
}

export interface MoonTourSearch {
  tDepart: number; // earliest departure epoch (s since J2000)
  shipState: (t: number) => { r: Vec3; v: Vec3 }; // parent-relative ship state at t (matches searchMoonWindow)
  steps?: number; // per-leg TOF multipliers sampled (default 5)
  phaseSteps?: number; // leg-1 departure-phase samples over the first moon's period (default 24)
  tofLo?: number; // smallest per-leg TOF as a fraction of its Hohmann TOF (default 0.6)
  tofHi?: number; // largest (default 1.6)
  captureApoAlt?: number; // capture into an ellipse reaching this apoapsis alt (else circular)
}

/** How many cheap-ranked schedules to re-score exactly with `moonTour`. */
const REFINE_K = 10;

/**
 * Grid-search the cheapest moon tour through `flybyMoonIds` (in order) to `targetMoonId` for a
 * ship currently in orbit about `parentId`. Departure phase is swept over the first flyby moon's
 * orbital period (≈ the synodic period of the slow capture ellipse against the fast moon — the
 * window where a near-free first encounter falls out), and each leg's time-of-flight over a band
 * around its Hohmann estimate. The ship's REAL conic is sampled via `shipState(t)`, so the search
 * sees the actual (loose, eccentric) capture orbit, exactly as `maybeChainMoonLeg` drives
 * `searchMoonWindow`. Bounded: `phaseSteps × steps^(N+1)` cheap evals, then `REFINE_K` exact ones.
 * Caller orders the moons (outer-first to pump apoapsis down). Returns the min-total-Δv flyable
 * tour, or null.
 */
export function searchMoonTour(
  parentId: string, flybyMoonIds: string[], targetMoonId: string, s: MoonTourSearch,
): MoonTourResult | null {
  const bodies = resolveBodies(parentId, flybyMoonIds, targetMoonId);
  if (!bodies) return null;
  const { parent, flybyMoons, target } = bodies;

  const t0 = s.tDepart;
  const r0 = length(s.shipState(t0).r);
  const radii = [
    r0,
    ...flybyMoons.map((m) => length(bodyStateRelative(m, t0).r)),
    length(bodyStateRelative(target, t0).r),
  ];
  const legs = radii.length - 1; // N + 1
  const nomTof: number[] = [];
  for (let i = 0; i < legs; i++) nomTof.push(hohmann(parent.mu, radii[i]!, radii[i + 1]!).tof);

  // Sweep the leg-1 departure over the SHIP's own orbital period (capped), not just the first
  // moon's: a loose capture ellipse is far slower than the moons, so its natural crossings of a
  // moon's orbit — where a near-free first encounter falls out — are spread across the whole ship
  // orbit. (Fall back to the first moon's period for an unbound/degenerate ship state.)
  const dep0 = s.shipState(t0);
  const r0len = length(dep0.r);
  const inv2a = 2 / r0len - (length(dep0.v) ** 2) / parent.mu;
  const aShip = inv2a > 0 ? 1 / inv2a : 0;
  const firstPeriod = 2 * Math.PI * Math.sqrt((radii[1]! ** 3) / parent.mu);
  const shipPeriod = aShip > 0 ? 2 * Math.PI * Math.sqrt((aShip ** 3) / parent.mu) : 0;
  const sweepWindow = shipPeriod > 0 ? Math.min(shipPeriod, 400 * 86_400) : firstPeriod;
  const phaseSteps = s.phaseSteps ?? 32;
  const n = s.steps ?? 5;
  const lo = s.tofLo ?? 0.6, hi = s.tofHi ?? 1.6;
  const mult = (k: number): number => (n === 1 ? 1 : lo + ((hi - lo) * k) / (n - 1));
  const combos = n ** legs;

  // Pass 1: cheap-score every (phase × TOF-combo) schedule; keep the best REFINE_K by score.
  const top: { score: number; times: number[] }[] = [];
  for (let p = 0; p < phaseSteps; p++) {
    const tDep = t0 + (sweepWindow * p) / phaseSteps;
    const dep = s.shipState(tDep);
    for (let combo = 0; combo < combos; combo++) {
      const times = [tDep];
      let c = combo;
      for (let i = 0; i < legs; i++) {
        const k = c % n;
        c = Math.floor(c / n);
        times.push(times[i]! + nomTof[i]! * mult(k));
      }
      const score = tourScore(parent, dep, flybyMoons, flybyMoonIds, target, times, s.captureApoAlt);
      if (score === null || !isFinite(score)) continue;
      // Keep the lowest-score schedules; strict total order with a deterministic tie-break on tDepart.
      if (top.length < REFINE_K) {
        top.push({ score, times });
        top.sort((a, b) => a.score - b.score || a.times[0]! - b.times[0]!);
      } else if (score < top[top.length - 1]!.score) {
        top[top.length - 1] = { score, times };
        top.sort((a, b) => a.score - b.score || a.times[0]! - b.times[0]!);
      }
    }
  }

  // Pass 2: re-score the finalists exactly (J2-aware final aim) and return the cheapest flyable one.
  let best: MoonTourResult | null = null;
  for (const cand of top) {
    const dep = s.shipState(cand.times[0]!);
    const res = moonTour(parentId, dep, flybyMoonIds, targetMoonId, cand.times, s.captureApoAlt);
    if (res && isFinite(res.dvTotal) && (!best || res.dvTotal < best.dvTotal)) best = res;
  }
  return best;
}
