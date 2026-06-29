import { describe, it, expect } from "vitest";
import { createWorld } from "../core/world.ts";
import { Simulation } from "../core/sim.ts";
import { spawnShip, planMoonMission, looseCaptureApoAlt, type ShipDesign } from "./commands.ts";
import { shipOsculatingElements, dvRemaining } from "../core/ships.ts";
import { computePorkchop } from "../core/maneuver/porkchop.ts";
import { serializeWorld, deserializeWorld, hashWorld } from "../core/serialize.ts";
import { BODY_BY_ID, DAY } from "../core/constants.ts";

const EARTH = BODY_BY_ID.get("earth")!;
const JUPITER = BODY_BY_ID.get("jupiter")!;
const EUROPA = BODY_BY_ID.get("europa")!;

// A torch-class ship: capturing into low Jupiter orbit costs ~17 km/s, so the cross-system
// mission needs a generous Δv budget. High-isp + lots of propellant ⇒ ~130 km/s, plenty for
// injection + Jupiter capture + the Europa leg. (The test exercises the chaining, not realism.)
function design(): ShipDesign {
  return {
    name: "Galilean Express", payloadMass: 1000, altitudeKm: 400, inclinationDeg: 5,
    stages: [{ name: "Torch", dryMass: 1000, propMass: 9000, isp: 6000, thrust: 5e5 }],
  };
}

/** The cheapest Earth→Jupiter window — a fixed porkchop grid (deterministic). */
function jupiterWindow(): { depT: number; arrT: number } {
  const pork = computePorkchop({
    fromId: "earth", toId: "jupiter",
    depStart: 0, depEnd: 400 * DAY, depN: 50,
    tofMin: 750 * DAY, tofMax: 1150 * DAY, tofN: 40,
    rParkFrom: EARTH.radius + 4e5,
    rParkTo: JUPITER.radius + 4e5,
  });
  const best = pork.best!;
  return { depT: best.depT, arrT: best.arrT };
}

describe("cross-system two-stage moon missions (Earth → Jupiter → Europa)", () => {
  const win = jupiterWindow();

  it("commits one mission, captures at Jupiter, then auto-chains the Europa leg", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, design());
    const ship = sim.world.ships.get(id)!;
    const dv0 = dvRemaining(ship);

    const plan = planMoonMission(sim, id, "europa", win.depT, win.arrT)!;
    expect(plan).not.toBeNull();
    expect(plan.parentId).toBe("jupiter");
    expect(plan.stage2Dv).toBeGreaterThan(0); // an estimate of the Jupiter→Europa leg
    // Stage 1 carries the final moon — the sim will fly the moon leg on arrival.
    expect(ship.transfer!.thenMoonId).toBe("europa");
    expect(ship.transfer!.targetId).toBe("jupiter");

    // Fly the whole mission: heliocentric cruise → Jupiter capture (which auto-chains the
    // Europa leg) → parent-centric cruise to Europa → capture. Jupiter's SOI is vast, so the
    // capture (and the chained Stage-2 leg, only ~a day long) all happen before the nominal
    // arrival epoch — one warp covers it.
    sim.step(win.arrT + 5 * DAY - sim.world.t);
    expect(ship.primary).toBe("europa");
    // It flew the Europa leg as a parent-centric (Jupiter-frame) Stage 2 — proof of the chain.
    expect(ship.transfer!.targetId).toBe("europa");
    expect(ship.transfer!.central).toBe("jupiter");
    expect(ship.transfer!.thenMoonId).toBeUndefined(); // consumed by the chain
    expect(ship.transfer!.arrived).toBe(true);
    const el = shipOsculatingElements(ship, sim.world.t);
    expect(el.e).toBeLessThan(1); // captured (bound) about Europa
    const periAlt = el.a * (1 - el.e) - EUROPA.radius;
    expect(periAlt).toBeGreaterThan(0); // a real orbit ABOVE Europa's surface
    // A bound orbit inside Europa's SOI (~9.7·10³ km). The min-Δv window favours the cheapest
    // (higher) capture from a deep Jupiter parking orbit — a real, if high, parking orbit.
    expect(el.a * (1 - el.e)).toBeLessThan(9.7e6);

    // The whole mission spent a chunk of the torch budget but stayed within it.
    const spent = dv0 - dvRemaining(ship);
    expect(spent / 1000).toBeGreaterThan(20); // injection + a deep Jupiter capture + the moon leg
    expect(dvRemaining(ship)).toBeGreaterThan(0); // still solvent
  });

  it("is deterministic across time-chunkings and round-trips through serialization", () => {
    const runToHash = (chunks: number[]): string => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, design());
      planMoonMission(sim, id, "europa", win.depT, win.arrT);
      const tEnd = win.arrT + 60 * DAY; // past Jupiter capture + the start of the Europa leg
      let i = 0;
      while (sim.world.t < tEnd) sim.step(Math.min(chunks[i++ % chunks.length]!, tEnd - sim.world.t));
      return hashWorld(sim.world);
    };
    expect(runToHash([1e12])).toBe(runToHash([7, 1e6, 0.5, 3600, 5e6]));

    // After the chain fires, the active Europa leg (central="jupiter") round-trips cleanly.
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, design());
    planMoonMission(sim, id, "europa", win.depT, win.arrT);
    sim.step(win.arrT + 5 * DAY - sim.world.t);
    expect(sim.world.ships.get(id)!.transfer!.central).toBe("jupiter");
    const ser = serializeWorld(sim.world);
    expect(serializeWorld(deserializeWorld(ser))).toBe(ser);
    expect(hashWorld(deserializeWorld(ser))).toBe(hashWorld(sim.world));
  });

  it("an elliptical Stage-1 capture auto-chains a LOOSE moon leg sized to the moon's own well", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, design());
    const ship = sim.world.ships.get(id)!;
    // Capture at Jupiter into the cheap loose ellipse (the realistic deep-well insertion).
    const jupApo = looseCaptureApoAlt("jupiter", win.arrT);
    planMoonMission(sim, id, "europa", win.depT, win.arrT, "propulsive", jupApo);
    expect(ship.transfer!.captureApoAlt).toBe(jupApo); // Stage 1 carries the Jupiter ellipse

    // Step past the Jupiter capture so the chain fires. (A loose Jupiter ellipse has a long period,
    // so the Europa leg DEPARTS much later than the circular case — we assert the chain CONFIGURED
    // the loose Europa leg, not that it has already arrived.)
    sim.step(win.arrT + 5 * DAY - sim.world.t);
    expect(ship.transfer!.targetId).toBe("europa");
    expect(ship.transfer!.central).toBe("jupiter");
    expect(ship.transfer!.thenMoonId).toBeUndefined(); // consumed by the chain
    // The chained Europa leg captures loose too — but sized to EUROPA's own well, not reusing the
    // (vast) Jupiter apoapsis altitude.
    expect(ship.transfer!.captureApoAlt).toBeDefined();
    expect(ship.transfer!.captureApoAlt!).toBeLessThan(jupApo);
  });

  it("a circular Stage-1 capture leaves the auto-chained moon leg circular (no captureApoAlt)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, design());
    const ship = sim.world.ships.get(id)!;
    planMoonMission(sim, id, "europa", win.depT, win.arrT); // default circular
    expect(ship.transfer!.captureApoAlt).toBeUndefined();
    sim.step(win.arrT + 5 * DAY - sim.world.t);
    expect(ship.primary).toBe("europa");
    expect(ship.transfer!.captureApoAlt).toBeUndefined(); // moon leg stayed circular
  });

  it("rejects a same-system moon (use planMoonTransfer) and a non-moon target", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, design());
    const ship = sim.world.ships.get(id)!;
    ship.primary = "earth";
    // The Moon's parent IS our primary — that's a direct (Phase B) transfer, not a mission.
    expect(planMoonMission(sim, id, "moon", win.depT, win.arrT)).toBeNull();
    // Mars is a planet, not a moon.
    expect(planMoonMission(sim, id, "mars", win.depT, win.arrT)).toBeNull();
  });
});
