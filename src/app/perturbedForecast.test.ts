import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import { spawnShip, type ShipDesign } from "./commands.ts";
import { perturbedForecast } from "@lightlag/engine/trajectory";
import { hashWorld } from "@lightlag/engine/serialize";
import { DAY } from "@lightlag/engine/constants";

function geoSat(): ShipDesign {
  return {
    name: "Comsat", payloadMass: 1000, altitudeKm: 35786, inclinationDeg: 0,
    stages: [{ name: "Bus", dryMass: 800, propMass: 2000, isp: 320, thrust: 4e3 }],
  };
}

describe("perturbedForecast — read-time third-body preview", () => {
  it("forecasts a GEO comsat's perturbed path, dominated by the Moon and Sun, diverging from the two-body coast", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, geoSat());
    const ship = sim.world.ships.get(id)!;

    const fc = perturbedForecast(ship, sim.world.t, 30 * DAY);
    expect(fc).not.toBeNull();
    expect(fc!.path.points.length).toBeGreaterThan(2);
    expect(fc!.path.primary).toBe("earth");
    // The dominant perturbers at GEO are the Moon and the Sun.
    const top2 = fc!.perturbers.slice(0, 2).map((p) => p.id).sort();
    expect(top2).toEqual(["moon", "sun"]);
    // The two-body coast is materially wrong over a month at GEO (lunisolar drift).
    expect(fc!.divergenceAtHorizon).toBeGreaterThan(1e3);
  });

  it("is purely read-only — running it never moves the golden hash", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, geoSat());
    const before = hashWorld(sim.world);
    const ship = sim.world.ships.get(id)!;
    perturbedForecast(ship, sim.world.t, 30 * DAY);
    perturbedForecast(ship, sim.world.t, 5 * DAY, { includeJ2: false });
    expect(hashWorld(sim.world)).toBe(before);
  });

  it("returns null for a ship with no plain coasting conic (e.g. landed)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, geoSat());
    const ship = sim.world.ships.get(id)!;
    ship.landed = { bodyId: "earth", surfaceDir: { x: 1, y: 0, z: 0 } };
    expect(perturbedForecast(ship, sim.world.t, 30 * DAY)).toBeNull();
  });
});
