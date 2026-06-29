import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import { spawnShip, planSpiral, type ShipDesign } from "./commands.ts";
import { shipOsculatingElements, dvRemaining } from "@lightlag/engine/ships";
import { serializeWorld, deserializeWorld, hashWorld } from "@lightlag/engine/serialize";
import { BODY_BY_ID, DAY } from "@lightlag/engine/constants";
import { type Stage } from "@lightlag/engine/propulsion";

const EARTH = BODY_BY_ID.get("earth")!;
const GEO_ALT = 35786; // km

// A solar-electric tug: AEPS-class Hall, plenty of Δv.
function electricDesign(): ShipDesign {
  const stage: Stage = {
    name: "Hall tug", dryMass: 4000, propMass: 2500, isp: 2600, thrust: 0.6,
    electric: { powerW: (0.6 * 2600 * 9.80665) / 1.2, eta: 0.6, solar: true },
  };
  return { name: "Tug", payloadMass: 1000, altitudeKm: 400, inclinationDeg: 0, stages: [stage] };
}

describe("in-sim low-thrust spiral", () => {
  it("spirals from LEO to GEO over a long time, arriving on the target circular orbit", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, electricDesign());
    const ship = sim.world.ships.get(id)!;
    const dv0 = dvRemaining(ship);

    const plan = planSpiral(sim, id, GEO_ALT)!;
    expect(plan).not.toBeNull();
    expect(plan.dv / 1000).toBeGreaterThan(4.3); // ~4.6 km/s Edelbaum spiral
    expect(plan.time / DAY).toBeGreaterThan(100); // a long, gentle transfer
    expect(ship.spiral).toBeTruthy();
    expect(dv0 - dvRemaining(ship)).toBeGreaterThan(4000); // Δv charged at commit

    const tEnd = ship.spiral!.tEnd;
    const r0 = EARTH.radius + 400e3;
    const rGeo = EARTH.radius + GEO_ALT * 1000;

    // Mid-spiral: the orbit radius is between the endpoints and growing.
    sim.step(tEnd / 2);
    const aMid = shipOsculatingElements(ship, sim.world.t).a;
    expect(aMid).toBeGreaterThan(r0);
    expect(aMid).toBeLessThan(rGeo);

    // Arrival: settled onto the (circular) GEO orbit, spiral cleared.
    sim.step(tEnd + 10 - sim.world.t);
    expect(ship.spiral).toBeUndefined();
    const elEnd = shipOsculatingElements(ship, sim.world.t);
    expect(elEnd.a / rGeo).toBeCloseTo(1, 2);
    expect(elEnd.e).toBeLessThan(0.01); // near-circular
  });

  it("the spiral leg survives a serialize round-trip with a stable hash", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, electricDesign());
    planSpiral(sim, id, GEO_ALT);
    sim.step(60 * DAY); // mid-spiral

    const restored = deserializeWorld(serializeWorld(sim.world));
    expect(restored.ships.get(id)!.spiral?.endRadius).toBeCloseTo(EARTH.radius + GEO_ALT * 1000, 0);
    expect(hashWorld(restored)).toBe(hashWorld(sim.world));
  });

  it("refuses to spiral a chemical (non-electric) ship", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, { name: "Chem", payloadMass: 1000, altitudeKm: 400, inclinationDeg: 0,
      stages: [{ name: "S", dryMass: 1000, propMass: 8000, isp: 320, thrust: 3e5 }] });
    expect(planSpiral(sim, id, GEO_ALT)).toBeNull();
  });
});
