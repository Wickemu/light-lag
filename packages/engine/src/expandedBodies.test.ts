import { describe, it, expect } from "vitest";
import { bodyState, bodyStateRelative, bodyElements } from "./ephemeris.ts";
import { BODY_BY_ID, AU, DAY, MU_SUN, type BodyRegion } from "./constants.ts";
import { HORIZONS_ADDED_HELIO, HORIZONS_ADDED_MOONS, type HorizonsRecord } from "./fixtures/horizons.ts";
import { period } from "./math/kepler.ts";
import { distance, length, cross } from "./math/vec3.ts";

const KM = 1000;
const J2000_JD = 2451545.0;
const tOf = (jd: number) => (jd - J2000_JD) * DAY;
function ref(rec: HorizonsRecord) {
  return {
    r: { x: rec.r_km[0] * KM, y: rec.r_km[1] * KM, z: rec.r_km[2] * KM },
    v: { x: rec.v_kms[0] * KM, y: rec.v_kms[1] * KM, z: rec.v_kms[2] * KM },
  };
}

// The expanded heliocentric small bodies reproduce their J2000 Horizons state to
// metre-class precision AT the epoch (the osculating conic IS this state there) —
// the same external check the original dwarfs/asteroids get in ephemeris.bodies.test.
describe("expanded heliocentric bodies vs JPL Horizons @ J2000", () => {
  for (const rec of HORIZONS_ADDED_HELIO) {
    it(`${rec.body} matches Horizons at the epoch`, () => {
      const body = BODY_BY_ID.get(rec.body)!;
      const st = bodyState(body, tOf(rec.jd));
      const { r, v } = ref(rec);
      // 10 km absolute: well above the fixture's own ~km rounding, far below any
      // orbit radius (the closest, an NEA, is ~1e8 km out).
      expect(distance(st.r, r)).toBeLessThan(1e4);
      expect(distance(st.v, v) / length(v)).toBeLessThan(1e-4);
    });
  }
});

describe("expanded moons vs JPL Horizons @ J2000 (parent-relative)", () => {
  for (const rec of HORIZONS_ADDED_MOONS) {
    it(`${rec.body} matches Horizons at the epoch`, () => {
      const body = BODY_BY_ID.get(rec.body)!;
      const st = bodyStateRelative(body, tOf(rec.jd));
      const { r, v } = ref(rec);
      const orbitR = length(r);
      expect(distance(st.r, r)).toBeLessThan(orbitR * 0.01);
      expect(distance(st.v, v) / length(v)).toBeLessThan(0.02);
    });
  }
});

// Every added body is a bound conic that never leaves its [perihelion, apoapsis]
// shell — catches a mis-parented moon or a runaway (e ≥ 1) element set.
describe("expanded bodies stay on their orbits", () => {
  const SAMPLE = [0, 90 * DAY, 365 * DAY, 1825 * DAY];
  const all = [...HORIZONS_ADDED_HELIO, ...HORIZONS_ADDED_MOONS].map((r) => r.body);
  for (const id of all) {
    it(`${id} stays within [perihelion, apoapsis]`, () => {
      const body = BODY_BY_ID.get(id)!;
      const el = bodyElements(body, 0)!;
      expect(el.e).toBeLessThan(1); // bound orbit
      const peri = el.a * (1 - el.e), apo = el.a * (1 + el.e);
      const helio = body.parent === "sun";
      for (const t of SAMPLE) {
        const d = helio ? length(bodyState(body, t).r) : length(bodyStateRelative(body, t).r);
        expect(d).toBeGreaterThan(peri * 0.97);
        expect(d).toBeLessThan(apo * 1.03);
      }
    });
  }
});

describe("the expansion is physically distinctive", () => {
  it("Jupiter Trojans share Jupiter's semi-major axis (~5.2 AU)", () => {
    for (const id of ["hektor", "patroclus", "achilles", "eurybates"]) {
      const a = bodyElements(BODY_BY_ID.get(id)!, 0)!.a / AU;
      expect(a).toBeGreaterThan(5.0);
      expect(a).toBeLessThan(5.4);
    }
  });

  it("the near-Earth asteroids reach in to ~1 AU (perihelion ≤ 1.1 AU)", () => {
    for (const id of ["bennu", "ryugu", "itokawa", "apophis"]) {
      const el = bodyElements(BODY_BY_ID.get(id)!, 0)!;
      expect((el.a * (1 - el.e)) / AU).toBeLessThanOrEqual(1.1);
    }
  });

  it("Apophis is an Earth-crossing Aten/Apollo (a < 1 AU but apoapsis > 1 AU)", () => {
    const el = bodyElements(BODY_BY_ID.get("apophis")!, 0)!;
    expect(el.a / AU).toBeLessThan(1.0);
    expect((el.a * (1 + el.e)) / AU).toBeGreaterThan(1.0);
  });

  it("the retrograde irregular moons have negative orbital angular momentum (i > 90°)", () => {
    for (const id of ["pasiphae", "sinope", "carme", "ananke", "phoebe"]) {
      const st = bodyStateRelative(BODY_BY_ID.get(id)!, 100 * DAY);
      expect(cross(st.r, st.v).z).toBeLessThan(0);
    }
  });

  it("Nereid is on a wildly eccentric orbit (e > 0.7)", () => {
    expect(bodyElements(BODY_BY_ID.get("nereid")!, 0)!.e).toBeGreaterThan(0.7);
  });

  it("Leleākūhonua is a detached inner-Oort body (a ≫ Neptune, q in the Kuiper belt)", () => {
    const el = bodyElements(BODY_BY_ID.get("leleakuhonua")!, 0)!;
    expect(el.a / AU).toBeGreaterThan(500);
    expect((el.a * (1 - el.e)) / AU).toBeGreaterThan(50); // perihelion beyond Neptune
  });

  it("Kepler's third law holds for a sample of the new bodies", () => {
    const helioDays: Record<string, number> = { psyche: 1825.6, hektor: 4344, ixion: 90220 };
    for (const [id, d] of Object.entries(helioDays)) {
      const T = period(bodyElements(BODY_BY_ID.get(id)!, 0)!.a, MU_SUN) / DAY;
      expect(T).toBeGreaterThan(d * 0.95);
      expect(T).toBeLessThan(d * 1.05);
    }
  });
});

// The region tags drive the navigator's belt/Kuiper/Oort grouping — assert the
// taxonomy is complete and only on the heliocentric small bodies it belongs on.
describe("region tags are well-formed", () => {
  const VALID: BodyRegion[] = ["near_earth", "main_belt", "trojan", "kuiper", "scattered", "oort"];
  it("every heliocentric asteroid/dwarf carries a valid region; nothing else does", () => {
    for (const b of BODY_BY_ID.values()) {
      const small = b.parent === "sun" && (b.kind === "asteroid" || b.kind === "dwarf");
      if (small) {
        expect(b.region, `${b.id} needs a region`).toBeDefined();
        expect(VALID).toContain(b.region!);
      } else {
        expect(b.region, `${b.id} should not have a region`).toBeUndefined();
      }
    }
  });

  it("each region is populated", () => {
    const seen = new Set<BodyRegion>();
    for (const b of BODY_BY_ID.values()) if (b.region) seen.add(b.region);
    for (const r of VALID) expect(seen, `region ${r} is empty`).toContain(r);
  });
});
