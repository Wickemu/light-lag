import { describe, it, expect } from "vitest";
import { createWorld } from "./world.ts";
import { Simulation } from "./sim.ts";
import { spawnShip, sendBurn, defaultDesign, planTransfer } from "../app/commands.ts";
import { shipOsculatingElements, totalMass, shipWorldState, applyImpulsiveDv, dvRemaining, shipThermalState } from "./ships.ts";
import { summarizeOrbit } from "./orbit.ts";
import { exhaustVelocity, propellantForDv } from "./propulsion.ts";
import { computePorkchop } from "./maneuver/porkchop.ts";
import { bodyState } from "./ephemeris.ts";
import { distance } from "./math/vec3.ts";
import { BODY_BY_ID, DAY } from "./constants.ts";
import { flyUntilCoast } from "./test-helpers.ts";

const MU_EARTH = BODY_BY_ID.get("earth")!.mu;
const R_EARTH = BODY_BY_ID.get("earth")!.radius;

describe("finite-thrust prograde burn", () => {
  it("raises apoapsis, keeps the burn point as periapsis, and spends propellant per Tsiolkovsky", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;

    const before = summarizeOrbit(shipOsculatingElements(ship, 0), MU_EARTH, R_EARTH);
    const m0 = totalMass(ship);
    const propBefore = ship.stages[0]!.propMass;
    const ve = exhaustVelocity(ship.stages[0]!.isp);

    sendBurn(sim, id, 1000, "prograde");
    flyUntilCoast(sim, id);

    const after = summarizeOrbit(shipOsculatingElements(ship, sim.world.t), MU_EARTH, R_EARTH);

    // A prograde burn from a circular LEO dumps energy into the far side.
    expect(after.apoapsisAlt).toBeGreaterThan(before.apoapsisAlt + 3e6);
    // The burn point stays roughly the periapsis.
    expect(Math.abs(after.periapsisAlt - before.periapsisAlt)).toBeLessThan(1.5e5);

    // Propellant spent matches the rocket equation for the delivered engine Δv.
    // With exact event-detected cutoff this is tight (well under 0.5%).
    const propConsumed = propBefore - ship.stages[0]!.propMass;
    const expected = propellantForDv(ve, m0, 1000);
    expect(Math.abs(propConsumed - expected) / expected).toBeLessThan(0.005);

    // Orbital energy increased.
    expect(after.period).toBeGreaterThan(before.period);
  });

  it("ends in a stable, still-bound orbit (no integrator blow-up)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    sendBurn(sim, id, 800, "prograde");
    flyUntilCoast(sim, id);
    const el = shipOsculatingElements(sim.world.ships.get(id)!, sim.world.t);
    expect(el.e).toBeLessThan(1); // still bound
    expect(el.a).toBeGreaterThan(0);
    expect(Number.isFinite(el.a)).toBe(true);
  });
});

describe("burn cutoff precision (event-detected, no overshoot)", () => {
  it("a small 50 m/s burn consumes propellant within 0.5% of Tsiolkovsky", () => {
    // Pre-fix, a sub-step-boundary cutoff overshot a small burn badly (tens of
    // m/s on a ~16 m/s² stage). Event detection must land it on target.
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    const m0 = totalMass(ship);
    const ve = exhaustVelocity(ship.stages[0]!.isp);
    const propBefore = ship.stages[0]!.propMass;

    sendBurn(sim, id, 50, "prograde");
    flyUntilCoast(sim, id);

    const propConsumed = propBefore - ship.stages[0]!.propMass;
    const expected = propellantForDv(ve, m0, 50);
    expect(Math.abs(propConsumed - expected) / expected).toBeLessThan(0.005);
  });
});

describe("determinism of powered flight", () => {
  it("grid-aligned chunking is reproducible: step(600) == step(300)+step(300)", () => {
    const run = (chunks: number[]) => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, defaultDesign());
      sendBurn(sim, id, 1200, "prograde");
      for (const c of chunks) sim.step(c);
      return shipOsculatingElements(sim.world.ships.get(id)!, sim.world.t);
    };
    const one = run([600]);
    const split = run([300, 300]);
    expect(Math.abs(one.a - split.a)).toBeLessThan(1e-3);
    expect(Math.abs(one.e - split.e)).toBeLessThan(1e-12);
    expect(Math.abs(one.M - split.M)).toBeLessThan(1e-12);
  });

  it("the Δv cutoff lands at the same absolute time regardless of chunk size", () => {
    // Coarse vs fine chunking must agree closely (events are analytic; only RK4
    // truncation differs, ~sub-metre — the old km-scale divergence is gone).
    const run = (chunk: number) => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, defaultDesign());
      sendBurn(sim, id, 1200, "prograde");
      while (sim.world.t < 600) sim.step(chunk);
      return shipOsculatingElements(sim.world.ships.get(id)!, sim.world.t);
    };
    const coarse = run(7); // non-grid-aligned chunk
    const fine = run(0.5);
    expect(Math.abs(coarse.a - fine.a)).toBeLessThan(50); // metres
  });
});

describe("interplanetary transfer execution", () => {
  it("departs on the heliocentric leg and arrives at Mars", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;

    // Pick the cheapest window from a porkchop over one synodic period.
    const pork = computePorkchop({
      fromId: "earth", toId: "mars",
      depStart: 0, depEnd: 800 * DAY, depN: 60,
      tofMin: 120 * DAY, tofMax: 330 * DAY, tofN: 44,
      rParkFrom: R_EARTH + 4e5,
      rParkTo: BODY_BY_ID.get("mars")!.radius + 4e5,
    });
    const best = pork.best!;
    const plan = planTransfer(sim, id, "mars", best.depT, best.arrT);
    expect(plan).not.toBeNull();
    expect(ship.primary).toBe("earth"); // not yet departed

    // Fast-forward past departure: the injection fires from the event queue.
    sim.step(best.depT + DAY);
    expect(ship.transfer!.departed).toBe(true);
    expect(ship.primary).toBe("sun"); // now on the heliocentric transfer

    // Fast-forward to arrival.
    sim.step(best.arrT - sim.world.t + DAY);
    expect(ship.transfer!.arrived).toBe(true);

    // The ship should be essentially at Mars at the arrival instant.
    const shipPos = shipWorldState(ship, best.arrT).r;
    const marsPos = bodyState(BODY_BY_ID.get("mars")!, best.arrT).r;
    expect(distance(shipPos, marsPos)).toBeLessThan(1e8); // < 100,000 km
  });
});

describe("Phase 4: SOI patched conics and Mars capture", () => {
  it("crosses Mars's SOI and captures into a bound orbit above the surface", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    const mars = BODY_BY_ID.get("mars")!;

    const pork = computePorkchop({
      fromId: "earth", toId: "mars",
      depStart: 0, depEnd: 800 * DAY, depN: 60,
      tofMin: 120 * DAY, tofMax: 330 * DAY, tofN: 44,
      rParkFrom: R_EARTH + 4e5,
      rParkTo: mars.radius + 4e5,
    });
    const best = pork.best!;
    planTransfer(sim, id, "mars", best.depT, best.arrT);

    // Fly the entire transfer in one jump; the event cascade (depart → SOI
    // crossing → capture) all fires inside the analytic fast path.
    sim.step(best.arrT - sim.world.t + 5 * DAY);

    expect(ship.transfer!.departed).toBe(true);
    expect(ship.transfer!.inSoi).toBe(true);
    expect(ship.transfer!.arrived).toBe(true);
    expect(ship.primary).toBe("mars");

    const el = shipOsculatingElements(ship, sim.world.t);
    expect(el.e).toBeLessThan(0.02); // vector circularization → very near circular
    expect(el.a).toBeGreaterThan(0);
    const peri = el.a * (1 - el.e);
    expect(peri).toBeGreaterThan(mars.radius); // clears the surface
    expect(peri).toBeLessThan(mars.radius + 3e6); // a low-ish Mars orbit
  });

  it("refuses a transfer the ship cannot afford (no free Δv on an empty tank)", () => {
    const sim = new Simulation(createWorld(1, 0));
    // A tug with only ~0.66 km/s — far short of the ~3.6 km/s injection.
    const id = spawnShip(sim, {
      name: "Tug", payloadMass: 3000, altitudeKm: 400, inclinationDeg: 28.5,
      stages: [{ name: "S1", dryMass: 5000, propMass: 2000, isp: 300, thrust: 1e6 }],
    });
    const ship = sim.world.ships.get(id)!;
    const pork = computePorkchop({
      fromId: "earth", toId: "mars",
      depStart: 0, depEnd: 800 * DAY, depN: 60, tofMin: 120 * DAY, tofMax: 330 * DAY, tofN: 44,
      rParkFrom: R_EARTH + 4e5, rParkTo: BODY_BY_ID.get("mars")!.radius + 4e5,
    });
    const best = pork.best!;
    const dvBefore = dvRemaining(ship);
    planTransfer(sim, id, "mars", best.depT, best.arrT);
    sim.step(best.depT - sim.world.t + DAY);

    expect(ship.primary).toBe("earth"); // never left the parking orbit
    expect(dvRemaining(ship)).toBeCloseTo(dvBefore, 3); // propellant untouched
  });
});

describe("applyImpulsiveDv affordability", () => {
  it("returns false and mutates nothing when the burn is unaffordable", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    const before = totalMass(ship);
    expect(applyImpulsiveDv(ship, 1e6)).toBe(false); // way past the budget
    expect(totalMass(ship)).toBe(before);
  });
});

describe("Phase 5: light-lag command", () => {
  it("a burn order reaches a ship in transit only after the one-way light delay", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const pork = computePorkchop({
      fromId: "earth", toId: "mars",
      depStart: 0, depEnd: 800 * DAY, depN: 60, tofMin: 120 * DAY, tofMax: 330 * DAY, tofN: 44,
      rParkFrom: R_EARTH + 4e5, rParkTo: BODY_BY_ID.get("mars")!.radius + 4e5,
    });
    const best = pork.best!;
    planTransfer(sim, id, "mars", best.depT, best.arrT);
    sim.step(best.depT + 130 * DAY - sim.world.t); // deep in transit, far from Earth
    const ship = sim.world.ships.get(id)!;
    expect(ship.primary).toBe("sun");

    const propBefore = ship.stages.reduce((s, st) => s + st.propMass, 0);
    const res = sim.sendCommand(id, { type: "burn", dv: 50, dir: "prograde" });
    expect(res).not.toBeNull();
    expect(res!.delay).toBeGreaterThan(120); // minutes of light-lag, not instant
    expect(ship.mode).toBe("coast"); // order not yet arrived

    sim.step(res!.delay - 60);
    expect(ship.mode).toBe("coast"); // still en route
    expect(ship.stages.reduce((s, st) => s + st.propMass, 0)).toBe(propBefore); // no burn yet

    sim.step(120); // cross the arrival time (the short burn may also finish here)
    // Order delivered: propellant was spent, the command is consumed, and an
    // acknowledgement is now crawling back to Earth at c.
    expect(ship.stages.reduce((s, st) => s + st.propMass, 0)).toBeLessThan(propBefore);
    expect(sim.world.messages.some((m) => m.kind === "command")).toBe(false);
    expect(sim.world.messages.some((m) => m.kind === "telemetry")).toBe(true);
  });

  it("integrates a light-lag-delivered burn the same whether stepped coarse or fine", () => {
    // A command can be delivered (and its burn started) mid-interval while the
    // player fast-forwards. The event-aware step must integrate that burn, not
    // skip it, regardless of how time was chunked.
    const run = (chunk: number) => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, defaultDesign());
      const pork = computePorkchop({
        fromId: "earth", toId: "mars",
        depStart: 0, depEnd: 800 * DAY, depN: 60, tofMin: 120 * DAY, tofMax: 330 * DAY, tofN: 44,
        rParkFrom: R_EARTH + 4e5, rParkTo: BODY_BY_ID.get("mars")!.radius + 4e5,
      });
      const best = pork.best!;
      planTransfer(sim, id, "mars", best.depT, best.arrT);
      sim.step(best.depT + 130 * DAY - sim.world.t);
      const res = sim.sendCommand(id, { type: "burn", dv: 200, dir: "prograde" })!;
      const tEnd = sim.world.t + res.delay + 5000;
      while (sim.world.t < tEnd) sim.step(Math.min(chunk, tEnd - sim.world.t));
      return shipOsculatingElements(sim.world.ships.get(id)!, sim.world.t);
    };
    const big = run(1e12); // one giant jump across delivery + burn
    const fine = run(30);
    expect(Math.abs(big.a - fine.a)).toBeLessThan(50); // metres
    expect(Math.abs(big.e - fine.e)).toBeLessThan(1e-5);
  });
});

describe("Phase 6: ship thermal & detection model", () => {
  it("a thrusting drive spikes the signature but does NOT cook the hull", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;

    const coast = shipThermalState(ship, 0);
    expect(coast.hullTempK).toBeGreaterThan(250); // ~1 AU equilibrium
    expect(coast.hullTempK).toBeLessThan(360);
    expect(coast.reflectedSignatureW).toBeGreaterThan(0); // reflected-sunlight channel exists
    expect(coast.driveWasteW).toBe(0);
    expect(coast.detectionRangeM).toBeGreaterThan(0); // even cold, you glow

    sim.sendCommand(id, { type: "burn", dv: 500, dir: "prograde" });
    let g = 0;
    while (ship.mode !== "thrust" && g++ < 50) sim.step(1);
    const burn = shipThermalState(ship, sim.world.t);

    // Hull temperature is set by the passive load, not the drive — no vaporizing.
    expect(burn.hullTempK).toBeLessThan(360);
    expect(burn.driveWasteW).toBeGreaterThan(0);
    expect(burn.radiatorAreaM2).toBeGreaterThan(0); // a real radiator burden
    // A burning drive is a far brighter beacon than a coasting hull.
    expect(burn.detectionRangeM).toBeGreaterThan(coast.detectionRangeM * 5);
  });
});

describe("staging", () => {
  it("drops the spent stage and keeps delivering Δv from the next", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;

    // Stage 1 alone provides ~3.23 km/s; ask for 5 km/s to force a stage drop.
    sendBurn(sim, id, 5000, "prograde");
    flyUntilCoast(sim, id);

    expect(ship.activeStage).toBe(1); // advanced into the second stage
    // Engine Δv delivered should be close to the requested 5 km/s (stack has ~7.9).
    // After coast the burn record is cleared, so verify via remaining propellant:
    expect(ship.stages[0]!.propMass).toBeLessThan(1); // first tank emptied
    expect(ship.stages[1]!.propMass).toBeGreaterThan(0); // second still has fuel
  });
});
