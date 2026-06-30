import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import { spawnShip, type ShipDesign } from "./commands.ts";
import { serializeWorld, deserializeWorld, hashWorld } from "@lightlag/engine/serialize";
import { shipRelativeState, shipOsculatingElements, dvRemaining } from "@lightlag/engine/ships";
import { lagrangeState } from "@lightlag/engine/maneuver/lagrange";
import { stateToElements } from "@lightlag/engine/math/kepler";
import { length, sub } from "@lightlag/engine/math/vec3";
import { BODY_BY_ID, MU_SUN, DAY, JULIAN_YEAR, RAD } from "@lightlag/engine/constants";

function geoSat(propMass = 4000): ShipDesign {
  return {
    name: "Comsat", payloadMass: 800, altitudeKm: 35786, inclinationDeg: 5,
    stages: [{ name: "Bus", dryMass: 600, propMass, isp: 320, thrust: 4e3 }],
  };
}

describe("station-keeping — holding a high orbit against lunisolar drift", () => {
  it("a held GEO orbit keeps its inclination where an unheld perturbed orbit drifts, at a Δv cost", () => {
    const t0 = 80 * DAY;
    const span = 120 * DAY;
    const incl = (perturbedOnly: boolean) => {
      const sim = new Simulation(createWorld(1, t0));
      const id = spawnShip(sim, geoSat());
      const ship = sim.world.ships.get(id)!;
      const i0 = shipOsculatingElements(ship, sim.world.t).i;
      if (perturbedOnly) sim.flyPerturbed(id);
      else sim.holdStation(id, { kind: "orbit" });
      sim.step(span);
      return { dInc: Math.abs(shipOsculatingElements(ship, sim.world.t).i - i0) * RAD, sk: ship.stationKeep };
    };
    const drift = incl(true);
    const held = incl(false);
    const perYear = held.sk!.dvSpent * (JULIAN_YEAR / span);
    // eslint-disable-next-line no-console
    console.log(`GEO over ${span / DAY}d: unheld Δi=${drift.dInc.toFixed(3)}°, held Δi=${held.dInc.toFixed(3)}°, SK Δv=${held.sk!.dvSpent.toFixed(1)} m/s (≈${perYear.toFixed(0)}/yr), holding=${held.sk!.holding}`);

    expect(drift.dInc).toBeGreaterThan(0.02); // unheld lunisolar inclination drift is clearly nonzero
    expect(held.dInc).toBeLessThan(drift.dInc * 0.3); // the hold cancels most of it (re-seats on nominal)
    expect(held.sk!.holding).toBe(true);
    expect(held.sk!.dvSpent).toBeGreaterThan(0); // it cost propellant
    expect(perYear).toBeLessThan(2000); // a sane annual budget, not a runaway
  }, 30000);
});

describe("station-keeping — holding a Sun–Earth L2 station", () => {
  function atL2(perturbedOnly: boolean, propMass: number) {
    const earth = BODY_BY_ID.get("earth")!;
    const t0 = 50 * DAY;
    const l2 = lagrangeState(earth, "L2", t0);
    const sim = new Simulation(createWorld(1, t0));
    const id = spawnShip(sim, geoSat(propMass));
    const ship = sim.world.ships.get(id)!;
    ship.primary = "sun";
    ship.mode = "coast";
    ship.r = undefined;
    ship.v = undefined;
    ship.elements = stateToElements(l2.r, l2.v, MU_SUN);
    ship.epoch = t0;
    if (perturbedOnly) sim.flyPerturbed(id, { perturbers: [{ id: "earth", mu: earth.mu }] });
    else sim.holdStation(id, { kind: "lagrange", secondaryId: "earth", point: "L2", central: "sun" }, { windowS: 4 * DAY });
    return { sim, id, t0 };
  }

  it("a held craft stays near L2 (paying Δv) where an unheld one drifts off on the instability", () => {
    const earth = BODY_BY_ID.get("earth")!;
    const span = 40 * DAY;
    const drift = atL2(true, 4000);
    const held = atL2(false, 60000); // a big tank — L2 is unstable, holding it isn't cheap
    drift.sim.step(span);
    held.sim.step(span);
    const t = drift.t0 + span;
    const l2 = lagrangeState(earth, "L2", t);
    const driftErr = length(sub(shipRelativeState(drift.sim.world.ships.get(drift.id)!, t).r, l2.r));
    const heldShip = held.sim.world.ships.get(held.id)!;
    const heldErr = length(sub(shipRelativeState(heldShip, t).r, l2.r));
    // eslint-disable-next-line no-console
    console.log(`L2 over ${span / DAY}d: unheld off by ${(driftErr / 1e6).toFixed(0)} Mm, held off by ${(heldErr / 1e6).toFixed(1)} Mm, SK Δv=${heldShip.stationKeep!.dvSpent.toFixed(0)} m/s, holding=${heldShip.stationKeep!.holding}`);

    expect(driftErr).toBeGreaterThan(1e8); // the unheld craft wanders far off the point
    expect(heldErr).toBeLessThan(driftErr * 0.25); // the held craft stays much closer
    expect(heldShip.stationKeep!.dvSpent).toBeGreaterThan(0);
  });

  it("a craft that runs out of Δv stops holding and drifts off (the 'not for free' consequence)", () => {
    const held = atL2(false, 300); // a small tank — can't afford to hold an unstable point for long
    const ship = held.sim.world.ships.get(held.id)!;
    held.sim.step(120 * DAY);
    // eslint-disable-next-line no-console
    console.log(`L2 small-tank: holding=${ship.stationKeep!.holding}, spent=${ship.stationKeep!.dvSpent.toFixed(0)} m/s, Δv left=${dvRemaining(ship).toFixed(0)} m/s`);
    expect(ship.stationKeep!.holding).toBe(false); // the hold failed
    expect(ship.status).not.toBe("lost");
  });
});

describe("station-keeping — determinism & serialization", () => {
  it("a default ship serializes with no stationKeep field", () => {
    const sim = new Simulation(createWorld(1, 0));
    spawnShip(sim, geoSat());
    expect(serializeWorld(sim.world)).not.toContain("stationKeep");
  });

  it("is chunk-invariant: one step ≡ many chunks across correction windows", () => {
    const run = (chunks: number): string => {
      const sim = new Simulation(createWorld(1, 30 * DAY));
      const id = spawnShip(sim, geoSat());
      sim.holdStation(id, { kind: "orbit" });
      const tEnd = 40 * DAY;
      for (let i = 0; i < chunks; i++) sim.step(tEnd / chunks);
      return hashWorld(sim.world);
    };
    expect(run(1)).toBe(run(9));
  });

  it("round-trips mid-hold through serialize with a stable hash", () => {
    const sim = new Simulation(createWorld(1, 30 * DAY));
    const id = spawnShip(sim, geoSat());
    sim.holdStation(id, { kind: "orbit" });
    sim.step(10 * DAY);
    expect(sim.world.ships.get(id)!.stationKeep?.kind).toBe("orbit");
    const restored = deserializeWorld(serializeWorld(sim.world));
    expect(restored.ships.get(id)!.stationKeep?.kind).toBe("orbit");
    expect(hashWorld(restored)).toBe(hashWorld(sim.world));
  });
});
