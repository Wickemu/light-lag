import { describe, it, expect } from "vitest";
import {
  rapidity, velocityFromRapidity, lorentzFactor,
  relativisticMassRatio, relativisticBurnVelocity, relAccelLeg, brachistochrone,
  tsiolkovsky, dvForPropellant, exhaustVelocity,
} from "./propulsion.ts";
import { C, G0, JULIAN_YEAR } from "./constants.ts";

describe("relativistic forms reduce to the classical ones at low speed", () => {
  // The critical invariant: physics is consistent across the regimes.
  it("mass ratio matches Tsiolkovsky for a slow chemical burn (to ~1e-9)", () => {
    const ve = exhaustVelocity(340); // ~3334 m/s
    const dv = 5000; // m/s — well below c
    const relRatio = relativisticMassRatio(ve, rapidity(velocityFromRapidity(dv))); // Δφ for a Δv≈dv
    // Classical mass ratio from Tsiolkovsky inverted: m0/mf = e^(dv/ve).
    const classical = Math.exp(dv / ve);
    // rapidity(velocityFromRapidity(dv)) === dv exactly (inverse pair), so this is
    // the cleanest statement: relativisticMassRatio(ve, dv) == e^(dv/ve).
    expect(relativisticMassRatio(ve, dv)).toBeCloseTo(classical, 6);
    expect(relRatio).toBeCloseTo(classical, 6);
  });
  it("burn velocity matches dvForPropellant at low mass ratio (to ~1e-9 relative)", () => {
    const ve = exhaustVelocity(450); // ~4413 m/s
    const m0 = 10, mf = 4;
    const classical = dvForPropellant(ve, m0, m0 - mf); // = ve·ln(m0/mf)
    const rel = relativisticBurnVelocity(ve, m0, mf);
    expect(Math.abs(rel - classical) / classical).toBeLessThan(1e-9);
    // And it is consistent with Tsiolkovsky's own Δv.
    expect(classical).toBeCloseTo(tsiolkovsky(ve, m0, mf), 6);
  });
});

describe("relativistic limits and identities", () => {
  it("rapidity and velocity are inverse, and γ(0.866c) ≈ 2", () => {
    for (const beta of [0.1, 0.5, 0.9, 0.99]) {
      const v = beta * C;
      expect(velocityFromRapidity(rapidity(v))).toBeCloseTo(v, 3);
    }
    expect(lorentzFactor(0.8660254 * C)).toBeCloseTo(2, 4);
  });
  it("burn velocity never reaches c and approaches it only as ve→c, ratio→∞", () => {
    // A huge chemical mass ratio is still deeply sub-relativistic.
    expect(relativisticBurnVelocity(4400, 1e6, 1) / C).toBeLessThan(0.01);
    // A photon rocket (ve = c) with mass ratio 100 gets most of the way to c.
    const vPhoton = relativisticBurnVelocity(C, 100, 1);
    expect(vPhoton).toBeLessThan(C);
    expect(vPhoton / C).toBeGreaterThan(0.99);
  });
});

describe("constant-proper-acceleration trajectories (the torchship)", () => {
  it("1g flip-and-burn to Proxima matches the textbook numbers", () => {
    const proximaLy = 4.2465;
    const d = proximaLy * C * JULIAN_YEAR;
    const b = brachistochrone(G0, d);
    // Textbook "1g to Alpha Centauri": ~3.5 yr ship time, ~5.9 yr Earth time, ~0.95c.
    expect(b.properTime / JULIAN_YEAR).toBeGreaterThan(3.4);
    expect(b.properTime / JULIAN_YEAR).toBeLessThan(3.7);
    expect(b.coordinateTime / JULIAN_YEAR).toBeGreaterThan(5.8);
    expect(b.coordinateTime / JULIAN_YEAR).toBeLessThan(6.1);
    expect(b.peakVelocity / C).toBeCloseTo(0.95, 2);
    // Proper time is always less than coordinate time (the twin "paradox").
    expect(b.properTime).toBeLessThan(b.coordinateTime);
    // And you can never beat light: coordinate time exceeds the light crossing.
    expect(b.coordinateTime).toBeGreaterThan(d / C);
  });
  it("1g across the galaxy ages the crew decades while millennia pass outside", () => {
    const d = 1e5 * C * JULIAN_YEAR; // 100,000 ly
    const b = brachistochrone(G0, d);
    expect(b.properTime / JULIAN_YEAR).toBeLessThan(50); // crew ages tens of years
    expect(b.coordinateTime / JULIAN_YEAR).toBeGreaterThan(1e5); // ≥ light crossing
    expect(b.peakLorentz).toBeGreaterThan(1000);
  });
  it("a single leg's energy and time grow monotonically with distance", () => {
    const near = relAccelLeg(G0, 1e15);
    const far = relAccelLeg(G0, 1e17);
    expect(far.v).toBeGreaterThan(near.v);
    expect(far.gamma).toBeGreaterThan(near.gamma);
    expect(far.t).toBeGreaterThan(near.t);
  });
});
