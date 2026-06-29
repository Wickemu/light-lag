import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import { spawnShip, defaultDesign, landShip, launchShip } from "./commands.ts";
import { dvRemaining, shipRelativeState } from "@lightlag/engine/ships";
import { circularOrbit } from "@lightlag/engine/orbit";
import { serializeWorld, deserializeWorld, hashWorld } from "@lightlag/engine/serialize";
import { BODY_BY_ID } from "@lightlag/engine/constants";
import { length } from "@lightlag/engine/math/vec3";

const MOON = BODY_BY_ID.get("moon")!;

/** A courier parked in a low lunar orbit. */
function moonShip(sim: Simulation): string {
  const id = spawnShip(sim, defaultDesign());
  const ship = sim.world.ships.get(id)!;
  ship.primary = "moon";
  ship.elements = circularOrbit(MOON.radius + 100_000, 0, 0, 0);
  ship.epoch = sim.world.t;
  return id;
}

/** Step the sim well past any in-flight ascent/descent leg (capped at 2 h) so it
 *  finalizes — landShip/launchShip now FLY the powered arc in-sim before seating the
 *  ship on the surface / parking orbit, so the final state lands at the leg's tEnd. */
function settle(sim: Simulation): void {
  sim.step(10_000);
}

describe("landing and launch", () => {
  it("a lunar landing deducts the descent Δv and marks the ship landed", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = moonShip(sim);
    const ship = sim.world.ships.get(id)!;
    const dvBefore = dvRemaining(ship);

    const op = landShip(sim, id)!;
    expect(op.feasible).toBe(true);
    expect(op.dv / 1000).toBeGreaterThan(1.7); // ~lunar orbital speed + losses
    expect(op.dv / 1000).toBeLessThan(2.2);
    // Δv fell by ~the descent cost (propellant spent at commit, before the arc flies).
    expect(dvBefore - dvRemaining(ship)).toBeGreaterThan(1500);
    // The powered descent flies in-sim; after it finalizes the ship is landed.
    settle(sim);
    expect(ship.landed?.bodyId).toBe("moon");
  });

  it("a landed ship sits on the surface, moving at SURFACE speed, not orbital speed", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = moonShip(sim);
    landShip(sim, id);
    settle(sim); // fly the descent arc down to touchdown
    const ship = sim.world.ships.get(id)!;
    const t = sim.world.t;
    // Distance from the Moon's centre is its radius (on the surface).
    const rel = shipRelativeState(ship, t);
    expect(length(rel.r) / MOON.radius).toBeCloseTo(1, 3);
    // Surface speed = 2πR/T_rot ≈ 4.6 m/s — three orders below lunar orbital speed.
    const surfaceSpeed = (2 * Math.PI * MOON.radius) / Math.abs(MOON.rotationPeriod!);
    expect(length(rel.v)).toBeCloseTo(surfaceSpeed, 0);
    expect(length(rel.v)).toBeLessThan(50); // not the ~1.6 km/s of a surface-skimming orbit
  });

  it("a landed ship can launch back to orbit, paying the ascent Δv, clearing landed", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = moonShip(sim);
    landShip(sim, id);
    settle(sim); // land first
    const ship = sim.world.ships.get(id)!;
    expect(ship.landed?.bodyId).toBe("moon");
    const dvBefore = dvRemaining(ship);

    const op = launchShip(sim, id, 100)!;
    expect(op.feasible).toBe(true);
    // The ascent arc is now flying: the ship has left the surface but isn't yet coasting
    // the parking orbit. Δv is charged at commit.
    expect(ship.landed).toBeUndefined();
    expect(ship.mode).toBe("coast");
    expect(ship.launchLeg).toBeDefined();
    expect(dvBefore - dvRemaining(ship)).toBeGreaterThan(1500);

    // After the arc finalizes the ship is in a ~100 km circular lunar orbit.
    settle(sim);
    expect(ship.launchLeg).toBeUndefined();
    const alt = ship.elements!.a - MOON.radius;
    expect(alt / 1000).toBeGreaterThan(90);
    expect(alt / 1000).toBeLessThan(160);
    expect(ship.elements!.e).toBeLessThan(0.02); // ~circular insertion
  });

  it("refuses to land where there is no surface", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    ship.primary = "jupiter"; // gas giant — no surface
    ship.elements = circularOrbit(BODY_BY_ID.get("jupiter")!.radius + 1e6, 0, 0, 0);
    expect(landShip(sim, id)).toBeNull();
  });

  it("the landed flag survives a serialize round-trip and keeps the hash stable", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = moonShip(sim);
    landShip(sim, id);
    settle(sim); // fly the descent down to the landed state

    const json = serializeWorld(sim.world);
    const restored = deserializeWorld(json);
    expect(restored.ships.get(id)!.landed!.bodyId).toBe("moon");
    expect(restored.ships.get(id)!.landed!.surfaceDir).toBeDefined();
    expect(hashWorld(restored)).toBe(hashWorld(sim.world));
  });
});
