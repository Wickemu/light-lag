/**
 * Player intents → validated mutations of the world.
 *
 * In Phase 2 the player's ships are "local" (their own assets in Earth orbit),
 * so commands apply immediately. Phase 5 reroutes these through the light-lag
 * comms layer — a command to a distant ship will become a message that
 * propagates at c — but the call sites here stay the same.
 */

import { type Simulation } from "../core/sim.ts";
import { type Ship, type BurnDir } from "../core/world.ts";
import { type Stage, exhaustVelocity, thrustAt, brachistochrone } from "../core/propulsion.ts";
import { circularOrbit, hyperbolicBurnDv, periapsisRadius } from "../core/orbit.ts";
import { shipOsculatingElements, shipRelativeState, shipWorldState, activeStage, totalMass, dvRemaining, applyImpulsiveDv, NOMINAL_ENTRY_VEHICLE } from "../core/ships.ts";
import { entryInterfaceCrossing, entryTrajectory } from "../core/maneuver/entry.ts";
import { edelbaumTransfer } from "../core/maneuver/lowThrust.ts";
import { wrapPi } from "../core/math/kepler.ts";
import { torchTransit, type InterstellarTransit } from "../core/maneuver/interstellar.ts";
import { assistTransfer, type AssistResult } from "../core/maneuver/assist.ts";
import { STAR_BY_ID, starPosition } from "../core/stars.ts";
import {
  ascentBudget, descentBudget, surfaceManeuverCost, type AscentParams,
} from "../core/surface.ts";
import { bodyState } from "../core/ephemeris.ts";
import { lambert } from "../core/maneuver/lambert.ts";
import { length, sub, normalize, distance } from "../core/math/vec3.ts";
import { BODY_BY_ID, DEG, MU_SUN, C, JULIAN_YEAR, DEFAULT_CAPTURE_ALT } from "../core/constants.ts";

export interface ShipDesign {
  name: string;
  payloadMass: number; // kg
  altitudeKm: number; // circular insertion altitude
  inclinationDeg: number;
  stages: Stage[]; // firing order, index 0 first
}

/** A reasonable two-stage chemical ship: ~7.9 km/s of Δv, T/W ≈ 1.6. */
export function defaultDesign(): ShipDesign {
  return {
    name: "Courier",
    payloadMass: 3000,
    altitudeKm: 400,
    inclinationDeg: 28.5,
    stages: [
      { name: "Booster", dryMass: 5000, propMass: 50000, isp: 300, thrust: 1.2e6 },
      { name: "Upper", dryMass: 2000, propMass: 15000, isp: 340, thrust: 2.0e5 },
    ],
  };
}

/** Place a freshly built ship into a circular orbit about Earth. Returns its id. */
export function spawnShip(sim: Simulation, design: ShipDesign): string {
  const earth = BODY_BY_ID.get("earth")!;
  const radius = earth.radius + design.altitudeKm * 1000;
  const id = `ship-${sim.world.ships.size + 1}`;

  const ship: Ship = {
    id,
    name: design.name,
    primary: "earth",
    mode: "coast",
    elements: circularOrbit(radius, design.inclinationDeg * DEG, 0, 0),
    epoch: sim.world.t,
    payloadMass: design.payloadMass,
    // Deep-copy stages (and their boosters) so the live ship and the design
    // template don't alias — the sim mutates propMass and splices spent boosters.
    stages: design.stages.map((s) => ({ ...s, boosters: s.boosters?.map((b) => ({ ...b })) })),
    activeStage: 0,
    tau: 0,
  };
  sim.world.ships.set(id, ship);
  return id;
}

/**
 * Command a finite-thrust burn delivering `dvTarget` of ENGINE Δv in the given
 * orbit direction. The command is NOT applied now: it is transmitted from the
 * control node and propagates at c, so a distant ship only begins the burn after
 * the one-way light delay (and acknowledges a round-trip later). The Δv is
 * engine Δv (∫F/m dt, the rocket-equation currency); the realised speed change
 * is slightly less for a finite burn — that loss is physically honest.
 *
 * Returns the one-way light delay (s) until the order reaches the ship, or null.
 */
export function sendBurn(sim: Simulation, shipId: string, dvTarget: number, dir: BurnDir): number | null {
  if (dvTarget <= 0) return null;
  const res = sim.sendCommand(shipId, { type: "burn", dv: dvTarget, dir });
  return res ? res.delay : null;
}

export interface TransferPlan {
  dvDepart: number;
  dvArrive: number;
  tof: number;
}

/**
 * Plan and schedule an interplanetary transfer: solve the Lambert leg from the
 * ship's current primary (e.g. Earth) to `targetId` for the chosen departure and
 * arrival times, record it on the ship, and queue the departure. The injection
 * executes when the clock reaches tDepart (see Simulation.executeDeparture).
 */
export function planTransfer(
  sim: Simulation,
  shipId: string,
  targetId: string,
  tDepart: number,
  tArrive: number,
): TransferPlan | null {
  const ship = sim.world.ships.get(shipId);
  if (!ship || tArrive <= tDepart) return null;
  const depBody = BODY_BY_ID.get(ship.primary);
  const target = BODY_BY_ID.get(targetId);
  if (!depBody || !target) return null;

  const depState = bodyState(depBody, tDepart);
  const arrState = bodyState(target, tArrive);
  const sol = lambert(depState.r, arrState.r, tArrive - tDepart, MU_SUN, true);
  if (!sol) return null;

  // Oberth-aware injection from the ship's parking orbit, and capture into a
  // default low orbit at the target — so the planned cost equals what is paid.
  const el = shipOsculatingElements(ship, sim.world.t);
  const rParkFrom = periapsisRadius(el.a, el.e);
  const rParkTo = target.radius + DEFAULT_CAPTURE_ALT;
  const dvDepart = hyperbolicBurnDv(length(sub(sol.v1, depState.v)), depBody.mu, rParkFrom);
  const dvArrive = hyperbolicBurnDv(length(sub(sol.v2, arrState.v)), target.mu, rParkTo);
  ship.transfer = { targetId, tDepart, tArrive, dvDepart, dvArrive, departed: false, inSoi: false, arrived: false };
  sim.events.push({ t: tDepart, kind: "transfer-depart", entityId: shipId });
  return { dvDepart, dvArrive, tof: tArrive - tDepart };
}

/** Forget a planned transfer (a stale scheduled departure is ignored later). */
export function cancelTransfer(sim: Simulation, shipId: string): void {
  const ship = sim.world.ships.get(shipId);
  if (ship) ship.transfer = undefined;
}

/**
 * Plan and schedule a single-flyby gravity-assist mission: leg 1 to `flybyId`,
 * a slingshot past it, then leg 2 to `targetId`. Records the transfer (with its
 * flyby leg) and queues the departure; the sim flies depart → flyby-pass → capture
 * using the existing patched-conic machinery. Returns the assist estimate or null.
 */
export function planAssist(
  sim: Simulation,
  shipId: string,
  flybyId: string,
  targetId: string,
  tDepart: number,
  tFlyby: number,
  tArrive: number,
): AssistResult | null {
  const ship = sim.world.ships.get(shipId);
  if (!ship || tFlyby <= tDepart || tArrive <= tFlyby) return null;
  const depBody = BODY_BY_ID.get(ship.primary);
  if (!depBody) return null;
  const el = shipOsculatingElements(ship, sim.world.t);
  const rParkFrom = periapsisRadius(el.a, el.e);
  const res = assistTransfer(ship.primary, flybyId, targetId, tDepart, tFlyby, tArrive, { rParkFrom });
  if (!res) return null;
  ship.transfer = {
    targetId, tDepart, tArrive,
    dvDepart: res.dvDepart, dvArrive: res.dvArrive,
    departed: false, inSoi: false, arrived: false,
    flyby: { bodyId: flybyId, tFlyby, dvBurn: res.dvFlyby, done: false },
  };
  sim.events.push({ t: tDepart, kind: "transfer-depart", entityId: shipId });
  return res;
}

// ── Surface operations: landing & takeoff ────────────────────────────────────

/** The vehicle-specific ascent/descent parameters of a ship at a body: its real
 *  liftoff thrust-to-weight (against the body's surface gravity) and exhaust
 *  velocity, from the active stage. Exported so the ship panel can show the live
 *  budget with the same numbers the land/launch commands will charge. */
export function shipSurfaceParams(ship: Ship, body: { mu: number; radius: number }, parkingAlt: number): AscentParams {
  const stage = activeStage(ship);
  const ve = stage ? exhaustVelocity(stage.isp) : undefined;
  const gSurf = body.mu / (body.radius * body.radius);
  const twr = stage ? stage.thrust / (totalMass(ship) * gSurf) : 1;
  return { parkingAlt, twr, ...(ve !== undefined ? { exhaustVelocity: ve } : {}) };
}

/**
 * Dispatch a ship on a constant-proper-acceleration interstellar crossing to a
 * star: a flip-and-burn flown ANALYTICALLY in-sim (watch it cross over years,
 * with the comms light-lag stretching to years too). Returns the relativistic
 * transit estimate, or null. `exhaustVelocity` (default photon-class c) sizes the
 * mass-ratio estimate; the propellant is NOT drawn from the classical staged
 * economy — sustained-g torchships are the relativistic regime the catalog flags
 * (PENDING_RELATIVISTIC), so this commits the trajectory and reports what it would
 * physically require.
 */
export function dispatchInterstellar(
  sim: Simulation,
  shipId: string,
  starId: string,
  properAccel: number,
  exhaustVelocity: number = C,
): InterstellarTransit | null {
  const ship = sim.world.ships.get(shipId);
  const star = STAR_BY_ID.get(starId);
  if (!ship || !star || ship.mode !== "coast" || ship.landed || properAccel <= 0) return null;
  const transit = torchTransit({ exhaustVelocity, properAccel }, star);
  if (!transit) return null;

  const t = sim.world.t;
  const startPos = shipWorldState(ship, t).r;
  // Lead the target: aim at the star's position on arrival, then re-solve the
  // brachistochrone against that actual flight distance so (properAccel, D, T)
  // stay mutually consistent with the leg's read-time shaping. One refinement
  // pass; the residual (the star moves between the estimate and the refined
  // arrival) is second-order over a single voyage.
  const tArrive0 = t + transit.coordinateTimeYr * JULIAN_YEAR;
  const dActual = distance(starPosition(star, tArrive0), startPos);
  const tArrive = t + brachistochrone(properAccel, dActual).coordinateTime;
  ship.interstellarLeg = {
    targetStar: starId,
    tDepart: t,
    tArrive,
    properAccel,
    startPos,
  };
  ship.transfer = undefined;
  ship.primary = "sun";
  ship.mode = "coast";
  ship.r = undefined;
  ship.v = undefined;
  ship.elements = undefined;
  ship.epoch = t;
  return transit;
}

export interface SpiralPlan {
  dv: number; // Edelbaum Δv (m/s)
  time: number; // transfer time (s)
  propellant: number; // kg
}

/**
 * Commit an electric craft to a low-thrust spiral from its current near-circular
 * orbit to one at `targetAltKm`. The Edelbaum Δv/propellant are charged now; the
 * ship flies the analytic spiral (exact at any time-warp) and settles onto the
 * target orbit after the (long) transfer time. Returns the plan, or null if the
 * ship has no electric stage, isn't coasting about a body, or can't afford it.
 */
export function planSpiral(sim: Simulation, shipId: string, targetAltKm: number): SpiralPlan | null {
  const ship = sim.world.ships.get(shipId);
  if (!ship || ship.mode !== "coast" || ship.primary === "sun" || ship.landed || ship.interstellarLeg || ship.spiral) return null;
  const body = BODY_BY_ID.get(ship.primary);
  const stage = activeStage(ship);
  if (!body || !stage?.electric) return null;

  const t = sim.world.t;
  const el = shipOsculatingElements(ship, t);
  const r0 = el.a;
  const r1 = body.radius + targetAltKm * 1000;
  if (r1 <= 0 || Math.abs(r1 - r0) < 1) return null;

  const rHelio = length(shipWorldState(ship, t).r);
  const thrust = thrustAt(stage, rHelio);
  const ve = exhaustVelocity(stage.isp);
  const trans = edelbaumTransfer(body.mu, r0, r1, 0, thrust, ve, totalMass(ship), dvRemaining(ship));
  if (!trans.feasible || !isFinite(trans.time) || !applyImpulsiveDv(ship, trans.dv)) return null;

  ship.spiral = {
    startRadius: r0, endRadius: r1, i: el.i, Omega: el.Omega,
    phase0: wrapPi(el.omega + el.M), tStart: t, tEnd: t + trans.time,
  };
  ship.mode = "coast";
  ship.r = undefined;
  ship.v = undefined;
  ship.elements = undefined;
  ship.epoch = t;
  sim.events.push({ t: t + trans.time, kind: "spiral-arrive", entityId: shipId });
  return { dv: trans.dv, time: trans.time, propellant: trans.propellant };
}

export interface SurfaceOp {
  dv: number; // maneuver Δv (m/s)
  propellant: number; // propellant burned (kg)
  burnTime: number; // s
  feasible: boolean; // ship had the Δv to do it
}

/**
 * Land the ship on its current primary's surface, paying the descent Δv. The
 * touchdown itself is implicit — we account the Δv/propellant and mark the ship
 * landed (parked on a surface-skimming placeholder orbit). Returns the cost, or
 * null if the body has no surface or the ship isn't coasting in its SOI. When the
 * ship can't afford it, the op is returned with feasible:false and nothing is
 * spent.
 */
export function landShip(sim: Simulation, shipId: string): SurfaceOp | null {
  const ship = sim.world.ships.get(shipId);
  if (!ship || ship.landed || ship.mode !== "coast") return null;
  const body = BODY_BY_ID.get(ship.primary);
  if (!body || body.hasSurface === false) return null;

  const el = shipOsculatingElements(ship, sim.world.t);
  const alt = Math.max(0, periapsisRadius(el.a, el.e) - body.radius);
  const desc = descentBudget(body, shipSurfaceParams(ship, body, alt));
  if (!desc) return null;
  const cost = surfaceManeuverCost(ship.stages.slice(ship.activeStage), ship.payloadMass, desc.dvTotal);
  if (cost.feasible < 0 || !applyImpulsiveDv(ship, desc.dvTotal)) {
    return { dv: desc.dvTotal, propellant: cost.propellant, burnTime: cost.burnTime, feasible: false };
  }
  // Land directly below the current orbital position; store the site as a
  // body-fixed direction (de-rotate the inertial direction by the body's rotation
  // angle) so the ship co-rotates with the surface from here on.
  const t = sim.world.t;
  const dir = normalize(shipRelativeState(ship, t).r);
  const T = body.rotationPeriod ?? 0;
  const om = T !== 0 ? (2 * Math.PI) / T : 0;
  const c = Math.cos(-om * t), s = Math.sin(-om * t);
  const surfaceDir = { x: dir.x * c - dir.y * s, y: dir.x * s + dir.y * c, z: dir.z };
  ship.mode = "coast";
  ship.r = undefined;
  ship.v = undefined;
  ship.elements = undefined;
  ship.epoch = t;
  ship.landed = { bodyId: body.id, surfaceDir };
  return { dv: desc.dvTotal, propellant: cost.propellant, burnTime: cost.burnTime, feasible: true };
}

/** The predicted budget of an entry pass committed by flyEntry, for the UI. */
export interface EntryPlan {
  tStart: number; // s since J2000 — when the pass begins (the interface crossing)
  outcome: "landed" | "captured" | "skip-out";
  peakDecelG: number;
  peakHeatFlux: number;
  peakWallTemp: number;
  heatLoad: number;
}

/**
 * Fly the ship's current orbit into the atmosphere in-sim instead of teleporting it
 * down: schedule an entry pass at the next atmospheric-interface crossing. The ship
 * keeps coasting until then; at the interface it flies a ballistic (no-propellant)
 * drag trajectory you can watch at any time-warp, ending in landed / captured /
 * skip-out. Returns the predicted budget, or null if the ship isn't a coasting ship
 * in an atmosphere's SOI whose orbit actually dips into the atmosphere.
 */
export function flyEntry(sim: Simulation, shipId: string): EntryPlan | null {
  const ship = sim.world.ships.get(shipId);
  if (!ship || ship.landed || ship.mode !== "coast") return null;
  if (ship.entryLeg || ship.interstellarLeg || ship.spiral || ship.transfer) return null;
  const body = BODY_BY_ID.get(ship.primary);
  if (!body || body.hasSurface === false || !body.atmosphere || ship.primary === "sun") return null;

  const el = shipOsculatingElements(ship, sim.world.t);
  const x = entryInterfaceCrossing(body, el);
  if (!x) return null; // orbit never reaches the atmosphere
  const res = entryTrajectory(body, NOMINAL_ENTRY_VEHICLE, { entrySpeed: x.entrySpeed, flightPathAngle: x.flightPathAngle });
  if (!res) return null;

  const tStart = sim.world.t + x.dtToInterface;
  sim.events.push({ t: tStart, kind: "entry-start", entityId: shipId });
  return {
    tStart, outcome: res.outcome, peakDecelG: res.peakDecelG,
    peakHeatFlux: res.peakHeatFlux, peakWallTemp: res.peakWallTemp, heatLoad: res.heatLoad,
  };
}

/**
 * Launch a landed ship to a circular parking orbit at `altitudeKm`, paying the
 * ascent Δv. Returns the cost, or null if the ship isn't landed. feasible:false
 * (nothing spent) if it can't afford the climb.
 */
export function launchShip(sim: Simulation, shipId: string, altitudeKm: number): SurfaceOp | null {
  const ship = sim.world.ships.get(shipId);
  if (!ship || !ship.landed) return null;
  const body = BODY_BY_ID.get(ship.landed.bodyId);
  if (!body) return null;

  const alt = altitudeKm * 1000;
  const asc = ascentBudget(body, shipSurfaceParams(ship, body, alt));
  if (!asc) return null;
  const cost = surfaceManeuverCost(ship.stages.slice(ship.activeStage), ship.payloadMass, asc.dvTotal);
  if (cost.feasible < 0 || !applyImpulsiveDv(ship, asc.dvTotal)) {
    return { dv: asc.dvTotal, propellant: cost.propellant, burnTime: cost.burnTime, feasible: false };
  }
  // Insert into a circular orbit; the launch-site latitude is the minimum
  // inclination reachable from there.
  const incl = Math.asin(Math.max(-1, Math.min(1, ship.landed.surfaceDir.z)));
  ship.mode = "coast";
  ship.r = undefined;
  ship.v = undefined;
  ship.elements = circularOrbit(body.radius + alt, Math.abs(incl), 0, 0);
  ship.epoch = sim.world.t;
  ship.landed = undefined;
  return { dv: asc.dvTotal, propellant: cost.propellant, burnTime: cost.burnTime, feasible: true };
}
