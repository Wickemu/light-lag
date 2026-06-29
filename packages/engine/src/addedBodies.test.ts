import { describe, it, expect } from "vitest";
import { bodyState, bodyStateRelative, bodyElements } from "./ephemeris.ts";
import { BODY_BY_ID, AU, DAY, RAD } from "./constants.ts";
import { period } from "./math/kepler.ts";
import { length } from "./math/vec3.ts";

const SAMPLE = [0, 365 * DAY, 1825 * DAY, 3650 * DAY];
const EARTH = BODY_BY_ID.get("earth")!;

describe("added small bodies stay within their real orbital bounds", () => {
  // [perihelion, aphelion] AU with a little slack, straight from JPL a, e @ J2000.
  const bounds: Record<string, [number, number]> = {
    eros: [1.13, 1.79], hygiea: [2.76, 3.52], juno: [1.97, 3.36], arrokoth: [42.3, 45.9],
  };
  for (const [id, [lo, hi]] of Object.entries(bounds)) {
    it(`${id} stays between ${lo} and ${hi} AU`, () => {
      for (const t of SAMPLE) {
        const r = length(bodyState(BODY_BY_ID.get(id)!, t).r) / AU;
        expect(r).toBeGreaterThanOrEqual(lo);
        expect(r).toBeLessThanOrEqual(hi);
      }
    });
  }

  it("Eros's J2000 perihelion matches JPL (~1.133 AU) and it is a fast NEA", () => {
    const el = bodyElements(BODY_BY_ID.get("eros")!, 0)!;
    expect((el.a * (1 - el.e)) / AU).toBeCloseTo(1.133, 2);
    const T = period(el.a, 1.32712440018e20) / (365.25 * DAY);
    expect(T).toBeGreaterThan(1.6); // ~1.76 yr orbit
    expect(T).toBeLessThan(1.9);
  });

  it("Arrokoth is a distant, low-eccentricity Kuiper-belt body", () => {
    const el = bodyElements(BODY_BY_ID.get("arrokoth")!, 0)!;
    expect(el.a / AU).toBeGreaterThan(43);
    expect(el.e).toBeLessThan(0.06);
  });
});

describe("major satellites orbit Earth in low orbit (#4a)", () => {
  const cases: [string, number][] = [["iss", 51.64], ["hubble", 28.47], ["tiangong", 41.47]];
  for (const [id, inclDeg] of cases) {
    it(`${id} is a 'satellite' of Earth in LEO at ${inclDeg}°`, () => {
      const def = BODY_BY_ID.get(id)!;
      expect(def.parent).toBe("earth");
      expect(def.kind).toBe("satellite");
      expect(def.hasSurface).toBe(false); // you cannot land on a space station
      const alt = (length(bodyStateRelative(def, 0).r) - EARTH.radius) / 1000;
      expect(alt).toBeGreaterThan(300);
      expect(alt).toBeLessThan(700);
      expect((bodyElements(def, 0)!.i * RAD)).toBeCloseTo(inclDeg, 0);
    });
  }

  it("the ISS completes an orbit in ~93 minutes", () => {
    const T = period(bodyElements(BODY_BY_ID.get("iss")!, 0)!.a, EARTH.mu) / 60;
    expect(T).toBeGreaterThan(88);
    expect(T).toBeLessThan(96);
  });

  it("a satellite tracks with its parent Earth (heliocentric position ≈ Earth's)", () => {
    const iss = BODY_BY_ID.get("iss")!;
    const dEarth = length(bodyStateRelative(iss, 0).r); // distance from Earth's centre
    const helio = length(bodyState(iss, 0).r) / AU; // ~1 AU like Earth
    expect(dEarth / 1000).toBeLessThan(7000); // within a few thousand km of Earth
    expect(helio).toBeGreaterThan(0.9);
    expect(helio).toBeLessThan(1.1);
  });
});
