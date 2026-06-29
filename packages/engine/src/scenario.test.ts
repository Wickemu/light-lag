import { describe, it, expect } from "vitest";
import { Simulation } from "./sim.ts";
import { createWorld, type Ship } from "./world.ts";
import { EventQueue } from "./time.ts";
import { circularOrbit } from "./orbit.ts";
import { BODY_BY_ID, DEG } from "./constants.ts";
import { hashWorld, deserializeWorld } from "./serialize.ts";
import {
  snapshot, restore, serializeWorldLossless,
  makeScenario, serializeScenario, deserializeScenario, loadScenario, evaluateObjective,
} from "./scenario.ts";

const R_EARTH = BODY_BY_ID.get("earth")!.radius;

/** A minimal, app-free LEO ship with enough Δv to accept a burn command. */
function leoSim(): { sim: Simulation; shipId: string } {
  const sim = new Simulation(createWorld(42, 0, "earth"));
  const ship: Ship = {
    id: "s1", name: "Probe", primary: "earth", mode: "coast",
    elements: circularOrbit(R_EARTH + 400e3, 51.6 * DEG, 0, 0), epoch: 0,
    payloadMass: 1000,
    stages: [{ name: "S1", dryMass: 500, propMass: 600, isp: 300, thrust: 2e4 }],
    activeStage: 0, tau: 0,
  };
  sim.world.ships.set(ship.id, ship);
  return { sim, shipId: ship.id };
}

describe("EventQueue snapshot/load", () => {
  it("round-trips pending events preserving time and equal-time (seq) order", () => {
    const q = new EventQueue();
    q.push({ t: 100, kind: "capture", entityId: "a" }); // seq 0
    q.push({ t: 50, kind: "soi-exit", entityId: "b" }); // seq 1
    q.push({ t: 100, kind: "flyby-pass", entityId: "c" }); // seq 2 — ties a, must order after

    const q2 = new EventQueue();
    q2.load(q.snapshot());

    const order: (string | undefined)[] = [];
    for (let ev = q2.popDue(Infinity); ev; ev = q2.popDue(Infinity)) order.push(ev.entityId);
    expect(order).toEqual(["b", "a", "c"]);
  });

  it("advances the insertion counter so post-load pushes order after restored ties", () => {
    const q = new EventQueue();
    q.push({ t: 100, kind: "capture", entityId: "restored" });
    const q2 = new EventQueue();
    q2.load(q.snapshot());
    q2.push({ t: 100, kind: "capture", entityId: "fresh" }); // equal time, pushed later

    const order: (string | undefined)[] = [];
    for (let ev = q2.popDue(Infinity); ev; ev = q2.popDue(Infinity)) order.push(ev.entityId);
    expect(order).toEqual(["restored", "fresh"]);
  });
});

describe("lossless world serialization", () => {
  it("round-trips full-precision numbers and is idempotent", () => {
    const { sim } = leoSim();
    sim.world.t = 1234.567890123456;
    const str = serializeWorldLossless(sim.world);
    const w2 = deserializeWorld(str);
    expect(w2.t).toBe(1234.567890123456); // exact, not quantized
    expect(w2.ships.get("s1")!.elements!.a).toBe(sim.world.ships.get("s1")!.elements!.a);
    expect(serializeWorldLossless(w2)).toBe(str); // idempotent
  });

  it("round-trips non-finite values via tokens (parabolic a = ∞)", () => {
    const { sim } = leoSim();
    sim.world.ships.get("s1")!.elements!.a = Infinity;
    const w2 = deserializeWorld(serializeWorldLossless(sim.world));
    expect(w2.ships.get("s1")!.elements!.a).toBe(Infinity);
  });
});

describe("snapshot / restore equivalence", () => {
  it("restoring a coasting snapshot reproduces the run byte-for-byte", () => {
    const { sim } = leoSim();
    sim.step(1800); // coast half an orbit
    const snap = snapshot(sim);

    sim.step(5400);
    const hUninterrupted = hashWorld(sim.world);

    const sim2 = restore(snap);
    sim2.step(5400);
    expect(hashWorld(sim2.world)).toBe(hUninterrupted);
  });

  it("restores a snapshot taken with a command IN FLIGHT (event + message pending)", () => {
    const { sim, shipId } = leoSim();
    // The command becomes a light-lagged message + a pending message-arrival event.
    expect(sim.sendCommand(shipId, { type: "burn", dv: 120, dir: "prograde" })).not.toBeNull();
    expect(sim.world.messages.length).toBe(1);

    const snap = snapshot(sim); // captures the in-flight message AND the pending event
    expect(snap.events.length).toBe(1);

    sim.step(5400); // delivery → burn → coast
    const hUninterrupted = hashWorld(sim.world);

    const sim2 = restore(snap);
    sim2.step(5400);
    expect(hashWorld(sim2.world)).toBe(hUninterrupted);
  });
});

describe("scenarios", () => {
  it("serialize → deserialize → serialize is stable, and loads to the same state", () => {
    const { sim, shipId } = leoSim();
    const sc = makeScenario("LEO test", sim, {
      objectives: [{ id: "o1", label: "ship exists", predicate: { kind: "shipExists", shipId } }],
    });
    const str = serializeScenario(sc);
    expect(serializeScenario(deserializeScenario(str))).toBe(str);

    const loaded = loadScenario(deserializeScenario(str));
    expect(hashWorld(loaded.world)).toBe(hashWorld(sim.world));
  });
});

describe("evaluateObjective", () => {
  it("evaluates the predicate kinds against a world", () => {
    const { sim, shipId } = leoSim();
    const w = sim.world;
    expect(evaluateObjective(w, { kind: "shipExists", shipId })).toBe(true);
    expect(evaluateObjective(w, { kind: "shipExists", shipId: "nope" })).toBe(false);
    expect(evaluateObjective(w, { kind: "reachedBody", shipId, bodyId: "earth" })).toBe(true);
    expect(evaluateObjective(w, { kind: "reachedBody", shipId, bodyId: "mars" })).toBe(false);
    expect(evaluateObjective(w, { kind: "timeReached", t: 0 })).toBe(true);
    expect(evaluateObjective(w, { kind: "timeReached", t: 1e9 })).toBe(false);
    expect(evaluateObjective(w, { kind: "shipLost", shipId })).toBe(false);
    expect(
      evaluateObjective(w, {
        kind: "orbitAchieved", shipId, bodyId: "earth",
        periapsisMin: R_EARTH + 300e3, periapsisMax: R_EARTH + 500e3,
      }),
    ).toBe(true);
    expect(
      evaluateObjective(w, { kind: "orbitAchieved", shipId, apoapsisMax: R_EARTH + 100e3 }),
    ).toBe(false);
  });
});
