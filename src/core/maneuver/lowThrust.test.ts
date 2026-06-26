import { describe, it, expect } from "vitest";
import { edelbaumDv, edelbaumTransfer } from "./lowThrust.ts";
import {
  availablePowerW, thrustAt, electricThrust, exhaustVelocity,
  type Stage, type ElectricSource,
} from "../propulsion.ts";
import { BODY_BY_ID, AU, DAY } from "../constants.ts";

const EARTH = BODY_BY_ID.get("earth")!;
const GEO = 42164e3;
const LEO = EARTH.radius + 400e3;

// A Dawn-class solar-electric stage: NSTAR at ~2.3 kW, Isp 3100 s → ~92 mN @ 1 AU.
const dawnSrc: ElectricSource = { powerW: 2330, eta: 0.6, solar: true };
const dawn: Stage = { name: "NSTAR", dryMass: 800, propMass: 425, isp: 3100, thrust: 0.092, electric: dawnSrc };

describe("electric power model", () => {
  it("solar power falls as 1/r² beyond 1 AU and caps at the rated value within", () => {
    expect(availablePowerW(dawnSrc, AU)).toBeCloseTo(2330, 6);
    expect(availablePowerW(dawnSrc, 2 * AU)).toBeCloseTo(2330 / 4, 3);
    expect(availablePowerW(dawnSrc, 0.5 * AU)).toBeCloseTo(2330, 6); // regulated, not 4×
    expect(availablePowerW({ ...dawnSrc, solar: false }, 3 * AU)).toBe(2330); // reactor constant
  });
  it("the rated thrust is consistent with the rated power, and derates with distance", () => {
    const ve = exhaustVelocity(dawn.isp);
    expect(electricThrust(2330, ve, 0.6)).toBeCloseTo(0.092, 3); // 2ηP/ve ≈ rated thrust
    expect(thrustAt(dawn, AU)).toBeCloseTo(0.092, 3);
    expect(thrustAt(dawn, 3 * AU)).toBeCloseTo(0.092 / 9, 3); // at Ceres, ~1/9 the thrust
  });
  it("a chemical stage's thrust is distance-independent", () => {
    const chem: Stage = { name: "chem", dryMass: 1000, propMass: 5000, isp: 320, thrust: 5e5 };
    expect(thrustAt(chem, AU)).toBe(5e5);
    expect(thrustAt(chem, 30 * AU)).toBe(5e5);
  });
});

describe("Edelbaum low-thrust transfer", () => {
  it("coplanar LEO→GEO is the famous ~4.6 km/s spiral (more than impulsive Hohmann)", () => {
    const dv = edelbaumDv(EARTH.mu, LEO, GEO, 0);
    expect(dv / 1000).toBeGreaterThan(4.4);
    expect(dv / 1000).toBeLessThan(4.8);
  });
  it("a plane change makes the spiral cost more", () => {
    const flat = edelbaumDv(EARTH.mu, LEO, GEO, 0);
    const tilted = edelbaumDv(EARTH.mu, LEO, GEO, (28.5 * Math.PI) / 180);
    expect(tilted).toBeGreaterThan(flat);
  });
  it("reduces to |v0 − v1| when coplanar", () => {
    const v0 = Math.sqrt(EARTH.mu / LEO), v1 = Math.sqrt(EARTH.mu / GEO);
    expect(edelbaumDv(EARTH.mu, LEO, GEO, 0)).toBeCloseTo(Math.abs(v0 - v1), 3);
  });
  it("the transfer takes months on milli-newton thrust, spending little propellant", () => {
    const ve = exhaustVelocity(1640); // SMART-1 Hall, Isp 1640
    const t = edelbaumTransfer(EARTH.mu, LEO, GEO, 0, 0.068, ve, 370);
    expect(t.time / DAY).toBeGreaterThan(60); // months, not minutes
    expect(t.time / DAY).toBeLessThan(800);
    expect(t.propellant).toBeLessThan(120); // tens of kg of xenon, not tonnes
    expect(t.dv).toBeCloseTo(edelbaumDv(EARTH.mu, LEO, GEO, 0), 6);
  });
});
