import { describe, it, expect } from "vitest";
import { createWorld } from "../core/world.ts";
import { Simulation } from "../core/sim.ts";
import { spawnShip, defaultDesign, landShip, launchShip } from "./commands.ts";
import { dvRemaining } from "../core/ships.ts";
import { circularOrbit } from "../core/orbit.ts";
import { serializeWorld, deserializeWorld, hashWorld } from "../core/serialize.ts";
import { BODY_BY_ID } from "../core/constants.ts";

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
    expect(ship.landed?.bodyId).toBe("moon");
    // Δv fell by ~the descent cost (propellant was spent).
    expect(dvBefore - dvRemaining(ship)).toBeGreaterThan(1500);
  });

  it("a landed ship can launch back to orbit, paying the ascent Δv, clearing landed", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = moonShip(sim);
    landShip(sim, id);
    const ship = sim.world.ships.get(id)!;
    const dvBefore = dvRemaining(ship);

    const op = launchShip(sim, id, 100)!;
    expect(op.feasible).toBe(true);
    expect(ship.landed).toBeUndefined();
    expect(ship.mode).toBe("coast");
    // Now in a ~100 km lunar orbit.
    const alt = ship.elements!.a - MOON.radius;
    expect(alt / 1000).toBeGreaterThan(90);
    expect(alt / 1000).toBeLessThan(160);
    expect(dvBefore - dvRemaining(ship)).toBeGreaterThan(1500);
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

    const json = serializeWorld(sim.world);
    const restored = deserializeWorld(json);
    expect(restored.ships.get(id)!.landed).toEqual({ bodyId: "moon" });
    expect(hashWorld(restored)).toBe(hashWorld(sim.world));
  });
});
