import { describe, it, expect } from "vitest";
import { bodyState, bodyElements } from "./ephemeris.ts";
import { BODY_BY_ID, AU, DAY, MU_SUN } from "./constants.ts";
import { period } from "./math/kepler.ts";
import { length, cross } from "./math/vec3.ts";

const SAMPLE = [0, 365 * DAY, 1825 * DAY, 3650 * DAY];

describe("added TNOs and comets stay within their real orbital bounds", () => {
  // [perihelion, aphelion] AU with slack — straight from a, e.
  const bounds: Record<string, [number, number]> = {
    quaoar: [41, 45], orcus: [30, 49], gonggong: [33, 101], sedna: [70, 1050],
    halley: [0.5, 35.6], encke: [0.33, 4.11],
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
});

describe("the new comets are physically distinctive", () => {
  it("Halley is retrograde (negative angular-momentum z)", () => {
    const st = bodyState(BODY_BY_ID.get("halley")!, 0);
    expect(cross(st.r, st.v).z).toBeLessThan(0); // i ≈ 162°
  });
  it("the comets are steeply eccentric", () => {
    expect(bodyElements(BODY_BY_ID.get("halley")!, 0)!.e).toBeGreaterThan(0.9);
    expect(bodyElements(BODY_BY_ID.get("encke")!, 0)!.e).toBeGreaterThan(0.8);
  });
  it("Encke's period is ~3.3 years (Kepler from its semi-major axis)", () => {
    const T = period(bodyElements(BODY_BY_ID.get("encke")!, 0)!.a, MU_SUN) / (365.25 * DAY);
    expect(T).toBeGreaterThan(3.0);
    expect(T).toBeLessThan(3.6);
  });
});
