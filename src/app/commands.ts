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
import { type Stage, exhaustVelocity } from "../core/propulsion.ts";
import { circularOrbit, hyperbolicBurnDv, periapsisRadius } from "../core/orbit.ts";
import { shipOsculatingElements, activeStage, totalMass, applyImpulsiveDv } from "../core/ships.ts";
import {
  ascentBudget, descentBudget, surfaceManeuverCost, type AscentParams,
} from "../core/surface.ts";
import { bodyState } from "../core/ephemeris.ts";
import { lambert } from "../core/maneuver/lambert.ts";
import { length, sub } from "../core/math/vec3.ts";
import { BODY_BY_ID, DEG, MU_SUN, DEFAULT_CAPTURE_ALT } from "../core/constants.ts";

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
    // Deep-copy stages so the live ship and the design template don't alias.
    stages: design.stages.map((s) => ({ ...s })),
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
  ship.mode = "coast";
  ship.r = undefined;
  ship.v = undefined;
  ship.elements = circularOrbit(body.radius, el.i, el.Omega, 0); // placeholder; ship is "on the surface"
  ship.epoch = sim.world.t;
  ship.landed = { bodyId: body.id };
  return { dv: desc.dvTotal, propellant: cost.propellant, burnTime: cost.burnTime, feasible: true };
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
  const prev = ship.elements;
  ship.mode = "coast";
  ship.r = undefined;
  ship.v = undefined;
  ship.elements = circularOrbit(body.radius + alt, prev?.i ?? 0, prev?.Omega ?? 0, 0);
  ship.epoch = sim.world.t;
  ship.landed = undefined;
  return { dv: asc.dvTotal, propellant: cost.propellant, burnTime: cost.burnTime, feasible: true };
}
