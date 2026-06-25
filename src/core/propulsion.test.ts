import { describe, it, expect } from "vitest";
import {
  exhaustVelocity,
  tsiolkovsky,
  propellantForDv,
  dvForPropellant,
  deltaVBudget,
  initialTWR,
  electricThrust,
  type Stage,
} from "./propulsion.ts";
import { G0 } from "./constants.ts";

describe("the rocket equation", () => {
  it("exhaust velocity is Isp·g0", () => {
    expect(exhaustVelocity(300)).toBeCloseTo(300 * G0, 6);
  });

  it("tsiolkovsky: a mass ratio of e gives one exhaust velocity of Δv", () => {
    const ve = 3000;
    expect(tsiolkovsky(ve, Math.E, 1)).toBeCloseTo(ve, 6);
    expect(tsiolkovsky(ve, 2, 1)).toBeCloseTo(ve * Math.LN2, 6);
  });

  it("propellantForDv and dvForPropellant are inverses", () => {
    const ve = 3500, m0 = 50000, dv = 2200;
    const mp = propellantForDv(ve, m0, dv);
    expect(dvForPropellant(ve, m0, mp)).toBeCloseTo(dv, 6);
  });

  it("propellant for a given Δv matches m0·(1 − e^(−Δv/ve))", () => {
    const ve = 3000, m0 = 1000, dv = 1500;
    expect(propellantForDv(ve, m0, dv)).toBeCloseTo(m0 * (1 - Math.exp(-dv / ve)), 6);
  });
});

describe("staging", () => {
  const stages: Stage[] = [
    { name: "1", dryMass: 5000, propMass: 50000, isp: 300, thrust: 1.2e6 },
    { name: "2", dryMass: 2000, propMass: 15000, isp: 340, thrust: 2.0e5 },
  ];
  const payload = 3000;

  it("sums Δv across stages with correct drop masses", () => {
    const b = deltaVBudget(stages, payload);
    const ve1 = exhaustVelocity(300), ve2 = exhaustVelocity(340);
    // Stage 1 lifts everything (75 t -> 25 t).
    const dv1 = ve1 * Math.log(75000 / 25000);
    // Stage 1 dry dropped (-5 t): stage 2 lifts 20 t -> 5 t.
    const dv2 = ve2 * Math.log(20000 / 5000);
    expect(b.perStage[0]).toBeCloseTo(dv1, 3);
    expect(b.perStage[1]).toBeCloseTo(dv2, 3);
    expect(b.total).toBeCloseTo(dv1 + dv2, 3);
    expect(b.wetMass).toBeCloseTo(75000, 6);
    expect(b.finalMass).toBeCloseTo(payload, 6);
  });

  it("initial T/W uses the first stage against full wet mass", () => {
    expect(initialTWR(stages, payload)).toBeCloseTo(1.2e6 / (75000 * G0), 6);
  });
});

describe("electric propulsion", () => {
  it("thrust follows F = 2·η·P / ve (jet power = ½F·ve)", () => {
    const power = 100e3, ve = 30000, eta = 0.6;
    const F = electricThrust(power, ve, eta);
    expect(F).toBeCloseTo((2 * eta * power) / ve, 9);
    // Consistency: jet power ½F·ve should be η·P.
    expect(0.5 * F * ve).toBeCloseTo(eta * power, 6);
  });
});
