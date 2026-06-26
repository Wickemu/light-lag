import { describe, it, expect } from "vitest";
import { STARS, STAR_BY_ID, radecToEcliptic, LIGHT_YEAR, starDistanceAU, starState, starPosition } from "./stars.ts";
import { C, JULIAN_YEAR } from "./constants.ts";
import { length, sub } from "./math/vec3.ts";

const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  a.x * b.x + a.y * b.y + a.z * b.z;
const MAS_TO_RAD = Math.PI / (180 * 3600 * 1000);

describe("the nearby-star catalog", () => {
  it("has the nearest two dozen systems, Proxima first by distance", () => {
    expect(STARS.length).toBeGreaterThanOrEqual(24);
    const nearest = [...STARS].sort((a, b) => a.distanceLy - b.distanceLy)[0]!;
    expect(nearest.id).toBe("proxima");
    expect(nearest.distanceLy).toBeCloseTo(4.2465, 3);
  });

  it("positions reproduce the catalog distance (ecliptic Cartesian, metres)", () => {
    for (const s of STARS) {
      const ly = length(s.pos) / LIGHT_YEAR;
      expect(ly).toBeCloseTo(s.distanceLy, 4);
    }
  });

  it("one light-year is c × a Julian year (derived, exact)", () => {
    expect(LIGHT_YEAR).toBeCloseTo(C * JULIAN_YEAR, 0);
    // Proxima ≈ 268,000 AU.
    expect(starDistanceAU(STAR_BY_ID.get("proxima")!)).toBeCloseTo(268_500, -3);
  });

  it("the equatorial→ecliptic conversion preserves length and round-trips", () => {
    // A point on the vernal equinox (ra=0,dec=0) is unchanged by the obliquity tilt.
    const eq = radecToEcliptic(0, 0, LIGHT_YEAR);
    expect(eq.x / LIGHT_YEAR).toBeCloseTo(1, 6);
    expect(Math.hypot(eq.y, eq.z) / LIGHT_YEAR).toBeLessThan(1e-9);
    // The north celestial pole tilts by the obliquity into the ecliptic frame.
    const pole = radecToEcliptic(0, Math.PI / 2, LIGHT_YEAR);
    const tilt = Math.atan2(pole.y, pole.z) * (180 / Math.PI);
    expect(tilt).toBeCloseTo(23.4393, 2);
  });

  it("one-way light-lag in years equals the distance in light-years", () => {
    const tau = STAR_BY_ID.get("tau-ceti")!;
    const lightLagYr = (length(tau.pos) / C) / JULIAN_YEAR;
    expect(lightLagYr).toBeCloseTo(tau.distanceLy, 3);
  });

  it("binary components reference a present parent", () => {
    for (const s of STARS) {
      if (s.parentId) expect(STAR_BY_ID.has(s.parentId)).toBe(true);
    }
  });
});

describe("stellar proper motion", () => {
  const barnard = STAR_BY_ID.get("barnard")!;

  it("starState at J2000 returns the catalog position exactly, at constant velocity", () => {
    const s0 = starState(barnard, 0);
    expect(s0.r.x).toBe(barnard.pos.x);
    expect(s0.r.y).toBe(barnard.pos.y);
    expect(s0.r.z).toBe(barnard.pos.z);
    expect(s0.v).toBe(barnard.vel); // the same constant velocity at every t
    expect(starState(barnard, 9e9).v).toBe(barnard.vel);
  });

  it("propagates position linearly in time (straight-line inertial drift)", () => {
    const yr = JULIAN_YEAR;
    const d1 = sub(starPosition(barnard, yr), barnard.pos);
    const d2 = sub(starPosition(barnard, 2 * yr), barnard.pos);
    // d2 = 2·d1: same direction (collinear) and twice the magnitude.
    expect(dot(d1, d2) / (length(d1) * length(d2))).toBeCloseTo(1, 12);
    expect(length(d2) / length(d1)).toBeCloseTo(2, 9);
  });

  it("angular drift over one year matches the total proper motion (Barnard ≈ 10.4″/yr)", () => {
    const a = barnard.pos, b = starPosition(barnard, JULIAN_YEAR);
    const ang = Math.acos(Math.min(1, dot(a, b) / (length(a) * length(b)))); // rad
    const expectedMas = Math.hypot(barnard.pmRA, barnard.pmDec); // μ_total
    expect(Math.abs(ang / MAS_TO_RAD - expectedMas) / expectedMas).toBeLessThan(1e-3);
  });

  it("velocity is a length-preserving rotation of the equatorial space velocity", () => {
    // equatorial→ecliptic is orthogonal, so |vel| = √(v_r² + v_tan²).
    const d = barnard.distanceLy * LIGHT_YEAR;
    const vA = (barnard.pmRA * MAS_TO_RAD / JULIAN_YEAR) * d;
    const vD = (barnard.pmDec * MAS_TO_RAD / JULIAN_YEAR) * d;
    const vR = barnard.rv * 1000;
    expect(length(barnard.vel)).toBeCloseTo(Math.hypot(vR, vA, vD), 3);
  });

  it("recovers the radial velocity as the line-of-sight component", () => {
    const vlos = dot(barnard.vel, barnard.pos) / length(barnard.pos); // m/s
    expect(vlos / 1000).toBeCloseTo(barnard.rv, 1); // ≈ −110.5 km/s
  });

  it("gives Barnard's Star its measured ~142 km/s space velocity", () => {
    expect(length(barnard.vel) / 1000).toBeCloseTo(142.6, 0);
  });

  it("starDistanceAU changes with time for a fast mover", () => {
    const d0 = starDistanceAU(barnard, 0);
    const d100 = starDistanceAU(barnard, 100 * JULIAN_YEAR);
    expect(d100).not.toBeCloseTo(d0, 2); // Barnard is approaching → measurably closer
  });
});
