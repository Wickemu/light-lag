import { describe, it, expect } from "vitest";
import { bodyState, bodyPosition, bodyElements } from "./ephemeris.ts";
import { BODY_BY_ID, AU, MU_SUN, DAY } from "./constants.ts";
import { period } from "./math/kepler.ts";
import { length, distance } from "./math/vec3.ts";

/** Sample several times across a decade so we don't accidentally test only the
 *  epoch instant. */
const SAMPLE_TIMES = [0, 90 * DAY, 200 * DAY, 365 * DAY, 1000 * DAY, 3650 * DAY];

describe("planetary distances stay within their real orbital bounds", () => {
  const bounds: Record<string, [number, number]> = {
    // [perihelion AU, aphelion AU], with a little slack.
    mercury: [0.30, 0.47],
    venus: [0.71, 0.73],
    earth: [0.98, 1.02],
    mars: [1.38, 1.67],
    jupiter: [4.95, 5.46],
    saturn: [9.0, 10.1],
    uranus: [18.3, 20.1],
    neptune: [29.8, 30.4],
  };

  for (const [id, [lo, hi]] of Object.entries(bounds)) {
    it(`${id} is between ${lo} and ${hi} AU from the Sun`, () => {
      for (const t of SAMPLE_TIMES) {
        const r = length(bodyState(BODY_BY_ID.get(id)!, t).r) / AU;
        expect(r).toBeGreaterThanOrEqual(lo);
        expect(r).toBeLessThanOrEqual(hi);
      }
    });
  }
});

describe("orbital periods match reality (Kepler's third law from real a)", () => {
  const expectedDays: Record<string, number> = {
    mercury: 87.97,
    venus: 224.70,
    earth: 365.25,
    mars: 686.98,
    jupiter: 4332.59,
    saturn: 10759.22,
    uranus: 30688.5,
    neptune: 60182,
  };

  for (const [id, days] of Object.entries(expectedDays)) {
    it(`${id} period ≈ ${days} days`, () => {
      const el = bodyElements(BODY_BY_ID.get(id)!, 0)!;
      const T = period(el.a, MU_SUN) / DAY;
      expect(T).toBeGreaterThan(days * 0.99);
      expect(T).toBeLessThan(days * 1.01);
    });
  }
});

describe("the Moon", () => {
  it("orbits Earth at roughly 384,400 km", () => {
    for (const t of SAMPLE_TIMES) {
      const earth = bodyState(BODY_BY_ID.get("earth")!, t).r;
      const moon = bodyState(BODY_BY_ID.get("moon")!, t).r;
      const d = distance(earth, moon) / 1000; // km
      expect(d).toBeGreaterThan(356_000); // perigee-ish
      expect(d).toBeLessThan(407_000); // apogee-ish
    }
  });

  it("has a sidereal period near 27.3 days", () => {
    const el = bodyElements(BODY_BY_ID.get("moon")!, 0)!;
    const T = period(el.a, BODY_BY_ID.get("earth")!.mu) / DAY;
    expect(T).toBeGreaterThan(27.0);
    expect(T).toBeLessThan(27.6);
  });
});

describe("the Earth–Mars synodic period drives the launch-window cadence", () => {
  it("is ~780 days (≈ 25.6 months)", () => {
    const tEarth = period(bodyElements(BODY_BY_ID.get("earth")!, 0)!.a, MU_SUN);
    const tMars = period(bodyElements(BODY_BY_ID.get("mars")!, 0)!.a, MU_SUN);
    const synodic = 1 / Math.abs(1 / tEarth - 1 / tMars) / DAY;
    expect(synodic).toBeGreaterThan(770);
    expect(synodic).toBeLessThan(790);
  });
});

describe("frame consistency", () => {
  it("the Sun sits at the origin of the root frame", () => {
    const r = bodyPosition("sun", 1234 * DAY);
    expect(length(r)).toBe(0);
  });

  it("Earth's heliocentric speed is ~29.8 km/s", () => {
    const v = length(bodyState(BODY_BY_ID.get("earth")!, 0).v) / 1000;
    expect(v).toBeGreaterThan(29.0);
    expect(v).toBeLessThan(30.6);
  });
});
