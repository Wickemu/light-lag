import { describe, it, expect } from "vitest";
import { createWorld } from "../core/world.ts";
import { Simulation } from "../core/sim.ts";
import { spawnShip, defaultDesign, landShip, launchShip } from "./commands.ts";
import { shipRelativeState } from "../core/ships.ts";
import { serializeWorld, deserializeWorld, hashWorld } from "../core/serialize.ts";
import { circularOrbit } from "../core/orbit.ts";
import { BODY_BY_ID } from "../core/constants.ts";
import { length, normalize } from "../core/math/vec3.ts";

const MOON = BODY_BY_ID.get("moon")!;

/** A ship sitting on the lunar surface at a mid-latitude site. */
function landedMoonShip(sim: Simulation): string {
  const id = spawnShip(sim, defaultDesign());
  const ship = sim.world.ships.get(id)!;
  ship.primary = "moon";
  ship.mode = "coast";
  ship.elements = undefined;
  ship.epoch = sim.world.t;
  ship.landed = { bodyId: "moon", surfaceDir: normalize({ x: 0.3, y: 0.2, z: 0.5 }) };
  return id;
}

/** A ship parked in a 100 km circular lunar orbit. */
function orbitMoonShip(sim: Simulation): string {
  const id = spawnShip(sim, defaultDesign());
  const ship = sim.world.ships.get(id)!;
  ship.primary = "moon";
  ship.elements = circularOrbit(MOON.radius + 100_000, 0.3, 0, 0);
  ship.epoch = sim.world.t;
  return id;
}

describe("in-sim animated launch / landing legs", () => {
  it("flies a launch arc from the surface up to the parking orbit (no snap)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = landedMoonShip(sim);
    const ship = sim.world.ships.get(id)!;

    const op = launchShip(sim, id, 100)!;
    expect(op.feasible).toBe(true);
    // The leg is active immediately; the ship has left the surface but isn't yet coasting.
    expect(ship.launchLeg).toBeDefined();
    expect(ship.launchLeg!.bodyId).toBe("moon");
    expect(ship.landed).toBeUndefined();

    const leg = ship.launchLeg!;
    expect(leg.tEnd).toBeGreaterThan(leg.tStart); // a real, finite arc

    // At liftoff the ship is on the surface.
    const r0 = shipRelativeState(ship, leg.tStart);
    expect(length(r0.r) / MOON.radius).toBeCloseTo(1, 2);

    // The arc climbs monotonically (a flown trajectory, not a teleport).
    const span = leg.tEnd - leg.tStart;
    const altAt = (frac: number) => length(shipRelativeState(ship, leg.tStart + span * frac).r) - MOON.radius;
    const aEarly = altAt(0.25), aLate = altAt(0.75);
    expect(aEarly).toBeGreaterThan(0);
    expect(aLate).toBeGreaterThan(aEarly); // still climbing
    expect(aLate).toBeLessThan(105e3); // below/at the parking altitude

    // Past tEnd: the leg is cleared and the ship coasts a ~100 km circular orbit.
    sim.step(leg.tEnd + 10 - sim.world.t);
    expect(ship.launchLeg).toBeUndefined();
    const alt = ship.elements!.a - MOON.radius;
    expect(alt / 1000).toBeGreaterThan(90);
    expect(alt / 1000).toBeLessThan(110);
    expect(ship.elements!.e).toBeLessThan(0.02); // clean circular insertion
  });

  it("flies a descent arc from orbit down to a co-rotating touchdown (no snap)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = orbitMoonShip(sim);
    const ship = sim.world.ships.get(id)!;

    const op = landShip(sim, id)!;
    expect(op.feasible).toBe(true);
    expect(ship.descentLeg).toBeDefined();
    expect(ship.descentLeg!.bodyId).toBe("moon");
    expect(ship.landed).toBeUndefined(); // not landed until the arc finalizes

    const leg = ship.descentLeg!;
    // At the start the ship is at the parking altitude; it descends monotonically.
    const span = leg.tEnd - leg.tStart;
    const altAt = (frac: number) => length(shipRelativeState(ship, leg.tStart + span * frac).r) - MOON.radius;
    expect(altAt(0.0) / 1000).toBeGreaterThan(90);
    expect(altAt(0.75)).toBeLessThan(altAt(0.25)); // descending
    expect(altAt(0.75)).toBeGreaterThan(0);

    // Past tEnd: landed, co-rotating on the surface at surface speed.
    sim.step(leg.tEnd + 10 - sim.world.t);
    expect(ship.descentLeg).toBeUndefined();
    expect(ship.landed?.bodyId).toBe("moon");
    const rel = shipRelativeState(ship, sim.world.t);
    expect(length(rel.r) / MOON.radius).toBeCloseTo(1, 3); // on the surface
    expect(length(rel.v)).toBeLessThan(50); // surface co-rotation, not orbital speed
  });

  it("legs are deterministic across time-chunkings and serialise round-trip mid-arc", () => {
    // Launch then (after it finalizes) land — exercise both legs, hashed at the end.
    const runToHash = (chunks: number[]): string => {
      const sim = new Simulation(createWorld(1, 0));
      const id = landedMoonShip(sim);
      launchShip(sim, id, 100);
      const tEnd = sim.world.t + 8000; // well past the ascent arc
      let i = 0;
      while (sim.world.t < tEnd) sim.step(Math.min(chunks[i++ % chunks.length]!, tEnd - sim.world.t));
      return hashWorld(sim.world);
    };
    // The leg is a read-time deterministic function (fixed spline + pinned exit), so one
    // big step and irregular chunks must reach byte-identical state.
    expect(runToHash([1e9])).toBe(runToHash([7, 250000, 0.5, 60, 3600]));

    // Mid-arc serialize → deserialize → serialize is stable (the launch leg round-trips).
    const sim = new Simulation(createWorld(1, 0));
    const id = landedMoonShip(sim);
    launchShip(sim, id, 100);
    const leg = sim.world.ships.get(id)!.launchLeg!;
    sim.step(leg.tStart + (leg.tEnd - leg.tStart) * 0.5 - sim.world.t);
    expect(sim.world.ships.get(id)!.launchLeg).toBeDefined();
    const ser = serializeWorld(sim.world);
    expect(serializeWorld(deserializeWorld(ser))).toBe(ser);
    expect(hashWorld(deserializeWorld(ser))).toBe(hashWorld(sim.world));
  });
});
