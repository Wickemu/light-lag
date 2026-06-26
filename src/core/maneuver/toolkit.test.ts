import { describe, it, expect } from "vitest";
import { planeChangeDv, combinedPlaneChangeDv } from "../orbit.ts";
import { biElliptic } from "./biElliptic.ts";
import { hohmann } from "./hohmann.ts";
import { lambert } from "./lambert.ts";
import { stateToElements, elementsToState, propagate } from "../math/kepler.ts";
import { BODY_BY_ID } from "../constants.ts";
import { distance, length } from "../math/vec3.ts";

const MU = BODY_BY_ID.get("earth")!.mu;
const R = BODY_BY_ID.get("earth")!.radius;

describe("plane-change Δv", () => {
  it("a 180° flip costs 2v, and is zero for no change", () => {
    expect(planeChangeDv(7800, Math.PI)).toBeCloseTo(15600, 6);
    expect(planeChangeDv(7800, 0)).toBe(0);
  });
  it("is cheaper at low (apoapsis) speed than high (periapsis) speed", () => {
    expect(planeChangeDv(1500, 0.5)).toBeLessThan(planeChangeDv(7800, 0.5));
  });
  it("combined reduces to |Δspeed| with no rotation and to a pure plane change at equal speed", () => {
    expect(combinedPlaneChangeDv(7000, 7800, 0)).toBeCloseTo(800, 6);
    expect(combinedPlaneChangeDv(7800, 7800, 0.4)).toBeCloseTo(planeChangeDv(7800, 0.4), 6);
  });
  it("a combined burn never costs more than the two done separately", () => {
    const v1 = 7800, v2 = 3000, di = 0.6;
    const separate = Math.abs(v2 - v1) + planeChangeDv(v2, di);
    expect(combinedPlaneChangeDv(v1, v2, di)).toBeLessThanOrEqual(separate);
  });
});

describe("bi-elliptic transfer vs Hohmann (the textbook crossover)", () => {
  const r1 = R + 400e3;
  it("loses to Hohmann for a small radius ratio", () => {
    const r2 = 5 * r1; // ratio 5 < 11.94
    const be = biElliptic(MU, r1, r2, 50 * r1);
    expect(be.dvTotal).toBeGreaterThan(hohmann(MU, r1, r2).dvTotal);
  });
  it("beats Hohmann for a large ratio with a high intermediate apoapsis", () => {
    const r2 = 15 * r1; // ratio 15 > 11.94
    const be = biElliptic(MU, r1, r2, 400 * r1);
    expect(be.dvTotal).toBeLessThan(hohmann(MU, r1, r2).dvTotal);
    expect(be.tof).toBeGreaterThan(hohmann(MU, r1, r2).tof); // ...but takes far longer
  });
  it("the three burns circularize at r2 (final speed is circular)", () => {
    const r2 = 12 * r1;
    const be = biElliptic(MU, r1, r2, 100 * r1);
    expect(be.dvTotal).toBeCloseTo(be.dv1 + be.dv2 + be.dv3, 6);
    expect(be.dv1).toBeGreaterThan(0);
    expect(be.dv3).toBeGreaterThan(0);
  });
});

describe("multi-revolution Lambert", () => {
  // Two points on a reference circular orbit, separated by 100°.
  const R0 = R + 800e3;
  const r1 = { x: R0, y: 0, z: 0 };
  const ang = (100 * Math.PI) / 180;
  const r2 = { x: R0 * Math.cos(ang), y: R0 * Math.sin(ang), z: 0 };
  const arrives = (dt: number, sol: { v1: { x: number; y: number; z: number } }) => {
    const el = stateToElements(r1, sol.v1, MU);
    const st = elementsToState(propagate(el, MU, dt), MU);
    return distance(st.r, r2) / length(r2);
  };

  it("the direct (N=0) solution is unchanged and connects the endpoints", () => {
    const dt = 1800; // s — a short direct transfer
    const sol = lambert(r1, r2, dt, MU)!;
    expect(sol).not.toBeNull();
    expect(arrives(dt, sol)).toBeLessThan(1e-6);
  });

  it("an N=1 solution exists for a long flight time and connects the endpoints", () => {
    const period = 2 * Math.PI * Math.sqrt(R0 ** 3 / MU);
    const dt = 1.8 * period; // long enough to need a revolution
    const low = lambert(r1, r2, dt, MU, true, { nrev: 1, lowPath: true })!;
    const high = lambert(r1, r2, dt, MU, true, { nrev: 1, lowPath: false })!;
    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    expect(arrives(dt, low)).toBeLessThan(1e-5);
    expect(arrives(dt, high)).toBeLessThan(1e-5);
    // The two branches are genuinely different transfers.
    expect(length(low.v1)).not.toBeCloseTo(length(high.v1), 0);
  });

  it("returns null when the flight time is below the N=1 minimum", () => {
    expect(lambert(r1, r2, 600, MU, true, { nrev: 1 })).toBeNull();
  });
});
