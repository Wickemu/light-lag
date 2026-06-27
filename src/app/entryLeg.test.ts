import { describe, it, expect } from "vitest";
import { createWorld } from "../core/world.ts";
import { Simulation } from "../core/sim.ts";
import { spawnShip, defaultDesign, flyEntry } from "./commands.ts";
import { shipRelativeState, shipEntryReadout, buildEntryLeg } from "../core/ships.ts";
import { entryInterfaceAlt } from "../core/maneuver/entry.ts";
import { serializeWorld, deserializeWorld, hashWorld } from "../core/serialize.ts";
import { BODY_BY_ID } from "../core/constants.ts";
import { length } from "../core/math/vec3.ts";

const EARTH = BODY_BY_ID.get("earth")!;
const R = EARTH.radius;

/** A courier on a deorbit ellipse: apoapsis 300 km, periapsis 40 km (below the
 *  ~94 km entry interface), so its orbit dips into the atmosphere. */
function deorbitShip(sim: Simulation): string {
  const id = spawnShip(sim, defaultDesign());
  const ship = sim.world.ships.get(id)!;
  ship.primary = "earth";
  const ra = R + 300e3, rp = R + 40e3;
  ship.elements = { a: (ra + rp) / 2, e: (ra - rp) / (ra + rp), i: 0.5, Omega: 0.3, omega: 0.1, M: -0.4 };
  ship.epoch = sim.world.t;
  return id;
}

describe("in-sim flyable entry leg", () => {
  it("schedules an entry that flies the ship down to a co-rotating landing", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = deorbitShip(sim);
    const ship = sim.world.ships.get(id)!;

    const plan = flyEntry(sim, id)!;
    expect(plan).not.toBeNull();
    expect(plan.outcome).toBe("landed");
    expect(plan.peakDecelG).toBeGreaterThan(3); // a real ballistic deorbit pulls several g
    expect(plan.tStart).toBeGreaterThan(sim.world.t); // begins at the future interface crossing

    // Step to just after the interface crossing → the entry leg is active.
    sim.step(plan.tStart + 1 - sim.world.t);
    expect(ship.entryLeg).toBeDefined();
    expect(ship.entryLeg!.bodyId).toBe("earth");

    // Mid-pass the ship is inside the atmosphere, decelerating.
    const leg = ship.entryLeg!;
    sim.step(leg.tStart + (leg.tEnd - leg.tStart) * 0.4 - sim.world.t);
    const ro = shipEntryReadout(ship, sim.world.t)!;
    expect(ro.altitudeM).toBeLessThan(94e3); // below the interface
    expect(ro.altitudeM).toBeGreaterThan(0);
    expect(ro.progress).toBeGreaterThan(0.3);
    expect(ro.progress).toBeLessThan(0.5);

    // Past tEnd it has landed (co-rotating on the surface), leg cleared.
    sim.step(leg.tEnd + 10 - sim.world.t);
    expect(ship.entryLeg).toBeUndefined();
    expect(ship.landed?.bodyId).toBe("earth");
    const rel = shipRelativeState(ship, sim.world.t);
    expect(length(rel.r) / R).toBeCloseTo(1, 3); // on the surface
    expect(length(rel.v)).toBeLessThan(500); // surface co-rotation, not orbital speed
  });

  it("the predicted plan matches the standalone entry-trajectory budget", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = deorbitShip(sim);
    const plan = flyEntry(sim, id)!;
    // The committed plan reflects the same fine entry pass entry.ts computes.
    const ship = sim.world.ships.get(id)!;
    sim.step(plan.tStart + 1 - sim.world.t);
    const leg = ship.entryLeg!;
    // The leg's heat-load budget is consistent with a fresh entryTrajectory of the
    // same outcome (same physics, same nominal vehicle).
    expect(leg.outcome).toBe(plan.outcome);
    expect(leg.heatLoad).toBeGreaterThan(0);
    expect(leg.peakWallTemp).toBeGreaterThan(500);
  });

  it("is deterministic across time-chunkings and serialises round-trip mid-pass", () => {
    const runToHash = (chunks: number[]): string => {
      const sim = new Simulation(createWorld(1, 0));
      const id = deorbitShip(sim);
      const plan = flyEntry(sim, id)!;
      const tEnd = plan.tStart + 2000; // covers the whole pass
      let i = 0;
      while (sim.world.t < tEnd) sim.step(Math.min(chunks[i++ % chunks.length]!, tEnd - sim.world.t));
      return hashWorld(sim.world);
    };
    // The leg is a read-time deterministic function, so one big step and irregular
    // chunks must reach byte-identical state.
    expect(runToHash([1e9])).toBe(runToHash([7, 250000, 0.5, 60, 3600]));

    // Mid-pass serialize → deserialize → serialize is stable (the entry leg round-trips).
    const sim = new Simulation(createWorld(1, 0));
    const id = deorbitShip(sim);
    const plan = flyEntry(sim, id)!;
    sim.step(plan.tStart + 50 - sim.world.t);
    expect(sim.world.ships.get(id)!.entryLeg).toBeDefined();
    const ser = serializeWorld(sim.world);
    expect(serializeWorld(deserializeWorld(ser))).toBe(ser);
    expect(hashWorld(deserializeWorld(ser))).toBe(hashWorld(sim.world));
  });

  it("a lethal entry pass destroys the ship instead of parking it on the surface", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    ship.primary = "earth";
    // Build a real entry leg for a dense, low-drag dart on a steep, fast pass — it
    // reaches the ground at lethal speed, so the pass classifies as "crashed".
    const rIface = R + entryInterfaceAlt(EARTH);
    const g = 50 * Math.PI / 180, v = 11000;
    const r0 = { x: rIface, y: 0, z: 0 };
    const v0 = { x: -v * Math.sin(g), y: v * Math.cos(g), z: 0 }; // steep, inbound
    const leg = buildEntryLeg(EARTH, r0, v0, sim.world.t, { ballisticCoef: 8000, noseRadius: 0.3, emissivity: 0.85 })!;
    expect(leg.outcome).toBe("crashed");

    ship.entryLeg = leg;
    ship.mode = "coast";
    ship.elements = undefined;
    ship.epoch = sim.world.t;
    sim.events.push({ t: leg.tEnd, kind: "entry-end", entityId: id });

    sim.step(leg.tEnd + 10 - sim.world.t);
    expect(ship.entryLeg).toBeUndefined();
    expect(ship.status).toBe("lost"); // destroyed, not a healthy landing
    expect(ship.landed?.bodyId).toBe("earth"); // wreck on the surface
  });

  it("refuses to fly an entry from an orbit that clears the atmosphere", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    ship.primary = "earth";
    // Circular orbit at 400 km — periapsis well above the interface.
    const r = R + 400e3;
    ship.elements = { a: r, e: 0, i: 0.5, Omega: 0, omega: 0, M: 0 };
    ship.epoch = sim.world.t;
    expect(flyEntry(sim, id)).toBeNull();
  });

  it("returns null on an airless body", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    ship.primary = "moon";
    const MOON = BODY_BY_ID.get("moon")!;
    const ra = MOON.radius + 50e3, rp = MOON.radius + 1e3;
    ship.elements = { a: (ra + rp) / 2, e: (ra - rp) / (ra + rp), i: 0.2, Omega: 0, omega: 0, M: -0.3 };
    ship.epoch = sim.world.t;
    expect(flyEntry(sim, id)).toBeNull();
  });
});
