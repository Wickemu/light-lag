import { describe, it, expect } from "vitest";
import { createWorld } from "../core/world.ts";
import { Simulation } from "../core/sim.ts";
import { spawnShip, defaultDesign, dispatchInterstellar } from "./commands.ts";
import { shipWorldState } from "../core/ships.ts";
import { serializeWorld, deserializeWorld, hashWorld } from "../core/serialize.ts";
import { STAR_BY_ID } from "../core/stars.ts";
import { C, G0, JULIAN_YEAR } from "../core/constants.ts";
import { distance, length } from "../core/math/vec3.ts";

const proxima = STAR_BY_ID.get("proxima")!;

describe("in-sim interstellar flight", () => {
  it("flies the analytic flip-and-burn and parks at the star at arrival", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    dispatchInterstellar(sim, id, "proxima", G0);
    const ship = sim.world.ships.get(id)!;
    expect(ship.interstellarLeg?.targetStar).toBe("proxima");

    const startDist = length(shipWorldState(ship, 0).r);

    // Halfway (coordinate time): near the midpoint, moving at the peak speed.
    const tArrive = ship.interstellarLeg!.tArrive;
    sim.step(tArrive / 2);
    const midPos = shipWorldState(ship, sim.world.t).r;
    expect(length(midPos)).toBeGreaterThan(startDist + 0.4 * length(proxima.pos)); // well on its way

    // Arrival: parked exactly at the star, at rest.
    sim.step(tArrive / 2 + 10);
    const arr = shipWorldState(ship, sim.world.t);
    expect(distance(arr.r, proxima.pos) / length(proxima.pos)).toBeLessThan(1e-6);
    expect(length(arr.v)).toBeLessThan(1); // decelerated to rest
  });

  it("ages the crew by the dilated proper time, not the coordinate time", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const transit = dispatchInterstellar(sim, id, "proxima", G0)!;
    const ship = sim.world.ships.get(id)!;
    const tArrive = ship.interstellarLeg!.tArrive;

    // Step across the whole crossing in several chunks (determinism check: τ is a
    // telescoping difference, so the chunking must not matter).
    for (let k = 0; k < 5; k++) sim.step(tArrive / 5);

    const crewYears = ship.tau / JULIAN_YEAR;
    const earthYears = sim.world.t / JULIAN_YEAR;
    expect(crewYears).toBeCloseTo(transit.properTimeYr, 1); // ~3.5 yr aboard
    expect(earthYears).toBeCloseTo(transit.coordinateTimeYr, 1); // ~5.9 yr outside
    expect(crewYears).toBeLessThan(earthYears); // time dilation
  });

  it("the transit estimate is the textbook 1g-to-Proxima crossing", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const t = dispatchInterstellar(sim, id, "proxima", G0, C)!;
    expect(t.properTimeYr).toBeGreaterThan(3.4);
    expect(t.properTimeYr).toBeLessThan(3.7);
    expect(t.coordinateTimeYr).toBeGreaterThan(5.8);
    expect(t.massRatio).toBeLessThan(100); // photon-class drive: feasible-ish
  });

  it("the interstellar leg survives a serialize round-trip with a stable hash", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    dispatchInterstellar(sim, id, "proxima", G0);
    sim.step(2 * JULIAN_YEAR); // partway across

    const restored = deserializeWorld(serializeWorld(sim.world));
    expect(restored.ships.get(id)!.interstellarLeg?.targetStar).toBe("proxima");
    expect(hashWorld(restored)).toBe(hashWorld(sim.world));
  });
});
