import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import { spawnShip, planLagrange, computeLagrangePorkchop, defaultDesign } from "./commands.ts";
import { shipWorldState, shipRelativeState } from "@lightlag/engine/ships";
import { circularOrbit } from "@lightlag/engine/orbit";
import { lagrangeState, lagrangeStateRelative } from "@lightlag/engine/maneuver/lagrange";
import { serializeWorld, deserializeWorld, hashWorld } from "@lightlag/engine/serialize";
import { length, sub } from "@lightlag/engine/math/vec3";
import { BODY_BY_ID, DAY } from "@lightlag/engine/constants";

const EARTH = BODY_BY_ID.get("earth")!;
const MOON = BODY_BY_ID.get("moon")!;

function courierLeo(sim: Simulation): string {
  const id = spawnShip(sim, defaultDesign());
  const ship = sim.world.ships.get(id)!;
  ship.primary = "earth";
  ship.elements = circularOrbit(EARTH.radius + 400e3, 0.09, 0, 0);
  ship.epoch = sim.world.t;
  return id;
}

describe("Sun–Earth Lagrange transfer (heliocentric cruise)", () => {
  it("flies Earth LEO → Sun–Earth L2 and stations there with a small velocity match", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = courierLeo(sim);
    const ship = sim.world.ships.get(id)!;

    const grid = { depStart: 0, depEnd: 60 * DAY, depN: 24, tofMin: 60 * DAY, tofMax: 160 * DAY, tofN: 26 };
    const pork = computeLagrangePorkchop(sim, id, "earth", "L2", grid, EARTH.radius + 400e3)!;
    expect(pork.best).not.toBeNull();
    const best = pork.best!;

    const plan = planLagrange(sim, id, "earth", "L2", best.depT, best.arrT)!;
    expect(plan).not.toBeNull();
    // Injection is roughly an escape burn from LEO; the arrival match is small (the L-point co-moves).
    expect(plan.dvDepart / 1000).toBeGreaterThan(2.5);
    expect(plan.dvDepart / 1000).toBeLessThan(4.5);
    expect(plan.dvArrive / 1000).toBeLessThan(1.5);
    expect(ship.transfer!.arrival).toEqual({ kind: "lagrange", point: "L2" });
    expect(ship.transfer!.central).toBeUndefined(); // heliocentric cruise

    sim.step(best.arrT - sim.world.t);
    expect(ship.transfer!.arrived).toBe(true);
    expect(ship.primary).toBe("sun");
    // The ship is parked essentially at the L2 point.
    const d = length(sub(shipWorldState(ship, sim.world.t).r, lagrangeState(EARTH, "L2", sim.world.t).r));
    expect(d).toBeLessThan(1e7); // within ~10,000 km of the moving point
  });
});

describe("Earth–Moon Lagrange transfer (geocentric cruise)", () => {
  it("flies Earth LEO → Earth–Moon L4 and stations there, staying in Earth's frame", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = courierLeo(sim);
    const ship = sim.world.ships.get(id)!;

    const grid = { depStart: 0, depEnd: 27 * DAY, depN: 28, tofMin: 3 * DAY, tofMax: 8 * DAY, tofN: 20 };
    const pork = computeLagrangePorkchop(sim, id, "moon", "L4", grid, EARTH.radius + 400e3)!;
    expect(pork.best).not.toBeNull();
    const best = pork.best!;

    const plan = planLagrange(sim, id, "moon", "L4", best.depT, best.arrT)!;
    expect(plan).not.toBeNull();
    expect(ship.transfer!.central).toBe("earth"); // geocentric cruise, like a moon hop

    sim.step(best.arrT - sim.world.t);
    expect(ship.transfer!.arrived).toBe(true);
    expect(ship.primary).toBe("earth");
    const d = length(sub(shipRelativeState(ship, sim.world.t).r, lagrangeStateRelative(MOON, "L4", sim.world.t).r));
    expect(d).toBeLessThan(1e7); // parked at the Earth–Moon L4 point
  });
});

describe("eligibility & determinism", () => {
  it("refuses a body with no parent (the Sun has no Lagrange points)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = courierLeo(sim);
    expect(planLagrange(sim, id, "sun", "L1", 0, 100 * DAY)).toBeNull();
    expect(computeLagrangePorkchop(sim, id, "sun", "L1",
      { depStart: 0, depEnd: 10 * DAY, depN: 4, tofMin: 10 * DAY, tofMax: 50 * DAY, tofN: 4 }, EARTH.radius + 400e3)).toBeNull();
  });

  it("a committed L2 transfer round-trips through serialization with a stable hash", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = courierLeo(sim);
    const grid = { depStart: 0, depEnd: 60 * DAY, depN: 16, tofMin: 60 * DAY, tofMax: 160 * DAY, tofN: 16 };
    const best = computeLagrangePorkchop(sim, id, "earth", "L2", grid, EARTH.radius + 400e3)!.best!;
    planLagrange(sim, id, "earth", "L2", best.depT, best.arrT);
    sim.step(best.depT + 20 * DAY - sim.world.t); // mid-cruise
    const ser = serializeWorld(sim.world);
    expect(serializeWorld(deserializeWorld(ser))).toBe(ser);
    expect(hashWorld(deserializeWorld(ser))).toBe(hashWorld(sim.world));
    // The arrival descriptor must survive the round-trip (it drives the velocity-match arrival).
    expect(deserializeWorld(ser).ships.get(id)!.transfer!.arrival).toEqual({ kind: "lagrange", point: "L2" });
  });
});
