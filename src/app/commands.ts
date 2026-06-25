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
import { circularOrbit } from "../core/orbit.ts";
import { shipRelativeState } from "../core/ships.ts";
import { BODY_BY_ID, DEG } from "../core/constants.ts";

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
