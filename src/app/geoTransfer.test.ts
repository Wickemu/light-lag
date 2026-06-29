import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import {
  spawnShip, planGeoRaise, geoRaisePreview, planSynchronousTransfer, computeSynchronousPorkchop,
  synchronousOrbitFeasible, defaultDesign,
} from "./commands.ts";
import { shipOsculatingElements, dvRemaining } from "@lightlag/engine/ships";
import { circularOrbit, synchronousRadius, orbitalPeriod } from "@lightlag/engine/orbit";
import { transferWindow } from "@lightlag/engine/maneuver/suggest";
import { serializeWorld, deserializeWorld, hashWorld } from "@lightlag/engine/serialize";
import { BODY_BY_ID, DAY } from "@lightlag/engine/constants";

const EARTH = BODY_BY_ID.get("earth")!;
const MARS = BODY_BY_ID.get("mars")!;
const MOON = BODY_BY_ID.get("moon")!;
const A_GEO = synchronousRadius(EARTH.mu, EARTH.rotationPeriod!);

/** A ~400 km Earth parking orbit on a high-Δv Courier (enough for GEO and an areostationary leg). */
function courierLeo(sim: Simulation, inclRad = 0.09): string {
  const id = spawnShip(sim, defaultDesign());
  const ship = sim.world.ships.get(id)!;
  ship.primary = "earth";
  ship.elements = circularOrbit(EARTH.radius + 400e3, inclRad, 0, 0);
  ship.epoch = sim.world.t;
  return id;
}

describe("same-primary GEO raise (Earth LEO → GEO)", () => {
  it("costs an LEO→GEO Hohmann (~3.8–4.4 km/s incl. the equatorial plane change)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = courierLeo(sim);
    const plan = planGeoRaise(sim, id)!;
    expect(plan).not.toBeNull();
    expect(plan.mode).toBe("hohmann");
    expect(plan.aSync).toBeCloseTo(A_GEO, -3);
    expect(plan.dvTotal / 1000).toBeGreaterThan(3.7);
    expect(plan.dvTotal / 1000).toBeLessThan(4.6);
    // The transfer is an in-SOI raise: cruise frame is the primary itself, marked synchronous.
    const tr = sim.world.ships.get(id)!.transfer!;
    expect(tr.central).toBe("earth");
    expect(tr.arrival).toEqual({ kind: "synchronous" });
  });

  it("flies the transfer ellipse and circularizes into an equatorial GEO orbit", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = courierLeo(sim);
    const ship = sim.world.ships.get(id)!;
    const dv0 = dvRemaining(ship);
    const plan = planGeoRaise(sim, id)!;

    sim.step(plan.tof + 2 * 3600); // depart now, coast to apoapsis, circularize
    expect(ship.transfer!.arrived).toBe(true);
    expect(ship.primary).toBe("earth"); // never left Earth's SOI

    const el = shipOsculatingElements(ship, sim.world.t);
    expect(Math.abs(el.a - A_GEO) / A_GEO).toBeLessThan(0.01); // circular at synchronous radius
    expect(el.e).toBeLessThan(0.02);
    // A synchronous orbit's period equals Earth's sidereal rotation period.
    expect(orbitalPeriod(el.a, EARTH.mu)).toBeCloseTo(EARTH.rotationPeriod!, -2);

    const spent = dv0 - dvRemaining(ship);
    expect(spent / 1000).toBeGreaterThan(3.5);
    expect(spent / 1000).toBeLessThan(4.7);
  });

  it("is deterministic across time-chunkings and round-trips through serialization", () => {
    const runToHash = (chunks: number[]): string => {
      const sim = new Simulation(createWorld(1, 0));
      const id = courierLeo(sim);
      const plan = planGeoRaise(sim, id)!;
      const tEnd = plan.tof + 3 * 3600;
      let i = 0;
      while (sim.world.t < tEnd) sim.step(Math.min(chunks[i++ % chunks.length]!, tEnd - sim.world.t));
      return hashWorld(sim.world);
    };
    expect(runToHash([1e9])).toBe(runToHash([7, 1e4, 0.5, 900, 5e3]));

    // Mid-raise (on the transfer ellipse) the transfer round-trips with a stable hash.
    const sim = new Simulation(createWorld(1, 0));
    const id = courierLeo(sim);
    const plan = planGeoRaise(sim, id)!;
    sim.step(plan.tof * 0.4);
    expect(sim.world.ships.get(id)!.transfer!.departed).toBe(true);
    const ser = serializeWorld(sim.world);
    expect(serializeWorld(deserializeWorld(ser))).toBe(ser);
    expect(hashWorld(deserializeWorld(ser))).toBe(hashWorld(sim.world));
  });
});

describe("remote synchronous capture (Mars areostationary)", () => {
  it("captures into a circular orbit at Mars' synchronous radius", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = courierLeo(sim);
    const ship = sim.world.ships.get(id)!;

    const win = transferWindow("earth", "mars", 0);
    const grid = { depStart: 0, depEnd: win.depSpan, depN: 40, tofMin: win.tofMin, tofMax: win.tofMax, tofN: 30 };
    const pork = computeSynchronousPorkchop("earth", "mars", grid, EARTH.radius + 400e3)!;
    expect(pork.best).not.toBeNull();
    const best = pork.best!;

    const plan = planSynchronousTransfer(sim, id, "mars", best.depT, best.arrT)!;
    expect(plan).not.toBeNull();
    expect(ship.transfer!.arrival).toEqual({ kind: "synchronous" });

    sim.step(best.arrT + 5 * DAY - sim.world.t);
    expect(ship.transfer!.arrived).toBe(true);
    expect(ship.primary).toBe("mars");
    const el = shipOsculatingElements(ship, sim.world.t);
    const aSync = synchronousRadius(MARS.mu, MARS.rotationPeriod!);
    expect(Math.abs(el.a - aSync) / aSync).toBeLessThan(0.03);
    expect(el.e).toBeLessThan(0.05);
  });
});

describe("synchronous-orbit feasibility", () => {
  it("is offered at Earth and Mars but not the Moon (a_sync exceeds the lunar SOI)", () => {
    expect(synchronousOrbitFeasible(EARTH, 0)).toBe(true);
    expect(synchronousOrbitFeasible(MARS, 0)).toBe(true);
    expect(synchronousOrbitFeasible(MOON, 0)).toBe(false);
  });

  it("planSynchronousTransfer and a Moon GEO raise both refuse the Moon", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = courierLeo(sim);
    // No synchronous orbit at the Moon.
    expect(planSynchronousTransfer(sim, id, "moon", 0, 5 * DAY)).toBeNull();
    // A ship orbiting the Moon can't raise to a (non-existent) lunar GEO.
    const lunarId = spawnShip(sim, defaultDesign());
    const lunar = sim.world.ships.get(lunarId)!;
    lunar.primary = "moon";
    lunar.elements = circularOrbit(MOON.radius + 100e3, 0.1, 0, 0);
    lunar.epoch = sim.world.t;
    expect(geoRaisePreview(sim, lunarId)).toBeNull();
    expect(planGeoRaise(sim, lunarId)).toBeNull();
  });
});
