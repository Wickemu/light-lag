import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import { spawnShip, planAssist, type ShipDesign } from "./commands.ts";
import { searchAssist } from "@lightlag/engine/maneuver/assist";
import { shipWorldState } from "@lightlag/engine/ships";
import { serializeWorld, deserializeWorld, hashWorld } from "@lightlag/engine/serialize";
import { bodyState } from "@lightlag/engine/ephemeris";
import { BODY_BY_ID, MU_SUN, JULIAN_YEAR, DAY, AU } from "@lightlag/engine/constants";
import { length } from "@lightlag/engine/math/vec3";

// A high-Δv courier (~18 km/s) so it can afford an Earth→Jupiter injection plus
// the flyby residual and reach the outer system.
function bigDesign(): ShipDesign {
  return {
    name: "Voyager-class", payloadMass: 500, altitudeKm: 400, inclinationDeg: 28.5,
    stages: [{ name: "Core", dryMass: 1500, propMass: 80000, isp: 460, thrust: 5e5 }],
  };
}

const helioEnergy = (sim: Simulation, id: string): number => {
  const st = shipWorldState(sim.world.ships.get(id)!, sim.world.t);
  return (length(st.v) ** 2) / 2 - MU_SUN / length(st.r);
};

describe("in-sim gravity assist (Earth → Jupiter → Saturn)", () => {
  const tDepart = 30 * JULIAN_YEAR;
  const window = {
    tDepart,
    flybyWindow: [31.5 * JULIAN_YEAR, 34 * JULIAN_YEAR] as [number, number],
    arriveWindow: [36 * JULIAN_YEAR, 42 * JULIAN_YEAR] as [number, number],
    steps: 24,
  };

  it("departs, slings past Jupiter (energy jumps), and reaches Saturn's distance", () => {
    const best = searchAssist("earth", "jupiter", "saturn", window)!;
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    const plan = planAssist(sim, id, "jupiter", "saturn", best.tDepart, best.tFlyby, best.tArrive)!;
    expect(plan).not.toBeNull();
    const ship = sim.world.ships.get(id)!;

    // Depart.
    sim.step(tDepart + DAY);
    expect(ship.transfer!.departed).toBe(true);
    expect(ship.primary).toBe("sun");

    // Energy just before the flyby.
    sim.step(best.tFlyby - DAY - sim.world.t);
    const eBefore = helioEnergy(sim, id);

    // Through the flyby.
    sim.step(best.tFlyby + DAY - sim.world.t);
    expect(ship.transfer!.flybys![0]!.done).toBe(true);
    const eAfter = helioEnergy(sim, id);
    // The slingshot changed the heliocentric orbital energy (the free assist).
    expect(Math.abs(eAfter - eBefore)).toBeGreaterThan(1e6);

    // Arrive in Saturn's neighbourhood.
    sim.step(best.tArrive - sim.world.t);
    const dShip = length(shipWorldState(ship, sim.world.t).r) / AU;
    const dSaturn = length(bodyState(BODY_BY_ID.get("saturn")!, sim.world.t).r) / AU;
    expect(Math.abs(dShip - dSaturn)).toBeLessThan(1.5); // within ~1.5 AU of Saturn
  });

  it("the flyby leg survives a serialize round-trip with a stable hash", () => {
    const best = searchAssist("earth", "jupiter", "saturn", window)!;
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    planAssist(sim, id, "jupiter", "saturn", best.tDepart, best.tFlyby, best.tArrive);
    sim.step(tDepart + 100 * DAY); // departed, en route to the flyby

    const restored = deserializeWorld(serializeWorld(sim.world));
    const tr = restored.ships.get(id)!.transfer!;
    expect(tr.flybys![0]!.bodyId).toBe("jupiter");
    expect(tr.flybys![0]!.done).toBe(false);
    expect(hashWorld(restored)).toBe(hashWorld(sim.world));
  });
});
