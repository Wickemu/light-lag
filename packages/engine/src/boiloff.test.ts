import { describe, it, expect } from "vitest";
import { type Ship } from "./world.ts";
import { type Stage } from "./propulsion.ts";
import { AU } from "./constants.ts";
import {
  BOILOFF_WINDOW, stageBoiloffRate, shipHasBoiloff, applyBoiloff, shipBoiloffStatus,
} from "./boiloff.ts";

/** A coasting ship about `primary` carrying the given stages. */
function ship(stages: Stage[], primary = "earth"): Ship {
  return {
    id: "s", name: "s", primary, mode: "coast",
    elements: { a: 7.0e6, e: 0.001, i: 0.1, Omega: 0, omega: 0, M: 0 },
    epoch: 0, payloadMass: 1000, stages, activeStage: 0, tau: 0,
  };
}

const cryo = (propMass = 10_000, boiloff = 0.02): Stage =>
  ({ name: "cryo", dryMass: 2000, propMass, isp: 450, thrust: 1e5, propCapacity: propMass, boiloff });
const storable = (propMass = 10_000): Stage =>
  ({ name: "storable", dryMass: 2000, propMass, isp: 320, thrust: 1e5, propCapacity: propMass });

describe("boiloff — rate formula", () => {
  it("is zero for a non-cryogenic stage or a non-positive distance", () => {
    expect(stageBoiloffRate(storable(), AU)).toBe(0);
    expect(stageBoiloffRate(cryo(), 0)).toBe(0);
  });

  it("equals the per-day fraction ÷ 86400 at exactly 1 AU", () => {
    expect(stageBoiloffRate(cryo(10_000, 0.02), AU)).toBeCloseTo(0.02 / 86400, 15);
  });

  it("scales as (AU/r)² with distance — faster near the Sun, slower far out", () => {
    const near = stageBoiloffRate(cryo(), 0.5 * AU); // inside 1 AU ⇒ 4× the 1-AU rate
    const at1 = stageBoiloffRate(cryo(), AU);
    const far = stageBoiloffRate(cryo(), 5 * AU); // ⇒ 1/25 the 1-AU rate
    expect(near / at1).toBeCloseTo(4, 6);
    expect(far / at1).toBeCloseTo(1 / 25, 6);
  });
});

describe("boiloff — shipHasBoiloff", () => {
  it("is true only when a core stage carries a boil-off rate", () => {
    expect(shipHasBoiloff(ship([cryo()]))).toBe(true);
    expect(shipHasBoiloff(ship([storable()]))).toBe(false);
    expect(shipHasBoiloff(ship([storable(), cryo()]))).toBe(true);
  });
});

describe("boiloff — applyBoiloff", () => {
  it("multiplies a cryo stage's propellant by exp(−λ·dt) and returns the kg lost", () => {
    const s = ship([cryo(10_000, 0.02)]);
    const lambda = 0.02 / 86400; // at 1 AU
    const lost = applyBoiloff(s, AU, BOILOFF_WINDOW);
    const expectedKept = 10_000 * Math.exp(-lambda * BOILOFF_WINDOW);
    expect(s.stages[0]!.propMass).toBeCloseTo(expectedKept, 6);
    expect(lost).toBeCloseTo(10_000 - expectedKept, 6);
    expect(lost).toBeGreaterThan(0);
  });

  it("leaves a storable/non-cryo stage completely untouched", () => {
    const s = ship([storable(10_000)]);
    expect(applyBoiloff(s, AU, BOILOFF_WINDOW)).toBe(0);
    expect(s.stages[0]!.propMass).toBe(10_000);
  });

  it("only touches the cryo stage in a mixed stack", () => {
    const s = ship([storable(8_000), cryo(10_000)]);
    applyBoiloff(s, AU, BOILOFF_WINDOW);
    expect(s.stages[0]!.propMass).toBe(8_000); // storable unchanged
    expect(s.stages[1]!.propMass).toBeLessThan(10_000); // cryo boiled
  });

  it("never drives propellant below zero (exponential decay)", () => {
    const s = ship([cryo(10_000, 0.5)]);
    for (let i = 0; i < 1000; i++) applyBoiloff(s, AU, BOILOFF_WINDOW);
    expect(s.stages[0]!.propMass).toBeGreaterThan(0);
    expect(s.stages[0]!.propMass).toBeLessThan(1); // asymptotes toward empty
  });
});

describe("boiloff — shipBoiloffStatus", () => {
  it("returns null for a non-cryo ship and never mutates", () => {
    const s = ship([storable()]);
    expect(shipBoiloffStatus(s, AU)).toBeNull();
    expect(s.stages[0]!.propMass).toBe(10_000);
  });

  it("reports the summed instantaneous rate and cryo propellant aboard, without mutating", () => {
    const s = ship([cryo(10_000, 0.02)]);
    const before = s.stages[0]!.propMass;
    const st = shipBoiloffStatus(s, AU)!;
    expect(st.cryoPropKg).toBe(10_000);
    expect(st.ratePerSec).toBeCloseTo((0.02 / 86400) * 10_000, 9);
    expect(st.ratePerDay).toBeCloseTo(st.ratePerSec * 86400, 6);
    expect(s.stages[0]!.propMass).toBe(before); // pure read
  });
});
