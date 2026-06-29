import { describe, it, expect } from "vitest";
import { ballisticCruise, torchTransit, interstellarTransit } from "./interstellar.ts";
import { STAR_BY_ID } from "../stars.ts";
import { C, G0 } from "../constants.ts";

const proxima = STAR_BY_ID.get("proxima")!;
const tauCeti = STAR_BY_ID.get("tau-ceti")!;

describe("torch (constant-proper-accel) transit", () => {
  it("a 1g torch to Proxima: ~3.5 yr crew, ~6 yr Earth, ~0.95c, can't beat light", () => {
    const t = torchTransit({ exhaustVelocity: C, properAccel: G0 }, proxima)!;
    expect(t.properTimeYr).toBeGreaterThan(3.4);
    expect(t.properTimeYr).toBeLessThan(3.7);
    expect(t.coordinateTimeYr).toBeGreaterThan(5.8);
    expect(t.coordinateTimeYr).toBeLessThan(6.1);
    expect(t.cruiseFraction).toBeCloseTo(0.95, 2);
    expect(t.properTimeYr).toBeLessThan(t.coordinateTimeYr);
    expect(t.coordinateTimeYr).toBeGreaterThanOrEqual(t.oneWayLightLagYr); // ≥ light-lag
    expect(t.oneWayLightLagYr).toBeCloseTo(4.2465, 3);
  });
  it("a 1g torch needs a near-c exhaust velocity (huge mass ratio otherwise)", () => {
    const photon = torchTransit({ exhaustVelocity: C, properAccel: G0 }, proxima)!;
    const fusion = torchTransit({ exhaustVelocity: 0.05 * C, properAccel: G0 }, proxima)!;
    expect(photon.massRatio).toBeLessThan(100); // antimatter/photon: feasible-ish
    expect(fusion.massRatio).toBeGreaterThan(1e6); // fusion can't sustain 1g to a star
  });
});

describe("ballistic cruise transit", () => {
  it("a fusion-class cruise to Tau Ceti takes centuries (coordinate time)", () => {
    const c = ballisticCruise({ exhaustVelocity: 0.05 * C, fuelFraction: 0.9 }, tauCeti)!;
    expect(c.cruiseFraction).toBeLessThan(0.2); // deeply sub-relativistic cruise
    expect(c.coordinateTimeYr).toBeGreaterThan(100);
    expect(c.coordinateTimeYr).toBeGreaterThanOrEqual(c.oneWayLightLagYr);
    expect(c.massRatio).toBeCloseTo(10, 5); // 1/(1−0.9)
  });
  it("more propellant ⇒ faster cruise ⇒ shorter coordinate time", () => {
    const lean = ballisticCruise({ exhaustVelocity: 0.05 * C, fuelFraction: 0.7 }, tauCeti)!;
    const fat = ballisticCruise({ exhaustVelocity: 0.05 * C, fuelFraction: 0.95 }, tauCeti)!;
    expect(fat.cruiseVelocity).toBeGreaterThan(lean.cruiseVelocity);
    expect(fat.coordinateTimeYr).toBeLessThan(lean.coordinateTimeYr);
  });
  it("rejects an out-of-range fuel fraction", () => {
    expect(ballisticCruise({ exhaustVelocity: C, fuelFraction: 0 }, proxima)).toBeNull();
    expect(ballisticCruise({ exhaustVelocity: C, fuelFraction: 1 }, proxima)).toBeNull();
  });
});

describe("profile selection", () => {
  it("interstellarTransit picks torch when a proper acceleration is given", () => {
    expect(interstellarTransit({ exhaustVelocity: C, properAccel: G0 }, proxima)!.profile).toBe("torch");
    expect(interstellarTransit({ exhaustVelocity: C, fuelFraction: 0.9 }, proxima)!.profile).toBe("cruise");
  });
  it("proper time is always ≤ coordinate time, and both ≥ the light-lag floor", () => {
    for (const star of [proxima, tauCeti]) {
      const t = torchTransit({ exhaustVelocity: C, properAccel: G0 }, star)!;
      expect(t.properTimeYr).toBeLessThanOrEqual(t.coordinateTimeYr);
      expect(t.coordinateTimeYr).toBeGreaterThanOrEqual(t.oneWayLightLagYr);
    }
  });
});
