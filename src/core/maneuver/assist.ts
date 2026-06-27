/**
 * Gravity-assist trajectory planning (patched-conic, two legs).
 *
 * Leg 1 (origin → flyby body) sets the excess velocity arriving at the flyby; leg
 * 2 (flyby body → target) sets the excess velocity that must leave it. A free,
 * UNPOWERED assist works when the two excess SPEEDS match and the angle between
 * them is within the bend a safe pass can provide. When they don't quite match,
 * an Oberth burn at periapsis bridges the gap. The headline win: the flyby supplies
 * a heliocentric Δv the rocket never has to pay for.
 *
 * Reuses the Lambert solver, the flyby relations, hyperbolicBurnDv (Oberth
 * injection/capture), and combinedPlaneChangeDv. SI throughout.
 */

import { type BodyDef, BODY_BY_ID, MU_SUN, DEFAULT_CAPTURE_ALT } from "../constants.ts";
import { bodyState, bodyElements } from "../ephemeris.ts";
import { lambert } from "./lambert.ts";
import { hohmann } from "./hohmann.ts";
import { hyperbolicBurnDv, combinedPlaneChangeDv } from "../orbit.ts";
import { maxTurnAngle } from "./flyby.ts";
import { type Vec3, length, sub, dot } from "../math/vec3.ts";
import { better, type Criterion, type Scorable, type ScoreRefs } from "./criteria.ts";

/** Closest safe flyby radius: a 10% altitude margin above the surface. */
export function minFlybyRadius(body: BodyDef): number {
  return body.radius * 1.1;
}

const vpAt = (vInf: number, mu: number, rp: number): number => Math.sqrt(vInf * vInf + (2 * mu) / rp);

export interface FlybyManeuver {
  rp: number; // chosen periapsis radius (m)
  dvFlyby: number; // powered Δv at periapsis to bridge the |v∞|/turn mismatch (0 if free)
  turnRequired: number; // angle between in/out excess velocities (rad)
  residualTurn: number; // turn the geometry can't bend for free (rad)
}

/**
 * The periapsis and powered Δv of the flyby that turns excess velocity vInfIn into
 * vInfOut. Pick the periapsis that bends by exactly the required angle if a
 * shallow-enough pass can (e = 1/sin(δ/2) ⇒ rp = (e−1)μ/v∞²); otherwise fly the
 * closest safe pass and pay for the residual turn. The Δv is a single periapsis
 * burn that both changes the excess speed and supplies the residual turn — the
 * free bend costs nothing. Shared by the planner and the in-sim executor.
 */
export function flybyManeuver(vInfInVec: Vec3, vInfOutVec: Vec3, body: BodyDef): FlybyManeuver {
  const vInfIn = length(vInfInVec);
  const vInfOut = length(vInfOutVec);
  const cosT = Math.max(-1, Math.min(1, dot(vInfInVec, vInfOutVec) / (vInfIn * vInfOut)));
  const turnRequired = Math.acos(cosT);

  const rpMin = minFlybyRadius(body);
  const eNeeded = 1 / Math.sin(Math.max(turnRequired, 1e-6) / 2);
  const rpNeeded = ((eNeeded - 1) * body.mu) / (vInfIn * vInfIn);
  let rp: number, residualTurn: number;
  if (rpNeeded >= rpMin) {
    rp = rpNeeded;
    residualTurn = 0;
  } else {
    rp = rpMin;
    residualTurn = Math.max(0, turnRequired - maxTurnAngle(vInfIn, body.mu, rpMin));
  }
  const dvFlyby = combinedPlaneChangeDv(vpAt(vInfIn, body.mu, rp), vpAt(vInfOut, body.mu, rp), residualTurn);
  return { rp, dvFlyby, turnRequired, residualTurn };
}

export interface AssistResult {
  tDepart: number;
  tFlyby: number;
  tArrive: number;
  dvDepart: number; // Oberth injection from the origin parking orbit (m/s)
  dvFlyby: number; // powered-flyby Δv to bridge the |v∞| / turn mismatch (0 if free)
  dvArrive: number; // capture at the target (m/s)
  dvTotal: number;
  vInfIn: number; // excess speed arriving at the flyby body (m/s)
  vInfOut: number; // excess speed leaving it (m/s)
  turnRequired: number; // angle between in/out excess velocities (rad)
  turnMax: number; // largest bend a safe pass provides at vInfIn (rad)
  flybyRadius: number; // chosen periapsis radius (m)
  unpowered: boolean; // true if the assist needs no flyby burn
}

export interface AssistParams {
  rParkFrom?: number; // origin parking-orbit radius (m); default origin R + 400 km
  rParkTo?: number; // target capture-orbit radius (m); default target R + 400 km
}

/**
 * Evaluate a single-flyby gravity assist for fixed departure/flyby/arrival times.
 * Returns null on a degenerate Lambert leg.
 */
export function assistTransfer(
  originId: string, flybyId: string, targetId: string,
  tDepart: number, tFlyby: number, tArrive: number,
  p: AssistParams = {},
): AssistResult | null {
  const origin = BODY_BY_ID.get(originId);
  const flyby = BODY_BY_ID.get(flybyId);
  const target = BODY_BY_ID.get(targetId);
  if (!origin || !flyby || !target) return null;
  if (tFlyby <= tDepart || tArrive <= tFlyby) return null;

  const orig = bodyState(origin, tDepart);
  const fb = bodyState(flyby, tFlyby);
  const tgt = bodyState(target, tArrive);

  const leg1 = lambert(orig.r, fb.r, tFlyby - tDepart, MU_SUN, true);
  const leg2 = lambert(fb.r, tgt.r, tArrive - tFlyby, MU_SUN, true);
  if (!leg1 || !leg2) return null;

  const vInfInVec = sub(leg1.v2, fb.v); // excess velocity arriving at the flyby
  const vInfOutVec = sub(leg2.v1, fb.v); // excess velocity that must leave
  const vInfIn = length(vInfInVec);
  const vInfOut = length(vInfOutVec);
  if (vInfIn < 1e-3 || vInfOut < 1e-3) return null;

  const turnMax = maxTurnAngle(vInfIn, flyby.mu, minFlybyRadius(flyby));
  const m = flybyManeuver(vInfInVec, vInfOutVec, flyby);
  const { rp, dvFlyby, turnRequired } = m;
  const unpowered = dvFlyby < 1; // < 1 m/s ⇒ effectively free

  const rParkFrom = p.rParkFrom ?? origin.radius + DEFAULT_CAPTURE_ALT;
  const rParkTo = p.rParkTo ?? target.radius + DEFAULT_CAPTURE_ALT;
  const dvDepart = hyperbolicBurnDv(length(sub(leg1.v1, orig.v)), origin.mu, rParkFrom);
  const dvArrive = hyperbolicBurnDv(length(sub(leg2.v2, tgt.v)), target.mu, rParkTo);

  return {
    tDepart, tFlyby, tArrive,
    dvDepart, dvFlyby, dvArrive, dvTotal: dvDepart + dvFlyby + dvArrive,
    vInfIn, vInfOut, turnRequired, turnMax, flybyRadius: rp, unpowered,
  };
}

export interface ChainFlyby {
  bodyId: string;
  t: number; // flyby time (s since J2000)
  rp: number; // chosen periapsis radius (m)
  dvFlyby: number; // powered Δv to bridge this flyby's |v∞|/turn mismatch (0 if free)
  vInfIn: number; // excess speed arriving (m/s)
  vInfOut: number; // excess speed leaving (m/s)
  turnRequired: number; // angle between in/out excess velocities (rad)
  turnMax: number; // largest bend a safe pass provides at vInfIn (rad)
  unpowered: boolean; // this flyby needs no burn
}

export interface ChainAssistResult {
  tDepart: number;
  tArrive: number;
  dvDepart: number; // Oberth injection from the origin parking orbit (m/s)
  dvArrive: number; // capture at the target (m/s)
  dvFlybyTotal: number; // summed powered-flyby Δv across all flybys (m/s)
  dvTotal: number;
  flybys: ChainFlyby[]; // one per intermediate body, in order
  unpowered: boolean; // every flyby in the chain is free
}

/**
 * Evaluate a MULTI-flyby gravity-assist chain through an arbitrary sequence of
 * bodies — origin → flyby₁ → flyby₂ → … → target (e.g. a V-E-E-G-A tour) — for a
 * fixed schedule. `bodyIds` lists every body in order (length ≥ 3: at least one
 * intermediate flyby); `times` gives the epoch at each body (strictly increasing,
 * same length as `bodyIds`). Each heliocentric leg is a Lambert arc; at every
 * intermediate body the incoming/outgoing excess velocities define a flyby that is
 * free when a safe pass can bend it, else charged an Oberth bridge Δv (the same
 * per-flyby model as the single-assist solver). Returns null on any degenerate
 * leg or out-of-order time. Generalizes `assistTransfer` (the n = 1 flyby case).
 */
export function chainAssist(
  bodyIds: string[], times: number[], p: AssistParams = {},
): ChainAssistResult | null {
  if (bodyIds.length < 3 || bodyIds.length !== times.length) return null;
  for (let i = 1; i < times.length; i++) if (times[i]! <= times[i - 1]!) return null;

  const bodies = bodyIds.map((id) => BODY_BY_ID.get(id));
  if (bodies.some((b) => !b)) return null;
  const states = bodies.map((b, i) => bodyState(b!, times[i]!));

  // Heliocentric Lambert legs between consecutive bodies.
  const legs = [];
  for (let i = 0; i < bodies.length - 1; i++) {
    const leg = lambert(states[i]!.r, states[i + 1]!.r, times[i + 1]! - times[i]!, MU_SUN, true);
    if (!leg) return null;
    legs.push(leg);
  }

  // Each interior body bends the incoming leg's excess into the outgoing leg's.
  const flybys: ChainFlyby[] = [];
  let dvFlybyTotal = 0;
  for (let i = 1; i < bodies.length - 1; i++) {
    const body = bodies[i]!;
    const vBody = states[i]!.v;
    const vInfInVec = sub(legs[i - 1]!.v2, vBody);
    const vInfOutVec = sub(legs[i]!.v1, vBody);
    const vInfIn = length(vInfInVec);
    const vInfOut = length(vInfOutVec);
    if (vInfIn < 1e-3 || vInfOut < 1e-3) return null;
    const m = flybyManeuver(vInfInVec, vInfOutVec, body);
    dvFlybyTotal += m.dvFlyby;
    flybys.push({
      bodyId: bodyIds[i]!, t: times[i]!, rp: m.rp, dvFlyby: m.dvFlyby,
      vInfIn, vInfOut, turnRequired: m.turnRequired,
      turnMax: maxTurnAngle(vInfIn, body.mu, minFlybyRadius(body)),
      unpowered: m.dvFlyby < 1,
    });
  }

  const origin = bodies[0]!, target = bodies[bodies.length - 1]!;
  const firstLeg = legs[0]!, lastLeg = legs[legs.length - 1]!;
  const rParkFrom = p.rParkFrom ?? origin.radius + DEFAULT_CAPTURE_ALT;
  const rParkTo = p.rParkTo ?? target.radius + DEFAULT_CAPTURE_ALT;
  const dvDepart = hyperbolicBurnDv(length(sub(firstLeg.v1, states[0]!.v)), origin.mu, rParkFrom);
  const dvArrive = hyperbolicBurnDv(length(sub(lastLeg.v2, states[states.length - 1]!.v)), target.mu, rParkTo);

  return {
    tDepart: times[0]!, tArrive: times[times.length - 1]!,
    dvDepart, dvArrive, dvFlybyTotal,
    dvTotal: dvDepart + dvFlybyTotal + dvArrive,
    flybys, unpowered: flybys.every((f) => f.unpowered),
  };
}

export interface AssistSearch extends AssistParams {
  tDepart: number;
  flybyWindow: [number, number]; // [min, max] flyby time (s since J2000)
  arriveWindow: [number, number]; // [min, max] arrival time
  steps?: number; // grid resolution per axis (default 28)
  criterion?: Criterion; // ranking criterion (default "dv" — min total Δv)
  refs?: ScoreRefs; // reference scales for the "balanced" criterion
}

/**
 * Grid-search the best single-flyby assist for a fixed departure time. Bounded
 * (steps² Lambert pairs); returns the result that wins under `criterion` (default the
 * minimum-total-Δv), or null if none. The comparator is a strict total order, so the
 * winner is independent of grid traversal order.
 */
export function searchAssist(
  originId: string, flybyId: string, targetId: string, s: AssistSearch,
): AssistResult | null {
  const n = s.steps ?? 28;
  const crit = s.criterion ?? "dv";
  const refs = s.refs ?? { dvRef: 1, tofRef: 1 };
  const sc = (r: AssistResult): Scorable => ({ dvTotal: r.dvTotal, tof: r.tArrive - r.tDepart });
  let best: AssistResult | null = null;
  for (let i = 0; i < n; i++) {
    const tFlyby = s.flybyWindow[0] + ((s.flybyWindow[1] - s.flybyWindow[0]) * i) / (n - 1);
    for (let j = 0; j < n; j++) {
      const tArrive = s.arriveWindow[0] + ((s.arriveWindow[1] - s.arriveWindow[0]) * j) / (n - 1);
      const r = assistTransfer(originId, flybyId, targetId, s.tDepart, tFlyby, tArrive, s);
      if (r && isFinite(r.dvTotal) && (!best || better(sc(r), sc(best), crit, refs))) best = r;
    }
  }
  return best;
}

export interface ChainSearch extends AssistParams {
  tDepart: number; // fixed departure epoch (s since J2000)
  steps?: number; // TOF multipliers sampled per leg (default 7)
  tofLo?: number; // smallest per-leg TOF as a fraction of its Hohmann TOF (default 0.7)
  tofHi?: number; // largest (default 1.6)
  criterion?: Criterion; // ranking criterion (default "dv")
  refs?: ScoreRefs; // reference scales for the "balanced" criterion
}

/**
 * Grid-search the cheapest multi-flyby chain through `bodyIds` (≥ 3) for a fixed
 * departure, varying each heliocentric leg's time-of-flight around its Hohmann
 * estimate. Bounded (steps^legs `chainAssist` evaluations), so keep the chain short.
 * Returns the minimum-total-Δv schedule (the result + the chosen `times`), or null.
 */
export function searchChain(
  bodyIds: string[], s: ChainSearch,
): { result: ChainAssistResult; times: number[] } | null {
  if (bodyIds.length < 3) return null;
  const bodies = bodyIds.map((id) => BODY_BY_ID.get(id));
  if (bodies.some((b) => !b)) return null;
  const legs = bodyIds.length - 1;
  // Nominal Hohmann TOF for each consecutive leg, from semi-major axes at departure.
  const semi = bodies.map((b) => bodyElements(b!, s.tDepart)?.a ?? b!.radius);
  const nomTof: number[] = [];
  for (let i = 0; i < legs; i++) nomTof.push(hohmann(MU_SUN, semi[i]!, semi[i + 1]!).tof);

  const n = s.steps ?? 7;
  const lo = s.tofLo ?? 0.7, hi = s.tofHi ?? 1.6;
  const mult = (k: number): number => (n === 1 ? 1 : lo + ((hi - lo) * k) / (n - 1));
  const crit = s.criterion ?? "dv";
  const refs = s.refs ?? { dvRef: 1, tofRef: 1 };
  const sc = (r: ChainAssistResult): Scorable => ({ dvTotal: r.dvTotal, tof: r.tArrive - r.tDepart });

  let best: { result: ChainAssistResult; times: number[] } | null = null;
  const total = Math.pow(n, legs);
  for (let combo = 0; combo < total; combo++) {
    const times = [s.tDepart];
    let c = combo;
    for (let i = 0; i < legs; i++) {
      const k = c % n;
      c = Math.floor(c / n);
      times.push(times[i]! + nomTof[i]! * mult(k));
    }
    const res = chainAssist(bodyIds, times, s);
    if (res && isFinite(res.dvTotal) && (!best || better(sc(res), sc(best.result), crit, refs))) {
      best = { result: res, times };
    }
  }
  return best;
}
