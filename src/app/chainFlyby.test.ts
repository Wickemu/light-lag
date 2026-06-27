import { describe, it, expect } from "vitest";
import { createWorld } from "../core/world.ts";
import { Simulation } from "../core/sim.ts";
import { spawnShip, planChainAssist, type ShipDesign } from "./commands.ts";
import { searchChain } from "../core/maneuver/assist.ts";
import { shipWorldState } from "../core/ships.ts";
import { serializeWorld, deserializeWorld, hashWorld } from "../core/serialize.ts";
import { bodyState } from "../core/ephemeris.ts";
import { BODY_BY_ID, MU_SUN, JULIAN_YEAR, DAY, AU } from "../core/constants.ts";
import { length } from "../core/math/vec3.ts";

// A high-Δv tour ship (~18.8 km/s) so it can afford the injection plus two flyby
// residuals on an Earth→Mars→Jupiter→Saturn chain.
function tourDesign(): ShipDesign {
  return {
    name: "Grand Tour", payloadMass: 400, altitudeKm: 400, inclinationDeg: 28.5,
    stages: [{ name: "Core", dryMass: 1500, propMass: 120000, isp: 460, thrust: 5e5 }],
  };
}

const CHAIN = ["earth", "mars", "jupiter", "saturn"];
const heliocentricEnergy = (sim: Simulation, id: string): number => {
  const st = shipWorldState(sim.world.ships.get(id)!, sim.world.t);
  return (length(st.v) ** 2) / 2 - MU_SUN / length(st.r);
};

describe("in-sim chained multi-flyby (Earth → Mars → Jupiter → Saturn)", () => {
  // Deterministic chain schedule (fixed departure, fixed grid).
  const chain = searchChain(CHAIN, { tDepart: 25 * JULIAN_YEAR, steps: 7 })!;

  it("flies BOTH flybys in order, the energy jumps at each, and it reaches Saturn", () => {
    expect(chain).not.toBeNull();
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, tourDesign());
    const ship = sim.world.ships.get(id)!;
    const plan = planChainAssist(sim, id, CHAIN, chain.times)!;
    expect(plan).not.toBeNull();
    expect(ship.transfer!.flybys!.map((f) => f.bodyId)).toEqual(["mars", "jupiter"]);

    // Through the first flyby (Mars): energy jumps, only flyby 0 is done.
    const e0 = heliocentricEnergy(sim, id);
    sim.step(chain.times[1]! + DAY - sim.world.t);
    expect(ship.transfer!.flybys![0]!.done).toBe(true);
    expect(ship.transfer!.flybys![1]!.done).toBe(false);
    const e1 = heliocentricEnergy(sim, id);
    expect(Math.abs(e1 - e0)).toBeGreaterThan(1e6); // the slingshot changed the orbit energy

    // Through the second flyby (Jupiter): both done, another energy jump.
    sim.step(chain.times[2]! + DAY - sim.world.t);
    expect(ship.transfer!.flybys![1]!.done).toBe(true);
    const e2 = heliocentricEnergy(sim, id);
    expect(Math.abs(e2 - e1)).toBeGreaterThan(1e6);

    // Arrive in Saturn's neighbourhood.
    sim.step(chain.times[3]! - sim.world.t);
    const dShip = length(shipWorldState(ship, sim.world.t).r) / AU;
    const dSaturn = length(bodyState(BODY_BY_ID.get("saturn")!, sim.world.t).r) / AU;
    expect(Math.abs(dShip - dSaturn)).toBeLessThan(1.5); // within ~1.5 AU of Saturn
  });

  it("is deterministic across time-chunkings and round-trips through serialization", () => {
    const runToHash = (chunks: number[]): string => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, tourDesign());
      planChainAssist(sim, id, CHAIN, chain.times);
      const tEnd = chain.times[3]!;
      let i = 0;
      while (sim.world.t < tEnd) sim.step(Math.min(chunks[i++ % chunks.length]!, tEnd - sim.world.t));
      return hashWorld(sim.world);
    };
    // Impulsive flybys at scheduled events ⇒ chunk-invariant.
    expect(runToHash([1e12])).toBe(runToHash([7, 5e6, 0.5, 3600, 9e7]));

    // Mid-chain (after the first flyby) the flybys array round-trips with a stable hash.
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, tourDesign());
    planChainAssist(sim, id, CHAIN, chain.times);
    sim.step(chain.times[1]! + 50 * DAY - sim.world.t);
    const tr = sim.world.ships.get(id)!.transfer!;
    expect(tr.flybys!.length).toBe(2);
    expect(tr.flybys![0]!.done).toBe(true);
    const ser = serializeWorld(sim.world);
    expect(serializeWorld(deserializeWorld(ser))).toBe(ser);
    expect(hashWorld(deserializeWorld(ser))).toBe(hashWorld(sim.world));
  });

  it("rejects a degenerate chain (fewer than 3 bodies, or mismatched times)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, tourDesign());
    expect(planChainAssist(sim, id, ["earth", "mars"], [0, 1e7])).toBeNull(); // no interior flyby
    expect(planChainAssist(sim, id, CHAIN, [0, 1e7, 2e7])).toBeNull(); // times length mismatch
  });
});
