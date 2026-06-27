import { describe, it, expect } from "vitest";
import { createWorld } from "../core/world.ts";
import { Simulation } from "../core/sim.ts";
import { spawnShip, planTransfer, type ShipDesign } from "./commands.ts";
import { shipOsculatingElements, dvRemaining } from "../core/ships.ts";
import { marsWindow } from "../core/test-helpers.ts";
import { serializeWorld, deserializeWorld, hashWorld } from "../core/serialize.ts";
import { entryInterfaceAlt } from "../core/maneuver/entry.ts";
import { BODY_BY_ID, DAY } from "../core/constants.ts";

const MARS = BODY_BY_ID.get("mars")!;

// A modest chemical ship — enough to inject toward Mars but NOT enough to also pay a
// ~2.5 km/s propulsive capture comfortably, so aerocapture is the interesting option.
function design(): ShipDesign {
  return {
    name: "Aerobrake", payloadMass: 1000, altitudeKm: 400, inclinationDeg: 28.5,
    stages: [{ name: "Core", dryMass: 1500, propMass: 30000, isp: 360, thrust: 4e5 }],
  };
}

describe("in-sim aerocapture on arrival", () => {
  const win = marsWindow();

  it("captures a Mars arrival on a drag pass, trimming periapsis up for a fraction of the burn", () => {
    // Propulsive baseline arrival cost for the same window.
    const simP = new Simulation(createWorld(1, 0));
    const planP = planTransfer(simP, spawnShip(simP, design()), "mars", win.depT, win.arrT, "propulsive")!;
    expect(planP.dvArrive).toBeGreaterThan(1500); // a real ~2.5 km/s capture burn

    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, design());
    const ship = sim.world.ships.get(id)!;
    const dv0 = dvRemaining(ship);

    const plan = planTransfer(sim, id, "mars", win.depT, win.arrT, "aerocapture")!;
    expect(plan).not.toBeNull();
    // The aim periapsis is INSIDE the atmosphere, and the charged arrival is just the trim.
    expect(ship.transfer!.aeroPeriAlt!).toBeLessThan(entryInterfaceAlt(MARS));
    expect(plan.dvArrive).toBeLessThan(0.2 * planP.dvArrive); // a fraction of the propulsive burn

    // Fly through arrival, the drag pass, and the apoapsis trim.
    sim.step(win.arrT + 60 * DAY - sim.world.t);
    expect(ship.transfer!.arrived).toBe(true);
    expect(ship.primary).toBe("mars");

    const el = shipOsculatingElements(ship, sim.world.t);
    expect(el.e).toBeLessThan(1); // bound (captured)
    const periAlt = el.a * (1 - el.e) - MARS.radius;
    expect(periAlt).toBeGreaterThan(entryInterfaceAlt(MARS)); // periapsis trimmed clear of the atmosphere

    // The whole arrival (injection + trim) spent far less than injection + a propulsive capture.
    const spent = dv0 - dvRemaining(ship);
    expect(ship.transfer!.dvArrive).toBeLessThan(300); // tens–low-hundreds of m/s of trim
    expect(spent).toBeLessThan(planP.dvDepart + planP.dvArrive - 1000); // saved the better part of the capture burn
  });

  it("is deterministic across time-chunkings and round-trips through serialization", () => {
    const runToHash = (chunks: number[]): string => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, design());
      planTransfer(sim, id, "mars", win.depT, win.arrT, "aerocapture");
      const tEnd = win.arrT + 90 * DAY;
      let i = 0;
      while (sim.world.t < tEnd) sim.step(Math.min(chunks[i++ % chunks.length]!, tEnd - sim.world.t));
      return hashWorld(sim.world);
    };
    expect(runToHash([1e12])).toBe(runToHash([7, 1e6, 0.5, 3600, 5e6]));

    // Round-trip the transfer (with aeroPeriAlt) mid-flight before arrival.
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, design());
    planTransfer(sim, id, "mars", win.depT, win.arrT, "aerocapture");
    sim.step(win.depT + 100 * DAY - sim.world.t);
    expect(sim.world.ships.get(id)!.transfer!.aeroPeriAlt).toBeDefined();
    const ser = serializeWorld(sim.world);
    expect(serializeWorld(deserializeWorld(ser))).toBe(ser);
    expect(hashWorld(deserializeWorld(ser))).toBe(hashWorld(sim.world));
  });

  it("refuses aerocapture at an airless target", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, design());
    // Mercury has no atmosphere — aerocapture is impossible, propulsive still works.
    expect(planTransfer(sim, id, "mercury", win.depT, win.arrT, "aerocapture")).toBeNull();
    expect(planTransfer(sim, id, "mercury", win.depT, win.arrT, "propulsive")).not.toBeNull();
  });
});
