import { describe, it, expect } from "vitest";
import { createWorld } from "./world.ts";
import { Simulation } from "./sim.ts";
import { spawnShip, startBurn, defaultDesign } from "../app/commands.ts";
import { shipOsculatingElements, totalMass } from "./ships.ts";
import { summarizeOrbit } from "./orbit.ts";
import { exhaustVelocity, propellantForDv } from "./propulsion.ts";
import { BODY_BY_ID } from "./constants.ts";

const MU_EARTH = BODY_BY_ID.get("earth")!.mu;
const R_EARTH = BODY_BY_ID.get("earth")!.radius;

/** Run the sim until the (single) ship finishes its burn. */
function flyUntilCoast(sim: Simulation, shipId: string): void {
  const ship = sim.world.ships.get(shipId)!;
  let guard = 0;
  while (ship.mode === "thrust" && guard++ < 200000) sim.step(10);
  if (ship.mode === "thrust") throw new Error("burn never completed");
}

describe("finite-thrust prograde burn", () => {
  it("raises apoapsis, keeps the burn point as periapsis, and spends propellant per Tsiolkovsky", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;

    const before = summarizeOrbit(shipOsculatingElements(ship, 0), MU_EARTH, R_EARTH);
    const m0 = totalMass(ship);
    const propBefore = ship.stages[0]!.propMass;
    const ve = exhaustVelocity(ship.stages[0]!.isp);

    startBurn(sim, id, 1000, "prograde");
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
    startBurn(sim, id, 800, "prograde");
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

    startBurn(sim, id, 50, "prograde");
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
      startBurn(sim, id, 1200, "prograde");
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
      startBurn(sim, id, 1200, "prograde");
      while (sim.world.t < 600) sim.step(chunk);
      return shipOsculatingElements(sim.world.ships.get(id)!, sim.world.t);
    };
    const coarse = run(7); // non-grid-aligned chunk
    const fine = run(0.5);
    expect(Math.abs(coarse.a - fine.a)).toBeLessThan(50); // metres
  });
});

describe("staging", () => {
  it("drops the spent stage and keeps delivering Δv from the next", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;

    // Stage 1 alone provides ~3.23 km/s; ask for 5 km/s to force a stage drop.
    startBurn(sim, id, 5000, "prograde");
    flyUntilCoast(sim, id);

    expect(ship.activeStage).toBe(1); // advanced into the second stage
    // Engine Δv delivered should be close to the requested 5 km/s (stack has ~7.9).
    // After coast the burn record is cleared, so verify via remaining propellant:
    expect(ship.stages[0]!.propMass).toBeLessThan(1); // first tank emptied
    expect(ship.stages[1]!.propMass).toBeGreaterThan(0); // second still has fuel
  });
});
