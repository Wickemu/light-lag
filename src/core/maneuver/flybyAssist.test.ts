import { describe, it, expect } from "vitest";
import {
  flybyEccentricity, flybyTurnAngle, maxTurnAngle, flybyOutgoing, poweredFlybyVInfOut,
} from "./flyby.ts";
import { assistTransfer, searchAssist, minFlybyRadius } from "./assist.ts";
import { BODY_BY_ID, JULIAN_YEAR } from "../constants.ts";
import { length, sub } from "../math/vec3.ts";

const JUP = BODY_BY_ID.get("jupiter")!;

describe("flyby physics", () => {
  it("a deeper or slower pass bends more", () => {
    const deep = flybyTurnAngle(6000, JUP.mu, 2 * JUP.radius);
    const shallow = flybyTurnAngle(6000, JUP.mu, 20 * JUP.radius);
    expect(deep).toBeGreaterThan(shallow);
    const slow = flybyTurnAngle(4000, JUP.mu, 2 * JUP.radius);
    const fast = flybyTurnAngle(12000, JUP.mu, 2 * JUP.radius);
    expect(slow).toBeGreaterThan(fast);
    expect(flybyEccentricity(6000, JUP.mu, 2 * JUP.radius)).toBeGreaterThan(1); // hyperbolic
  });

  it("an unpowered flyby preserves |v∞| but rotates it, buying a free heliocentric Δv", () => {
    const vBody = { x: 0, y: 13000, z: 0 }; // ~Jupiter's orbital speed
    const vHelioIn = { x: 6000, y: 13000, z: 0 }; // v∞ = 6 km/s relative to Jupiter
    const out = flybyOutgoing(vBody, vHelioIn, JUP.mu, 2 * JUP.radius, { x: 0, y: 0, z: 1 });
    // |v∞| is preserved across an unpowered pass.
    expect(length(sub(out.vHelioOut, vBody))).toBeCloseTo(length(sub(vHelioIn, vBody)), 3);
    // A deep, slow Jupiter pass bends ~150° and imparts a multi-km/s free assist.
    expect((out.turn * 180) / Math.PI).toBeGreaterThan(120);
    expect(out.assistDv).toBeGreaterThan(8000); // ~11 km/s, for free
  });

  it("a powered (Oberth) periapsis burn raises the outgoing v∞ more than its own size", () => {
    const vInfOut = poweredFlybyVInfOut(6000, JUP.mu, 2 * JUP.radius, 1000);
    expect(vInfOut).toBeGreaterThan(6000 + 1000); // Oberth leverage deep in the well
  });

  it("the max turn is the closest safe pass", () => {
    expect(maxTurnAngle(6000, JUP.mu, minFlybyRadius(JUP)))
      .toBeCloseTo(flybyTurnAngle(6000, JUP.mu, minFlybyRadius(JUP)), 9);
  });
});

describe("gravity-assist trajectory solver", () => {
  it("produces a consistent, safe single-flyby plan (Earth→Jupiter→Saturn)", () => {
    const tDepart = 30 * JULIAN_YEAR; // ~2030
    const r = searchAssist("earth", "jupiter", "saturn", {
      tDepart,
      flybyWindow: [31.5 * JULIAN_YEAR, 34 * JULIAN_YEAR],
      arriveWindow: [36 * JULIAN_YEAR, 42 * JULIAN_YEAR],
      steps: 24,
    });
    expect(r).not.toBeNull();
    const a = r!;
    // Ledger adds up; times ordered; flyby is a safe pass.
    expect(a.dvTotal).toBeCloseTo(a.dvDepart + a.dvFlyby + a.dvArrive, 3);
    expect(a.tFlyby).toBeGreaterThan(a.tDepart);
    expect(a.tArrive).toBeGreaterThan(a.tFlyby);
    expect(a.flybyRadius).toBeGreaterThanOrEqual(minFlybyRadius(JUP) - 1);
    // The excess speeds in and out roughly match (that's what makes it an assist),
    // and the flyby burn is a small fraction of the launch injection.
    expect(Math.abs(a.vInfIn - a.vInfOut) / a.vInfIn).toBeLessThan(0.5);
    expect(a.dvFlyby).toBeLessThan(a.dvDepart);
    expect(a.vInfIn).toBeGreaterThan(0);
  });

  it("rejects degenerate timings", () => {
    expect(assistTransfer("earth", "jupiter", "saturn", 100, 100, 200)).toBeNull(); // tFlyby == tDepart
  });
});
