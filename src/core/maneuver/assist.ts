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
import { bodyState } from "../ephemeris.ts";
import { lambert } from "./lambert.ts";
import { hyperbolicBurnDv, combinedPlaneChangeDv } from "../orbit.ts";
import { maxTurnAngle } from "./flyby.ts";
import { type Vec3, length, sub, dot } from "../math/vec3.ts";

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

export interface AssistSearch extends AssistParams {
  tDepart: number;
  flybyWindow: [number, number]; // [min, max] flyby time (s since J2000)
  arriveWindow: [number, number]; // [min, max] arrival time
  steps?: number; // grid resolution per axis (default 28)
}

/**
 * Grid-search the cheapest single-flyby assist for a fixed departure time. Bounded
 * (steps² Lambert pairs); returns the minimum-total-Δv result, or null if none.
 */
export function searchAssist(
  originId: string, flybyId: string, targetId: string, s: AssistSearch,
): AssistResult | null {
  const n = s.steps ?? 28;
  let best: AssistResult | null = null;
  for (let i = 0; i < n; i++) {
    const tFlyby = s.flybyWindow[0] + ((s.flybyWindow[1] - s.flybyWindow[0]) * i) / (n - 1);
    for (let j = 0; j < n; j++) {
      const tArrive = s.arriveWindow[0] + ((s.arriveWindow[1] - s.arriveWindow[0]) * j) / (n - 1);
      const r = assistTransfer(originId, flybyId, targetId, s.tDepart, tFlyby, tArrive, s);
      if (r && isFinite(r.dvTotal) && (!best || r.dvTotal < best.dvTotal)) best = r;
    }
  }
  return best;
}
