import { describe, it, expect } from "vitest";
import { createWorld } from "../core/world.ts";
import { Simulation } from "../core/sim.ts";
import { spawnShip, planTransfer, looseCaptureApoAlt, type ShipDesign } from "./commands.ts";
import { shipOsculatingElements, dvRemaining } from "../core/ships.ts";
import { computePorkchop } from "../core/maneuver/porkchop.ts";
import { serializeWorld, deserializeWorld, hashWorld } from "../core/serialize.ts";
import { BODY_BY_ID, DAY } from "../core/constants.ts";

const EARTH = BODY_BY_ID.get("earth")!;
const JUPITER = BODY_BY_ID.get("jupiter")!;

// A torch-class ship — capturing into a LOW circular Jupiter orbit costs ~17 km/s, which a
// chemical ship can't pay; the elliptical capture is the interesting, affordable option.
function design(): ShipDesign {
  return {
    name: "Jovian", payloadMass: 1000, altitudeKm: 400, inclinationDeg: 5,
    stages: [{ name: "Torch", dryMass: 1000, propMass: 9000, isp: 6000, thrust: 5e5 }],
  };
}

/** The cheapest Earth→Jupiter window — a fixed porkchop grid (deterministic). */
function jupiterWindow(): { depT: number; arrT: number } {
  const pork = computePorkchop({
    fromId: "earth", toId: "jupiter",
    depStart: 0, depEnd: 400 * DAY, depN: 50,
    tofMin: 750 * DAY, tofMax: 1150 * DAY, tofN: 40,
    rParkFrom: EARTH.radius + 4e5, rParkTo: JUPITER.radius + 4e5,
  });
  const best = pork.best!;
  return { depT: best.depT, arrT: best.arrT };
}

describe("elliptical (Oberth-cheap) capture in-sim", () => {
  const win = jupiterWindow();
  const apoAlt = looseCaptureApoAlt("jupiter", win.arrT); // ~half Jupiter's SOI

  it("captures a Jupiter arrival for a small fraction of the low-circular burn", () => {
    // Circular baseline arrival cost for the same window.
    const simC = new Simulation(createWorld(1, 0));
    const planC = planTransfer(simC, spawnShip(simC, design()), "jupiter", win.depT, win.arrT, "propulsive")!;
    expect(planC.dvArrive / 1000).toBeGreaterThan(10); // a punishing ~17 km/s low circular capture

    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, design());
    const ship = sim.world.ships.get(id)!;
    const dv0 = dvRemaining(ship);

    const plan = planTransfer(sim, id, "jupiter", win.depT, win.arrT, "propulsive", apoAlt)!;
    expect(plan).not.toBeNull();
    expect(ship.transfer!.captureApoAlt).toBeCloseTo(apoAlt, 3);
    expect(plan.dvArrive).toBeLessThan(0.3 * planC.dvArrive); // the bulk of the capture burn is saved

    // Fly the cruise, SOI entry, and the capture burn.
    sim.step(win.arrT + 5 * DAY - sim.world.t);
    expect(ship.transfer!.arrived).toBe(true);
    expect(ship.primary).toBe("jupiter");

    const el = shipOsculatingElements(ship, sim.world.t);
    expect(el.e).toBeLessThan(1); // bound (captured)
    expect(el.e).toBeGreaterThan(0.8); // and genuinely eccentric — a loose capture ellipse
    const periAlt = el.a * (1 - el.e) - JUPITER.radius;
    expect(periAlt).toBeGreaterThan(0); // periapsis above the cloud tops
    expect(periAlt).toBeLessThan(2e6); // and low — that's where the Oberth burn happened

    // Spent far less than injection + a low circular capture would have.
    const spent = dv0 - dvRemaining(ship);
    expect(spent).toBeLessThan(planC.dvDepart + planC.dvArrive - 8000); // saved most of the ~17 km/s
  });

  it("is deterministic across time-chunkings and round-trips through serialization", () => {
    const runToHash = (chunks: number[]): string => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, design());
      planTransfer(sim, id, "jupiter", win.depT, win.arrT, "propulsive", apoAlt);
      const tEnd = win.arrT + 30 * DAY;
      let i = 0;
      while (sim.world.t < tEnd) sim.step(Math.min(chunks[i++ % chunks.length]!, tEnd - sim.world.t));
      return hashWorld(sim.world);
    };
    expect(runToHash([1e12])).toBe(runToHash([7, 1e6, 0.5, 3600, 5e6]));

    // Mid-cruise the transfer (with captureApoAlt) round-trips with a stable hash.
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, design());
    planTransfer(sim, id, "jupiter", win.depT, win.arrT, "propulsive", apoAlt);
    sim.step(win.depT + 200 * DAY - sim.world.t);
    expect(sim.world.ships.get(id)!.transfer!.captureApoAlt).toBeDefined();
    const ser = serializeWorld(sim.world);
    expect(serializeWorld(deserializeWorld(ser))).toBe(ser);
    expect(hashWorld(deserializeWorld(ser))).toBe(hashWorld(sim.world));
  });
});
