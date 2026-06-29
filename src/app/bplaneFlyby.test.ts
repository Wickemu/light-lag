import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import { spawnShip, planAssist, planMoonTour, searchMoonTour, type ShipDesign } from "./commands.ts";
import { searchAssist, minFlybyRadius } from "@lightlag/engine/maneuver/assist";
import { shipRelativeState } from "@lightlag/engine/ships";
import { serializeWorld, deserializeWorld, hashWorld } from "@lightlag/engine/serialize";
import { bodyElements } from "@lightlag/engine/ephemeris";
import { BODY_BY_ID, JULIAN_YEAR, DAY } from "@lightlag/engine/constants";

// A high-Δv courier (mirrors gravityAssist.test.ts) so it can afford an Earth→Jupiter
// injection plus the flyby residual and reach the outer system.
function bigDesign(): ShipDesign {
  return {
    name: "Voyager-class", payloadMass: 500, altitudeKm: 400, inclinationDeg: 28.5,
    stages: [{ name: "Core", dryMass: 1500, propMass: 80000, isp: 460, thrust: 5e5 }],
  };
}

const helioWindow = {
  tDepart: 30 * JULIAN_YEAR,
  flybyWindow: [31.5 * JULIAN_YEAR, 34 * JULIAN_YEAR] as [number, number],
  arriveWindow: [36 * JULIAN_YEAR, 42 * JULIAN_YEAR] as [number, number],
  steps: 24,
};

/** Assert a flown FlybyLeg carries a self-consistent recorded B-plane geometry. */
function expectSaneGeometry(leg: { rpAchieved?: number; bMag?: number; turn?: number; residualTurn?: number }, bodyId: string): void {
  const body = BODY_BY_ID.get(bodyId)!;
  expect(leg.rpAchieved).toBeDefined();
  expect(leg.bMag).toBeDefined();
  expect(leg.turn).toBeDefined();
  expect(leg.residualTurn).toBeDefined();
  // The flown periapsis is at or above the closest safe pass…
  expect(leg.rpAchieved!).toBeGreaterThanOrEqual(minFlybyRadius(body) - 1);
  // …its impact parameter exceeds the periapsis (b = rp·√((e+1)/(e−1)) > rp on a hyperbola)…
  expect(leg.bMag!).toBeGreaterThan(leg.rpAchieved!);
  // …and the required bend / residual are physical (0 ≤ residual ≤ required).
  expect(leg.turn!).toBeGreaterThanOrEqual(0);
  expect(leg.residualTurn!).toBeGreaterThanOrEqual(0);
  expect(leg.residualTurn!).toBeLessThanOrEqual(leg.turn! + 1e-9);
}

describe("B-plane-targeted in-sim flyby — recorded geometry (heliocentric)", () => {
  it("records the pass periapsis, impact parameter, turn and residual after a Jupiter flyby", () => {
    const best = searchAssist("earth", "jupiter", "saturn", helioWindow)!;
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    planAssist(sim, id, "jupiter", "saturn", best.tDepart, best.tFlyby, best.tArrive);
    const ship = sim.world.ships.get(id)!;

    // Fly through the flyby.
    sim.step(best.tFlyby + DAY - sim.world.t);
    const leg = ship.transfer!.flybys![0]!;
    expect(leg.done).toBe(true);
    expectSaneGeometry(leg, "jupiter");
  });

  it("does not move the charged residual — recording the geometry is hash-neutral mid-flight", () => {
    // The recorded fields are inspection-only; the flown trajectory and charged Δv are
    // unchanged, so two worlds reaching the same physical state hash identically.
    const run = (chunks: number): string => {
      const best = searchAssist("earth", "jupiter", "saturn", helioWindow)!;
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, bigDesign());
      planAssist(sim, id, "jupiter", "saturn", best.tDepart, best.tFlyby, best.tArrive);
      const tEnd = best.tArrive;
      for (let i = 0; i < chunks; i++) sim.step(tEnd / chunks);
      return hashWorld(sim.world);
    };
    expect(run(1)).toBe(run(7)); // chunk-invariant past the recorded flyby
  });

  it("round-trips the recorded geometry through serialize with a stable hash", () => {
    const best = searchAssist("earth", "jupiter", "saturn", helioWindow)!;
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    planAssist(sim, id, "jupiter", "saturn", best.tDepart, best.tFlyby, best.tArrive);
    sim.step(best.tFlyby + DAY - sim.world.t); // flyby flown — geometry now recorded

    const restored = deserializeWorld(serializeWorld(sim.world));
    const leg = restored.ships.get(id)!.transfer!.flybys![0]!;
    expect(leg.rpAchieved).toBeDefined();
    expect(leg.bMag).toBeDefined();
    expect(hashWorld(restored)).toBe(hashWorld(sim.world));
  });

  it("is golden-neutral: a planned-but-unflown chain serializes WITHOUT the geometry fields", () => {
    const best = searchAssist("earth", "jupiter", "saturn", helioWindow)!;
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    planAssist(sim, id, "jupiter", "saturn", best.tDepart, best.tFlyby, best.tArrive);
    // Before the flyby is flown, the optional fields are absent — the serialized JSON must
    // not carry them, so any world that never flies a flyby (e.g. the golden scenario) is
    // byte-identical to one from before this change.
    const json = serializeWorld(sim.world);
    expect(json).not.toContain("rpAchieved");
    expect(json).not.toContain("bMag");
    const leg = sim.world.ships.get(id)!.transfer!.flybys![0]!;
    expect(leg.rpAchieved).toBeUndefined();
  });
});

describe("B-plane-targeted in-sim flyby — recorded geometry (parent-frame moon tour)", () => {
  const FLYBYS = ["callisto", "ganymede"];
  const EUROPA = BODY_BY_ID.get("europa")!;

  function bigOrbiter(): ShipDesign {
    return {
      name: "Galilean Orbiter", payloadMass: 500, altitudeKm: 400, inclinationDeg: 5,
      stages: [{ name: "Torch", dryMass: 1000, propMass: 60000, isp: 4000, thrust: 5e5 }],
    };
  }
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

  it("records geometry for a parent-centric (moon) flyby — the executor's other frame branch", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigOrbiter());
    parkAtJupiter(sim, id);
    const ship = sim.world.ships.get(id)!;
    const tour = searchMoonTour("jupiter", FLYBYS, "europa", {
      tDepart: sim.world.t, shipState: (t) => shipRelativeState(ship, t), steps: 5, phaseSteps: 32,
    })!;
    expect(tour).toBeTruthy();
    planMoonTour(sim, id, FLYBYS, "europa", tour.times);

    // Step past the first (Callisto) flyby and read its recorded geometry.
    sim.step(tour.flybys[0]!.t + DAY - sim.world.t);
    const leg = ship.transfer!.flybys![0]!;
    expect(leg.done).toBe(true);
    expectSaneGeometry(leg, FLYBYS[0]!);
  });
});
