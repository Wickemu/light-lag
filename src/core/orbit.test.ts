import { describe, it, expect } from "vitest";
import {
  visVivaSpeed,
  circularSpeed,
  apoapsisRadius,
  periapsisRadius,
  orbitalPeriod,
  circularOrbit,
  orbitFrame,
  summarizeOrbit,
  hyperbolicBurnDv,
} from "./orbit.ts";
import { elementsToState, period } from "./math/kepler.ts";
import { dot, length } from "./math/vec3.ts";
import { BODY_BY_ID } from "./constants.ts";

const MU_EARTH = BODY_BY_ID.get("earth")!.mu;
const R_EARTH = BODY_BY_ID.get("earth")!.radius;

describe("speeds and energies", () => {
  it("vis-viva reduces to circular speed when r = a", () => {
    const r = R_EARTH + 4e5;
    expect(visVivaSpeed(MU_EARTH, r, r)).toBeCloseTo(circularSpeed(MU_EARTH, r), 6);
  });

  it("LEO circular speed is ~7.67 km/s at 400 km", () => {
    const v = circularSpeed(MU_EARTH, R_EARTH + 4e5);
    expect(v).toBeGreaterThan(7600);
    expect(v).toBeLessThan(7700);
  });

  it("apoapsis and periapsis radii bracket the semi-major axis", () => {
    const a = 1e7, e = 0.2;
    expect(apoapsisRadius(a, e)).toBeCloseTo(1.2e7, 6);
    expect(periapsisRadius(a, e)).toBeCloseTo(0.8e7, 6);
  });

  it("orbitalPeriod agrees with kepler.period", () => {
    expect(orbitalPeriod(1e7, MU_EARTH)).toBeCloseTo(period(1e7, MU_EARTH), 6);
  });
});

describe("the maneuver frame", () => {
  it("prograde is along v, radial along r, normal along r×v; all orthonormal on a circular orbit", () => {
    const el = circularOrbit(R_EARTH + 4e5, 0.5, 0.3, 1.0);
    const s = elementsToState(el, MU_EARTH);
    const f = orbitFrame(s.r, s.v);
    expect(length(f.prograde)).toBeCloseTo(1, 9);
    expect(length(f.normal)).toBeCloseTo(1, 9);
    // Circular orbit: velocity is perpendicular to radius.
    expect(Math.abs(dot(f.prograde, f.radialOut))).toBeLessThan(1e-9);
    expect(Math.abs(dot(f.normal, f.prograde))).toBeLessThan(1e-9);
    expect(Math.abs(dot(f.normal, f.radialOut))).toBeLessThan(1e-9);
  });
});

describe("Oberth-aware injection / capture burn", () => {
  it("from a 400 km LEO with v∞ = 3 km/s costs ~3.58 km/s (and always exceeds v∞)", () => {
    const dv = hyperbolicBurnDv(3000, MU_EARTH, R_EARTH + 4e5);
    expect(dv).toBeGreaterThan(3000); // never cheaper than the hyperbolic excess
    expect(dv).toBeGreaterThan(3500);
    expect(dv).toBeLessThan(3700);
  });
  it("approaches v∞ as the parking orbit grows (shallow well → little Oberth gain)", () => {
    const dv = hyperbolicBurnDv(3000, MU_EARTH, 1e15);
    expect(dv).toBeGreaterThan(2990);
    expect(dv).toBeLessThan(3001);
  });
});

describe("orbit summary", () => {
  it("a circular orbit reports equal peri/apo altitude and a sensible period", () => {
    const alt = 4e5;
    const sum = summarizeOrbit(circularOrbit(R_EARTH + alt), MU_EARTH, R_EARTH);
    expect(sum.bound).toBe(true);
    expect(sum.periapsisAlt).toBeCloseTo(alt, 0);
    expect(sum.apoapsisAlt).toBeCloseTo(alt, 0);
    expect(sum.period / 60).toBeGreaterThan(90); // ~92.5 min
    expect(sum.period / 60).toBeLessThan(95);
  });
});
