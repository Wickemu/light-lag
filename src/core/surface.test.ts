import { describe, it, expect } from "vitest";
import { BODY_BY_ID } from "./constants.ts";
import {
  surfaceGravity, escapeVelocity, rotationSpeed, atmosphericDensity,
  ascentBudget, descentBudget, surfaceManeuverCost,
  type AscentParams,
} from "./surface.ts";
import { exhaustVelocity, propellantForDv, type Stage } from "./propulsion.ts";

const body = (id: string) => BODY_BY_ID.get(id)!;
const KM = 1000;

describe("derived surface quantities", () => {
  it("Earth surface gravity ≈ 9.8 m/s² and escape velocity ≈ 11.2 km/s", () => {
    expect(surfaceGravity(body("earth"))).toBeCloseTo(9.8, 1);
    expect(escapeVelocity(body("earth")) / KM).toBeCloseTo(11.2, 1);
  });
  it("Moon surface gravity ≈ 1.62 m/s², escape ≈ 2.38 km/s", () => {
    expect(surfaceGravity(body("moon"))).toBeCloseTo(1.62, 1);
    expect(escapeVelocity(body("moon")) / KM).toBeCloseTo(2.38, 1);
  });
  it("Earth's equatorial rotation speed ≈ 465 m/s; the Moon's is tiny", () => {
    expect(rotationSpeed(body("earth"))).toBeCloseTo(465, -1);
    expect(rotationSpeed(body("mars"))).toBeCloseTo(241, -1);
    expect(rotationSpeed(body("moon"))).toBeLessThan(10);
  });
  it("atmospheric density falls off exponentially and is 0 when airless", () => {
    const earth = body("earth");
    expect(atmosphericDensity(earth, 0)).toBeCloseTo(1.225, 2);
    // One scale height (8500 m) down by a factor of e.
    expect(atmosphericDensity(earth, 8500) / 1.225).toBeCloseTo(1 / Math.E, 2);
    expect(atmosphericDensity(body("moon"), 0)).toBe(0);
  });
});

describe("ascent Δv reproduces real launch budgets", () => {
  // The honesty anchors: integrated gravity-turn budgets vs the published reality.
  it("Earth → 200 km LEO is ~9.0–9.6 km/s (real ~9.3–9.5)", () => {
    const a = ascentBudget(body("earth"), { parkingAlt: 200 * KM, twr: 1.4 })!;
    expect(a.dvTotal / KM).toBeGreaterThan(9.0);
    expect(a.dvTotal / KM).toBeLessThan(9.6);
    expect(a.converged).toBe(true);
    // The breakdown is physical: gravity loss dominates, drag is the minor term.
    expect(a.gravityLoss).toBeGreaterThan(a.dragLoss);
    expect(a.gravityLoss / KM).toBeGreaterThan(1.0);
  });
  it("Moon ascent → 100 km is ~1.7–2.1 km/s (real ~1.87), drag-free", () => {
    const a = ascentBudget(body("moon"), { parkingAlt: 100 * KM, twr: 2.0 })!;
    expect(a.dvTotal / KM).toBeGreaterThan(1.7);
    expect(a.dvTotal / KM).toBeLessThan(2.1);
    expect(a.dragLoss).toBe(0); // airless ⇒ exactly zero drag
  });
  it("Mars ascent → 200 km is ~3.7–4.4 km/s (real ~4.1)", () => {
    const a = ascentBudget(body("mars"), { parkingAlt: 200 * KM, twr: 1.6 })!;
    expect(a.dvTotal / KM).toBeGreaterThan(3.7);
    expect(a.dvTotal / KM).toBeLessThan(4.4);
  });
  it("Venus is drag-stalled (impractical): non-convergent and far worse than Earth", () => {
    const v = ascentBudget(body("venus"), { parkingAlt: 200 * KM, twr: 1.5 })!;
    const e = ascentBudget(body("earth"), { parkingAlt: 200 * KM, twr: 1.5 })!;
    expect(v.converged).toBe(false); // thick lower atmosphere ⇒ no conventional ascent
    expect(v.dvTotal).toBeGreaterThan(e.dvTotal * 2);
  });
  it("returns null where there is no surface (Sun, gas giants)", () => {
    for (const id of ["sun", "jupiter", "saturn", "uranus", "neptune"]) {
      expect(ascentBudget(body(id), { parkingAlt: 100 * KM, twr: 1.5 })).toBeNull();
      expect(descentBudget(body(id), { parkingAlt: 100 * KM, twr: 1.5 })).toBeNull();
    }
  });
});

describe("descent Δv", () => {
  it("airless descent equals ascent without the rotation help", () => {
    // For an airless body descent must thrust away all orbital speed and pay the
    // same gravity losses, but gets no rotation bonus: descent = ascent + rot.
    for (const id of ["moon", "mercury", "ceres"]) {
      const p: AscentParams = { parkingAlt: 100 * KM, twr: 1.8 };
      const a = ascentBudget(body(id), p)!;
      const d = descentBudget(body(id), p)!;
      expect(d.aerobrakeFraction).toBe(0);
      expect(d.dvTotal).toBeCloseTo(a.dvTotal + a.rotationBonus, 0);
    }
  });
  it("atmospheric descent is cheap — aerobraking does the work", () => {
    const earth = descentBudget(body("earth"), { parkingAlt: 200 * KM, twr: 1.5 })!;
    expect(earth.aerobrakeFraction).toBeGreaterThan(0.8);
    expect(earth.dvPowered / KM).toBeLessThan(0.5); // a small terminal burn only
    const mars = descentBudget(body("mars"), { parkingAlt: 200 * KM, twr: 1.5 })!;
    expect(mars.aerobrakeFraction).toBeGreaterThan(0.5);
    expect(mars.dvPowered).toBeLessThan(mars.vOrbit); // most shed for free
  });
});

describe("ascent budget invariants", () => {
  const earth = body("earth");
  it("a higher target orbit costs more Δv", () => {
    const lo = ascentBudget(earth, { parkingAlt: 200 * KM, twr: 1.4 })!;
    const hi = ascentBudget(earth, { parkingAlt: 600 * KM, twr: 1.4 })!;
    expect(hi.dvTotal).toBeGreaterThan(lo.dvTotal);
  });
  it("a higher thrust-to-weight cuts the gravity loss", () => {
    const weak = ascentBudget(body("moon"), { parkingAlt: 100 * KM, twr: 1.3 })!;
    const strong = ascentBudget(body("moon"), { parkingAlt: 100 * KM, twr: 4.0 })!;
    expect(strong.gravityLoss).toBeLessThan(weak.gravityLoss);
  });
  it("the rotation bonus never exceeds orbital speed and flips sign retrograde", () => {
    const east = ascentBudget(earth, { parkingAlt: 200 * KM, twr: 1.4 })!;
    const west = ascentBudget(earth, { parkingAlt: 200 * KM, twr: 1.4, retrograde: true })!;
    expect(east.rotationBonus).toBeGreaterThan(0);
    expect(east.rotationBonus).toBeLessThan(east.vOrbit);
    expect(west.rotationBonus).toBeCloseTo(-east.rotationBonus, 5);
    expect(west.dvTotal).toBeGreaterThan(east.dvTotal); // launching west costs more
  });
});

describe("surfaceManeuverCost matches the rocket equation", () => {
  const stages: Stage[] = [
    { name: "S1", dryMass: 5000, propMass: 60000, isp: 300, thrust: 1.2e6 },
    { name: "S2", dryMass: 2000, propMass: 15000, isp: 340, thrust: 2.0e5 },
  ];
  it("a within-one-stage burn spends Tsiolkovsky propellant in a positive time", () => {
    const dv = 1000;
    const m0 = 3000 + stages.reduce((s, st) => s + st.dryMass + st.propMass, 0);
    const ve = exhaustVelocity(stages[0]!.isp);
    const cost = surfaceManeuverCost(stages, 3000, dv);
    expect(cost.propellant).toBeCloseTo(propellantForDv(ve, m0, dv), 0);
    expect(cost.burnTime).toBeGreaterThan(0);
    expect(cost.feasible).toBeGreaterThan(0); // affordable
  });
  it("flags an unaffordable maneuver with negative feasibility", () => {
    const cost = surfaceManeuverCost(stages, 3000, 50000);
    expect(cost.feasible).toBeLessThan(0);
  });
});
