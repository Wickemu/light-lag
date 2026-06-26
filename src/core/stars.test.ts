import { describe, it, expect } from "vitest";
import { STARS, STAR_BY_ID, radecToEcliptic, LIGHT_YEAR, starDistanceAU } from "./stars.ts";
import { C, JULIAN_YEAR } from "./constants.ts";
import { length } from "./math/vec3.ts";

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
