import { describe, it, expect } from "vitest";
import { Simulation } from "@lightlag/engine/sim";
import { createWorld, type Ship } from "@lightlag/engine/world";
import { circularOrbit } from "@lightlag/engine/orbit";
import { BODY_BY_ID, DEG } from "@lightlag/engine/constants";
import { hashWorld } from "@lightlag/engine/serialize";
import { ReplayController } from "./replay.ts";

const R_EARTH = BODY_BY_ID.get("earth")!.radius;

function coastSim(): Simulation {
  const sim = new Simulation(createWorld(42, 0, "earth"));
  const ship: Ship = {
    id: "s1", name: "Probe", primary: "earth", mode: "coast",
    elements: circularOrbit(R_EARTH + 500e3, 51 * DEG, 0, 0), epoch: 0,
    payloadMass: 1000, stages: [], activeStage: 0, tau: 0,
  };
  sim.world.ships.set(ship.id, ship);
  return sim;
}

describe("ReplayController", () => {
  it("scrubbing back then forward lands on the same state as the uninterrupted run", () => {
    const sim = coastSim();
    const r = new ReplayController(sim, { keyframeInterval: 600 });
    r.begin();
    r.scrubTo(7200);
    const hForward = hashWorld(sim.world);
    r.scrubTo(1800); // back (restores a keyframe in place, re-steps)
    r.scrubTo(7200); // forward again
    expect(hashWorld(sim.world)).toBe(hForward);
  });

  it("is deterministic: scrubbing to the same time twice gives the same hash", () => {
    const sim = coastSim();
    const r = new ReplayController(sim);
    r.begin();
    r.scrubTo(10000);
    const h1 = hashWorld(sim.world);
    r.scrubTo(0);
    r.scrubTo(10000);
    expect(hashWorld(sim.world)).toBe(h1);
  });

  it("clamps the playhead to the start time and tracks the max reached", () => {
    const sim = coastSim();
    const r = new ReplayController(sim);
    r.begin();
    expect(r.startTime).toBe(0);
    r.scrubTo(5000);
    expect(r.maxTime).toBe(5000);
    r.scrubTo(-9999); // clamped to startTime
    expect(r.currentTime).toBe(0);
    expect(r.maxTime).toBe(5000); // max is unchanged by scrubbing back
  });
});
