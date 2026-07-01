import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import { spawnShip, defaultDesign, startISRU, stopISRU, isruStatus, canISRU, launchShip } from "./commands.ts";
import { shipPropHeadroom } from "@lightlag/engine/refuel";
import { circularOrbit } from "@lightlag/engine/orbit";
import { serializeWorld, deserializeWorld, hashWorld } from "@lightlag/engine/serialize";
import { BODY_BY_ID } from "@lightlag/engine/constants";

const MOON = BODY_BY_ID.get("moon")!;
const MOON_RATE = 5000 / MOON.isru!.specificEnergyJPerKg; // default plant power / specific energy (kg/s)

/** Total propellant across a ship's core stages. */
function totalProp(sim: Simulation, id: string): number {
  const s = sim.world.ships.get(id)!;
  let m = 0;
  for (let i = s.activeStage; i < s.stages.length; i++) m += s.stages[i]!.propMass;
  return m;
}

/** A courier landed on the Moon with exactly `room` kg of tank headroom (all in stage 0). */
function landedMiner(sim: Simulation, room = 1000, bodyId = "moon"): string {
  const id = spawnShip(sim, defaultDesign());
  const ship = sim.world.ships.get(id)!;
  ship.primary = bodyId;
  ship.mode = "coast";
  ship.elements = undefined;
  ship.epoch = sim.world.t;
  ship.landed = { bodyId, surfaceDir: { x: 1, y: 0, z: 0 } };
  ship.stages[1]!.propMass = ship.stages[1]!.propCapacity!; // top the upper stage (already full)
  ship.stages[0]!.propMass = ship.stages[0]!.propCapacity! - room; // leave `room` headroom in stage 0
  return id;
}

describe("isru — mining a landed ship", () => {
  it("fills the tanks with exactly the target once the process completes", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = landedMiner(sim, 1000);
    const ship = sim.world.ships.get(id)!;
    const propBefore = totalProp(sim, id);

    const start = startISRU(sim, id)!;
    expect(start.target).toBeCloseTo(1000, 6);
    expect(start.ratePerSec).toBeCloseTo(MOON_RATE, 12);
    expect(start.etaS).toBeCloseTo(1000 / MOON_RATE, 3);

    sim.step(1000 / MOON_RATE + 1e5); // step well past the ETA
    expect(ship.isru).toBeUndefined(); // process cleared at the finalize
    expect(shipPropHeadroom(ship)).toBeCloseTo(0, 6); // tanks full
    expect(totalProp(sim, id) - propBefore).toBeCloseTo(1000, 6); // gained exactly the target
  });

  it("produces identically whether stepped in one jump or irregular chunks (chunk-invariant)", () => {
    const build = (): Simulation => {
      const sim = new Simulation(createWorld(1, 0));
      const id = landedMiner(sim, 1000);
      startISRU(sim, id);
      return sim;
    };
    const tEnd = 1000 / MOON_RATE + 5e5;

    const one = build();
    one.step(tEnd);

    const chunked = build();
    const chunks = [86400, 1e6, 7, 250000, 0.5, 5e5, 3600];
    let i = 0;
    while (chunked.world.t < tEnd) chunked.step(Math.min(chunks[i++ % chunks.length]!, tEnd - chunked.world.t));

    expect(hashWorld(chunked.world)).toBe(hashWorld(one.world));
  });

  it("survives a serialize round-trip mid-process with a stable hash", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = landedMiner(sim, 1000);
    startISRU(sim, id);
    sim.step(1e5); // partway (well short of the full fill)
    expect(sim.world.ships.get(id)!.isru).toBeDefined();

    const restored = deserializeWorld(serializeWorld(sim.world));
    const p = restored.ships.get(id)!.isru!;
    expect(p.bodyId).toBe("moon");
    expect(p.target).toBeCloseTo(1000, 6);
    expect(p.ratePerSec).toBeCloseTo(MOON_RATE, 12);
    expect(hashWorld(restored)).toBe(hashWorld(sim.world));
  });

  it("is golden-hash-neutral: a non-mining landed ship serializes with no isru key", () => {
    const sim = new Simulation(createWorld(1, 0));
    landedMiner(sim, 1000); // landed, but never started mining
    expect(serializeWorld(sim.world)).not.toContain("isru");
  });
});

describe("isru — pre-emption credits partial production", () => {
  it("stopISRU banks the propellant produced so far and cancels the finalize", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = landedMiner(sim, 1000);
    const ship = sim.world.ships.get(id)!;
    startISRU(sim, id);
    const propBefore = totalProp(sim, id);

    const elapsed = 1e5;
    sim.step(elapsed);
    const status = isruStatus(sim, id)!;
    expect(status.producedKg).toBeCloseTo(MOON_RATE * elapsed, 3);

    const res = stopISRU(sim, id)!;
    expect(res.producedKg).toBeCloseTo(MOON_RATE * elapsed, 3);
    expect(ship.isru).toBeUndefined();
    expect(totalProp(sim, id) - propBefore).toBeCloseTo(MOON_RATE * elapsed, 3);

    // No stray finalize: stepping far past the original ETA changes nothing more.
    const propAfterStop = totalProp(sim, id);
    sim.step(1000 / MOON_RATE + 1e6);
    expect(totalProp(sim, id)).toBeCloseTo(propAfterStop, 6);
  });

  it("launching mid-mine clears the process and fires no phantom finalize", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = landedMiner(sim, 1000);
    const ship = sim.world.ships.get(id)!;
    startISRU(sim, id);
    sim.step(1e5);

    const op = launchShip(sim, id, 100)!;
    expect(op.feasible).toBe(true);
    expect(ship.isru).toBeUndefined(); // credited + cleared on the committed launch path
    expect(ship.landed).toBeUndefined();

    // Stepping past the original ETA must not dump a phantom full target into the tanks.
    sim.step(1000 / MOON_RATE + 1e6);
    expect(shipPropHeadroom(ship)).toBeGreaterThan(0); // ascent spent prop; no phantom refill
  });
});

describe("isru — guards", () => {
  it("canISRU / startISRU reject a ship that cannot mine", () => {
    const sim = new Simulation(createWorld(1, 0));

    // Landed on a DRY body (Mars has a surface but no volatiles descriptor).
    const dry = landedMiner(sim, 1000, "mars");
    expect(canISRU(sim, dry)).toBe(false);
    expect(startISRU(sim, dry)).toBeNull();

    // Landed on the Moon but tanks already FULL (no headroom).
    const full = landedMiner(sim, 0);
    expect(canISRU(sim, full)).toBe(false);
    expect(startISRU(sim, full)).toBeNull();

    // In ORBIT (not landed) around the Moon.
    const orbiting = spawnShip(sim, defaultDesign());
    const os = sim.world.ships.get(orbiting)!;
    os.primary = "moon";
    os.elements = circularOrbit(MOON.radius + 100_000, 0, 0, 0);
    os.epoch = sim.world.t;
    os.stages[0]!.propMass = 40_000; // has headroom, but airborne
    expect(canISRU(sim, orbiting)).toBe(false);
    expect(startISRU(sim, orbiting)).toBeNull();

    // Already mining ⇒ a second start is rejected.
    const busy = landedMiner(sim, 1000);
    expect(startISRU(sim, busy)).not.toBeNull();
    expect(startISRU(sim, busy)).toBeNull();

    // A lost ship cannot mine.
    const lost = landedMiner(sim, 1000);
    sim.world.ships.get(lost)!.status = "lost";
    expect(canISRU(sim, lost)).toBe(false);
    expect(startISRU(sim, lost)).toBeNull();
  });
});
