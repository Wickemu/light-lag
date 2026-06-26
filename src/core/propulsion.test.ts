import { describe, it, expect } from "vitest";
import {
  exhaustVelocity,
  tsiolkovsky,
  propellantForDv,
  dvForPropellant,
  deltaVBudget,
  initialTWR,
  electricThrust,
  jetPower,
  exhaustForThrust,
  variableIspBurn,
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

describe("variable specific impulse (constant power)", () => {
  const power = 200e3, eta = 0.6;

  it("jetPower is η·P and underwrites the F·vₑ = 2·jetPower identity", () => {
    expect(jetPower(power, eta)).toBeCloseTo(eta * power, 6);
    const ve = 40000;
    const F = electricThrust(power, ve, eta);
    expect(F * ve).toBeCloseTo(2 * jetPower(power, eta), 3);
  });

  it("exhaustForThrust inverts electricThrust", () => {
    const ve = 50000;
    const F = electricThrust(power, ve, eta);
    expect(exhaustForThrust(power, eta, F)).toBeCloseTo(ve, 3);
  });

  it("at fixed power, dialling Isp UP cuts thrust and propellant but lengthens the burn", () => {
    const m0 = 5000, dv = 3000;
    const lo = variableIspBurn(power, eta, 20000, m0, dv); // low Isp
    const hi = variableIspBurn(power, eta, 40000, m0, dv); // 2× Isp

    // F = 2ηP/vₑ: doubling vₑ halves thrust.
    expect(hi.thrust).toBeCloseTo(lo.thrust / 2, 6);
    // Less mass thrown at higher exhaust speed.
    expect(hi.propellant).toBeLessThan(lo.propellant);
    // …but the gentler thrust makes the burn longer (time ∝ vₑ).
    expect(hi.time).toBeGreaterThan(lo.time);
    expect(hi.isp).toBeCloseTo(40000 / G0, 6);
  });

  it("the burn is self-consistent: F=2ηP/vₑ, ṁ=F/vₑ, time=prop/ṁ, Δv from Tsiolkovsky", () => {
    const m0 = 5000, dv = 2500, ve = 30000;
    const b = variableIspBurn(power, eta, ve, m0, dv);
    expect(b.thrust).toBeCloseTo((2 * eta * power) / ve, 6);
    expect(b.mdot).toBeCloseTo(b.thrust / ve, 9);
    expect(b.time).toBeCloseTo(b.propellant / b.mdot, 3);
    // Δv recovered: vₑ·ln(m0/(m0−prop)) = dv.
    expect(ve * Math.log(m0 / (m0 - b.propellant))).toBeCloseTo(dv, 6);
  });
});
