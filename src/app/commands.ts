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
import { type Stage } from "../core/propulsion.ts";
import { circularOrbit, hyperbolicBurnDv, periapsisRadius } from "../core/orbit.ts";
import { shipRelativeState, shipOsculatingElements } from "../core/ships.ts";
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
 * Begin a finite-thrust burn delivering `dvTarget` of ENGINE Δv (∫F/m dt, the
 * rocket-equation currency that the Δv budget is measured in) in the given orbit
 * direction. Because the burn is finite rather than impulsive, the realised
 * change in orbital speed is slightly less, lost to gravity (and, for off-
 * prograde directions, cosine) — that loss is physically honest, not a bug.
 */
export function startBurn(sim: Simulation, shipId: string, dvTarget: number, dir: BurnDir): void {
  const ship = sim.world.ships.get(shipId);
  if (!ship || dvTarget <= 0) return;
  if (ship.mode === "thrust") return; // already burning

  // Freeze the current coast state as the integration's initial vector.
  const state = shipRelativeState(ship, sim.world.t);
  ship.r = state.r;
  ship.v = state.v;
  ship.mode = "thrust";
  ship.burn = { dir, dvTarget, dvDone: 0 };

  // Make the burn watchable: unpause and settle to a moderate warp.
  sim.paused = false;
  sim.setWarpIndex(Math.min(sim.warpIndex, 2)); // <= 60x
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
