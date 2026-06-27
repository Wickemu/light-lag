import { describe, it, expect } from "vitest";
import { createWorld } from "../core/world.ts";
import { Simulation } from "../core/sim.ts";
import { spawnShip, planMoonTour, searchMoonTour, type ShipDesign } from "./commands.ts";
import { shipOsculatingElements, shipRelativeState } from "../core/ships.ts";
import { serializeWorld, deserializeWorld, hashWorld } from "../core/serialize.ts";
import { bodyElements } from "../core/ephemeris.ts";
import { BODY_BY_ID, DAY } from "../core/constants.ts";

const EUROPA = BODY_BY_ID.get("europa")!;
const FLYBYS = ["callisto", "ganymede"];

// A torch-class orbiter: a Galilean pump-down costs a few km/s spread across departure + flybys +
// capture, so give it a generous budget (the test exercises the chaining/frames, not realism).
function bigDesign(): ShipDesign {
  return {
    name: "Galilean Orbiter", payloadMass: 500, altitudeKm: 400, inclinationDeg: 5,
    stages: [{ name: "Torch", dryMass: 1000, propMass: 60000, isp: 4000, thrust: 5e5 }],
  };
}

/** Hand-place the ship in a loose, eccentric Jupiter orbit (as moonMission.test.ts hand-sets
 *  the primary), roughly coplanar with the Galileans. */
function parkAtJupiter(sim: Simulation, id: string): void {
  const ship = sim.world.ships.get(id)!;
  const el0 = bodyElements(EUROPA, sim.world.t)!;
  ship.primary = "jupiter";
  ship.elements = { a: 5e9, e: 0.75, i: el0.i, Omega: el0.Omega, omega: el0.omega, M: 0 };
  ship.epoch = sim.world.t;
  ship.r = undefined;
  ship.v = undefined;
  ship.mode = "coast";
}

function findTour(sim: Simulation, id: string) {
  const ship = sim.world.ships.get(id)!;
  return searchMoonTour("jupiter", FLYBYS, "europa", {
    tDepart: sim.world.t, shipState: (t) => shipRelativeState(ship, t), steps: 5, phaseSteps: 32,
  });
}

describe("intra-system moon tour, flown in-sim (Jupiter Galilean pump-down to Europa)", () => {
  it("flies depart → Callisto → Ganymede flybys → Europa capture, all inside Jupiter's SOI", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    parkAtJupiter(sim, id);
    const ship = sim.world.ships.get(id)!;
    const tour = findTour(sim, id)!;
    expect(tour).toBeTruthy();

    expect(planMoonTour(sim, id, FLYBYS, "europa", tour.times)).toBeTruthy();
    expect(ship.transfer!.central).toBe("jupiter");
    expect(ship.transfer!.flybys!.map((f) => f.bodyId)).toEqual(FLYBYS);

    // Step to BETWEEN the two flybys: the ship must still be orbiting the PARENT (never the Sun)
    // and the first flyby must be done — the frame-leak guard for the parent-centric executor.
    const midFlybys = (tour.flybys[0]!.t + tour.flybys[1]!.t) / 2;
    sim.step(midFlybys - sim.world.t);
    expect(ship.primary).toBe("jupiter");
    expect(ship.transfer!.flybys![0]!.done).toBe(true);
    expect(ship.transfer!.flybys![1]!.done).toBe(false);

    // Finish the tour: it captures at Europa, having stayed in Jupiter's SOI throughout.
    sim.step(tour.tArrive + 30 * DAY - sim.world.t);
    expect(ship.primary).toBe("europa");
    expect(ship.transfer!.arrived).toBe(true);
    expect(ship.transfer!.flybys!.every((f) => f.done)).toBe(true);

    const el = shipOsculatingElements(ship, sim.world.t);
    expect(el.e).toBeLessThan(1); // captured (bound), not still hyperbolic
    const periAlt = el.a * (1 - el.e) - EUROPA.radius;
    expect(periAlt).toBeGreaterThan(0); // a real orbit ABOVE Europa's surface
    expect(el.a * (1 - el.e)).toBeLessThan(9.7e6); // a bound orbit inside Europa's SOI (~9.7·10³ km)
  });

  it("is chunk-invariant (one-step == chunked) and round-trips through serialize", () => {
    const run = (chunks: number): string => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, bigDesign());
      parkAtJupiter(sim, id);
      const tour = findTour(sim, id)!;
      planMoonTour(sim, id, FLYBYS, "europa", tour.times);
      const tEnd = tour.tArrive + 30 * DAY;
      for (let i = 0; i < chunks; i++) sim.step(tEnd / chunks);
      return hashWorld(sim.world);
    };
    expect(run(1)).toBe(run(9));

    // Mid-tour (after the first flyby) the active parent-centric tour transfer round-trips cleanly.
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    parkAtJupiter(sim, id);
    const tour = findTour(sim, id)!;
    planMoonTour(sim, id, FLYBYS, "europa", tour.times);
    sim.step(tour.flybys[0]!.t + DAY - sim.world.t);
    const restored = deserializeWorld(serializeWorld(sim.world));
    expect(restored.ships.get(id)!.transfer!.central).toBe("jupiter");
    expect(restored.ships.get(id)!.transfer!.flybys!.length).toBe(2);
    expect(hashWorld(restored)).toBe(hashWorld(sim.world));
  });

  it("rejects invalid tours without committing anything", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    parkAtJupiter(sim, id);
    const t0 = sim.world.t;
    expect(planMoonTour(sim, id, ["titan"], "europa", [t0, t0 + 1e6, t0 + 2e6])).toBeNull(); // wrong parent
    expect(planMoonTour(sim, id, ["ganymede", "europa"], "europa", [t0, t0 + 1e6, t0 + 2e6, t0 + 3e6])).toBeNull(); // final flyby == target
    expect(planMoonTour(sim, id, ["ganymede"], "europa", [t0, t0 + 2e6, t0 + 1e6])).toBeNull(); // out-of-order
    expect(planMoonTour(sim, id, ["ganymede"], "europa", [t0, t0 + 1e6])).toBeNull(); // wrong times length
    expect(planMoonTour(sim, id, ["ganymede"], "titan", [t0, t0 + 1e6, t0 + 2e6])).toBeNull(); // target not a Jovian moon
    expect(sim.world.ships.get(id)!.transfer).toBeUndefined(); // nothing committed
  });
});
