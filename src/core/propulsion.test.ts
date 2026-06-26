import { describe, it, expect } from "vitest";
import {
  exhaustVelocity,
  tsiolkovsky,
  propellantForDv,
  dvForPropellant,
  deltaVBudget,
  initialTWR,
  stageDeltaV,
  stageLiftoffThrust,
  consumeStageDv,
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

  it("a serial stage with an empty boosters array is identical to no field", () => {
    const plain: Stage = { name: "s", dryMass: 4000, propMass: 40000, isp: 320, thrust: 9e5 };
    const withEmpty: Stage = { ...plain, boosters: [] };
    expect(stageDeltaV(withEmpty, 60000).dv).toBe(stageDeltaV(plain, 60000).dv);
    expect(stageDeltaV(withEmpty, 60000).finalMass).toBe(stageDeltaV(plain, 60000).finalMass);
  });
});

describe("parallel staging (strap-on boosters)", () => {
  it("a core with two identical boosters burns at the engines' vₑ and closes mass", () => {
    // All Isp = 300, so vₑ_eff = vₑ. Equal thrust ⇒ equal mass flow ⇒ in the
    // shared phase the core burns as much propellant as both boosters combined.
    const stage: Stage = {
      name: "core", dryMass: 10000, propMass: 100000, isp: 300, thrust: 1e6,
      boosters: [{ name: "SRB", dryMass: 2000, propMass: 20000, isp: 300, thrust: 5e5, count: 2 }],
    };
    const payload = 5000;
    const b = deltaVBudget([stage], payload);
    const ve = exhaustVelocity(300);
    // Phase 1 (159 t): boosters (40 t) + an equal 40 t of core burn → 79 t, drop
    //   the 4 t of booster structure → 75 t. Phase 2 (core, 60 t left): 75 t → 15 t,
    //   drop 10 t core dry → 5 t = payload.
    const expected = ve * (Math.log(159000 / 79000) + Math.log(75000 / 15000));
    expect(b.wetMass).toBeCloseTo(159000, 6);
    expect(b.total).toBeCloseTo(expected, 3);
    expect(b.finalMass).toBeCloseTo(payload, 6);
  });

  it("count N is exactly N separate identical boosters", () => {
    const payload = 4000;
    const lumped: Stage = {
      name: "core", dryMass: 8000, propMass: 90000, isp: 310, thrust: 1.1e6,
      boosters: [{ name: "B", dryMass: 1500, propMass: 18000, isp: 280, thrust: 6e5, count: 3 }],
    };
    const unit = { name: "B", dryMass: 1500, propMass: 18000, isp: 280, thrust: 6e5 };
    const expanded: Stage = { ...lumped, boosters: [{ ...unit }, { ...unit }, { ...unit }] };
    expect(deltaVBudget([lumped], payload).total).toBeCloseTo(deltaVBudget([expanded], payload).total, 6);
    expect(stageLiftoffThrust(lumped)).toBeCloseTo(stageLiftoffThrust(expanded), 6);
  });

  it("a core + an identical booster equals one stage of doubled engine and tanks", () => {
    // Identical reservoirs emptying together at vₑ_eff = vₑ are indistinguishable
    // from a single engine of twice the thrust burning twice the propellant.
    const payload = 6000;
    const boostered: Stage = {
      name: "core", dryMass: 5000, propMass: 60000, isp: 330, thrust: 8e5,
      boosters: [{ name: "twin", dryMass: 5000, propMass: 60000, isp: 330, thrust: 8e5 }],
    };
    const combined: Stage = { name: "combined", dryMass: 10000, propMass: 120000, isp: 330, thrust: 1.6e6 };
    expect(deltaVBudget([boostered], payload).total).toBeCloseTo(deltaVBudget([combined], payload).total, 9);
  });

  it("boosters of a different Isp blend by thrust (vₑ_eff = F/ṁ), not by Isp average", () => {
    // High-thrust low-Isp booster + high-Isp core. The shared-phase vₑ_eff is the
    // thrust-weighted harmonic blend; verify the first phase value directly.
    const stage: Stage = {
      name: "core", dryMass: 10000, propMass: 100000, isp: 400, thrust: 1e6,
      boosters: [{ name: "solid", dryMass: 3000, propMass: 30000, isp: 250, thrust: 1e6 }],
    };
    const veC = exhaustVelocity(400), veB = exhaustVelocity(250);
    const mdotC = 1e6 / veC, mdotB = 1e6 / veB;
    const veEffPhase1 = 2e6 / (mdotC + mdotB); // F_total / ṁ_total
    // Booster empties first (less propellant per unit thrust). During the shared
    // phase the core burns mdotC·tMin with tMin = 30000/mdotB.
    const tMin = 30000 / mdotB;
    const coreBurned1 = mdotC * tMin;
    const m0 = 5000 + 143000; // payload + core(110t) + booster(33t)
    const mBurnEnd1 = m0 - (30000 + coreBurned1);
    const dv1 = veEffPhase1 * Math.log(m0 / mBurnEnd1);
    const mPhase2 = mBurnEnd1 - 3000; // drop booster dry
    const coreLeft = 100000 - coreBurned1;
    const dv2 = veC * Math.log(mPhase2 / (mPhase2 - coreLeft));
    const b = deltaVBudget([stage], 5000);
    expect(b.total).toBeCloseTo(dv1 + dv2, 3);
    expect(b.finalMass).toBeCloseTo(5000, 6);
  });

  it("a booster that outlasts the core keeps pushing the dead core, mass still closes", () => {
    // Core burns out first; the longer-lived booster pushes the still-attached
    // (dead, thrustless) core until it too empties, then both dry masses drop.
    const stage: Stage = {
      name: "core", dryMass: 4000, propMass: 20000, isp: 300, thrust: 1e6,
      boosters: [{ name: "long", dryMass: 6000, propMass: 120000, isp: 300, thrust: 8e5 }],
    };
    const payload = 3000;
    const b = deltaVBudget([stage], payload);
    // Same engines as a "core-only" stack would deliver less Δv — the booster adds to it.
    const coreOnly = deltaVBudget([{ name: "c", dryMass: 4000, propMass: 20000, isp: 300, thrust: 1e6 }], payload);
    expect(b.total).toBeGreaterThan(coreOnly.total);
    expect(b.finalMass).toBeCloseTo(payload, 6);
    expect(Number.isFinite(b.total)).toBe(true);
  });
});

describe("impulsive stage consumption (consumeStageDv)", () => {
  const clone = (s: Stage): Stage => ({ ...s, boosters: s.boosters?.map((b) => ({ ...b })) });
  const boostered = (): Stage => ({
    name: "core", dryMass: 10000, propMass: 100000, isp: 400, thrust: 1e6,
    boosters: [{ name: "solid", dryMass: 3000, propMass: 30000, isp: 250, thrust: 1e6 }],
  });
  const m0 = 5000 + 143000; // payload + core(110t) + booster(33t)

  it("spending a big target empties the whole boostered stage and matches stageDeltaV", () => {
    const s = boostered();
    const full = stageDeltaV(boostered(), m0).dv;
    const r = consumeStageDv(s, m0, 1e9);
    expect(r.dvDelivered).toBeCloseTo(full, 6);
    expect(s.propMass).toBeLessThan(1);
    for (const b of s.boosters!) expect(b.propMass * (b.count ?? 1)).toBeLessThan(1);
  });

  it("Δv is the conserved currency: deliver part, remaining capacity is full − part", () => {
    const full = stageDeltaV(boostered(), m0).dv;
    const s = clone(boostered());
    const want = full * 0.4;
    const r = consumeStageDv(s, m0, want);
    expect(r.dvDelivered).toBeCloseTo(want, 6);
    // Re-budget the drained stage from its reduced mass: it must still be able to
    // deliver exactly the rest, with no Δv lost or fabricated.
    expect(stageDeltaV(s, r.finalMass).dv).toBeCloseTo(full - want, 3);
  });

  it("a serial stage matches the closed-form rocket equation (legacy behaviour)", () => {
    const s: Stage = { name: "S", dryMass: 4000, propMass: 40000, isp: 320, thrust: 9e5 };
    const ve = exhaustVelocity(320);
    const want = 1500;
    const r = consumeStageDv(s, 80000, want);
    expect(r.dvDelivered).toBeCloseTo(want, 9);
    expect(40000 - s.propMass).toBeCloseTo(80000 * (1 - Math.exp(-want / ve)), 6);
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
