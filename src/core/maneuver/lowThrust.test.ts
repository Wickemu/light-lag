import { describe, it, expect } from "vitest";
import {
  edelbaumDv, edelbaumTransfer,
  spiralEscapeDv, spiralCaptureDv, spiralEscapeTransfer, spiralCaptureTransfer,
} from "./lowThrust.ts";
import {
  availablePowerW, thrustAt, electricThrust, exhaustVelocity,
  type Stage, type ElectricSource,
} from "../propulsion.ts";
import { circularSpeed } from "../orbit.ts";
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

describe("capture / escape spirals about a body", () => {
  it("a low-thrust escape costs the FULL local circular speed (more than impulsive)", () => {
    const vCirc = circularSpeed(EARTH.mu, LEO);
    expect(spiralEscapeDv(EARTH.mu, LEO)).toBeCloseTo(vCirc, 6);
    // Impulsive escape from a circular orbit is only (√2 − 1)·v_circ.
    const impulsive = (Math.SQRT2 - 1) * vCirc;
    expect(spiralEscapeDv(EARTH.mu, LEO)).toBeGreaterThan(impulsive);
    expect(spiralEscapeDv(EARTH.mu, LEO) / 1000).toBeGreaterThan(7.5); // ~7.7 km/s off LEO
  });

  it("capture and escape are the Edelbaum r→∞ limit and mirror each other", () => {
    // Escape from r0 = the spiral r0→∞ Δv; capture to r1 = the ∞→r1 Δv; both v_circ.
    expect(spiralEscapeDv(EARTH.mu, GEO)).toBeCloseTo(edelbaumDv(EARTH.mu, GEO, Infinity, 0), 6);
    expect(spiralCaptureDv(EARTH.mu, LEO)).toBeCloseTo(edelbaumDv(EARTH.mu, Infinity, LEO, 0), 6);
    expect(spiralCaptureDv(EARTH.mu, LEO)).toBeCloseTo(spiralEscapeDv(EARTH.mu, LEO), 6);
  });

  it("an escape spiral leg charges v_circ of Δv and burns propellant over a finite time", () => {
    const ve = exhaustVelocity(3100); // NSTAR-class
    const leg = spiralEscapeTransfer(EARTH.mu, LEO, 0.09, ve, 1200);
    expect(leg.dv).toBeCloseTo(circularSpeed(EARTH.mu, LEO), 6);
    expect(leg.v0).toBeCloseTo(circularSpeed(EARTH.mu, LEO), 6);
    expect(leg.v1).toBe(0); // escaped: zero circular speed at infinity
    expect(leg.propellant).toBeGreaterThan(0);
    expect(isFinite(leg.time)).toBe(true);
    expect(leg.feasible).toBe(true);
  });

  it("a capture spiral mirrors it: zero start speed, settles on the parking orbit", () => {
    const ve = exhaustVelocity(3100);
    const leg = spiralCaptureTransfer(EARTH.mu, GEO, 0.09, ve, 1200);
    expect(leg.dv).toBeCloseTo(circularSpeed(EARTH.mu, GEO), 6);
    expect(leg.v0).toBe(0);
    expect(leg.v1).toBeCloseTo(circularSpeed(EARTH.mu, GEO), 6);
    expect(leg.propellant).toBeGreaterThan(0);
  });

  it("an escape spiral is infeasible when the stack lacks the Δv", () => {
    const ve = exhaustVelocity(3100);
    const leg = spiralEscapeTransfer(EARTH.mu, LEO, 0.09, ve, 1200, 1000); // only 1 km/s available
    expect(leg.feasible).toBe(false);
  });
});
