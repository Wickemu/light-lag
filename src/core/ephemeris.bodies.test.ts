import { describe, it, expect } from "vitest";
import { bodyState, bodyStateRelative, bodyElements } from "./ephemeris.ts";
import { BODY_BY_ID, J2000_JD, DAY, AU, MU_SUN, type BodyDef } from "./constants.ts";
import {
  HORIZONS_SMALL_BODIES, HORIZONS_MOONS_REL, type HorizonsRecord,
} from "./fixtures/horizons.ts";
import { period } from "./math/kepler.ts";
import { distance, length, sub, scale, cross } from "./math/vec3.ts";

const KM = 1000;
const tOf = (jd: number) => (jd - J2000_JD) * DAY;
function ref(rec: HorizonsRecord) {
  return {
    r: { x: rec.r_km[0] * KM, y: rec.r_km[1] * KM, z: rec.r_km[2] * KM },
    v: { x: rec.v_kms[0] * KM, y: rec.v_kms[1] * KM, z: rec.v_kms[2] * KM },
  };
}

/** Heliocentric state to compare against Horizons. For a body whose row is a
 *  barycentre (Pluto, Earth), ephemeris.ts places the body at its true centre, so
 *  recombine the mass-weighted pair back to the barycentre the fixture encodes. */
function heliocentricRef(body: BodyDef, t: number) {
  if (!body.barycenterChild) return bodyState(body, t);
  const sat = BODY_BY_ID.get(body.barycenterChild)!;
  const f = sat.mu / (body.mu + sat.mu);
  const p = bodyState(body, t), s = bodyState(sat, t);
  const mix = (pc: number, sc: number) => pc * (1 - f) + sc * f;
  return {
    r: { x: mix(p.r.x, s.r.x), y: mix(p.r.y, s.r.y), z: mix(p.r.z, s.r.z) },
    v: { x: mix(p.v.x, s.v.x), y: mix(p.v.y, s.v.y), z: mix(p.v.z, s.v.z) },
  };
}

describe("added dwarf planets & asteroids vs JPL Horizons (heliocentric)", () => {
  // The J2000 osculating conic reproduces position to machine precision AT the
  // epoch (validating every element + the ω/Ω convention); thereafter a pure
  // two-body conic drifts as perturbations accumulate (no Standish rate fit
  // exists for these bodies — see the FixedHelioRow note). Over the 21st-century
  // game era that drift stays within a few percent of the orbit radius.
  for (const rec of HORIZONS_SMALL_BODIES) {
    const epoch = rec.jd === J2000_JD;
    it(`${rec.body} @ JD ${rec.jd} matches Horizons`, () => {
      const body = BODY_BY_ID.get(rec.body)!;
      const st = heliocentricRef(body, tOf(rec.jd)); // barycentre for a binary primary
      const { r, v } = ref(rec);
      const a = bodyElements(body, 0)!.a; // m
      const tol = epoch ? 1e4 : 0.03 * a; // tight at epoch; ≤3% of a out to 2025
      expect(distance(st.r, r)).toBeLessThan(tol);
      if (epoch) expect(distance(st.v, v) / length(v)).toBeLessThan(1e-4);
    });
  }
});

describe("added moons vs JPL Horizons (parent-relative)", () => {
  // At J2000 the conic is exact (phase + orientation validated). For a fast moon
  // a sub-0.1% mean-motion offset wraps the phase over thousands of orbits in a
  // decade, so a later-epoch *position* match is not meaningful — but the orbit
  // RADIUS (a, e) is preserved, which is what we assert past the epoch (and the
  // bounds test below covers the full window).
  for (const rec of HORIZONS_MOONS_REL) {
    const epoch = rec.jd === J2000_JD;
    it(`${rec.body} @ JD ${rec.jd} ${epoch ? "matches Horizons" : "keeps its orbit radius"} (parent-relative)`, () => {
      const body = BODY_BY_ID.get(rec.body)!;
      const st = bodyStateRelative(body, tOf(rec.jd));
      const { r, v } = ref(rec);
      const orbitR = length(r);
      if (epoch) {
        expect(distance(st.r, r)).toBeLessThan(orbitR * 0.01);
        expect(distance(st.v, v) / length(v)).toBeLessThan(0.02);
      } else {
        // Radius preserved to a few percent even as the phase drifts.
        expect(Math.abs(length(st.r) - orbitR) / orbitR).toBeLessThan(0.08);
      }
    });
  }
});

describe("new heliocentric bodies sit within their real orbital bounds", () => {
  const bounds: Record<string, [number, number]> = {
    // [perihelion, aphelion] AU with slack.
    ceres: [2.5, 3.0], pallas: [2.1, 3.4], vesta: [2.15, 2.58],
    pluto: [29.6, 49.4], haumea: [34.5, 51.6], makemake: [37.9, 52.8],
    eris: [38.2, 97.7],
  };
  const SAMPLE = [0, 365 * DAY, 3650 * DAY];
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

describe("new moons orbit their parent at the right distance", () => {
  // [perispsis, apoapsis] km with slack.
  const bounds: Record<string, [number, number]> = {
    io: [420_000, 424_000], europa: [664_000, 678_000], ganymede: [1_068_000, 1_073_000],
    callisto: [1_868_000, 1_898_000], titan: [1_186_000, 1_258_000], triton: [354_000, 355_500],
    charon: [19_500, 19_700], phobos: [9_200, 9_600], deimos: [23_400, 23_500],
  };
  const SAMPLE = [0, 30 * DAY, 365 * DAY];
  for (const [id, [lo, hi]] of Object.entries(bounds)) {
    it(`${id} stays ${lo}–${hi} km from its parent`, () => {
      const body = BODY_BY_ID.get(id)!;
      for (const t of SAMPLE) {
        const d = length(bodyStateRelative(body, t).r) / 1000;
        expect(d).toBeGreaterThan(lo);
        expect(d).toBeLessThan(hi);
      }
    });
  }
});

describe("Pluto–Charon is a barycentric binary", () => {
  const PLUTO = BODY_BY_ID.get("pluto")!;
  const CHARON = BODY_BY_ID.get("charon")!;
  const f = CHARON.mu / (PLUTO.mu + CHARON.mu);
  const SAMPLE = [0, 30 * DAY, 1000 * DAY];
  const baryOf = (t: number) => {
    const p = bodyState(PLUTO, t).r, s = bodyState(CHARON, t).r;
    return { x: p.x * (1 - f) + s.x * f, y: p.y * (1 - f) + s.y * f, z: p.z * (1 - f) + s.z * f };
  };

  it("recombines our true-centre Pluto + Charon to the JPL system barycentre at epoch", () => {
    const bary = ref(HORIZONS_SMALL_BODIES.find((r) => r.body === "pluto" && r.jd === J2000_JD)!).r;
    expect(distance(baryOf(0), bary)).toBeLessThan(1e4); // 10 km — the conic's epoch precision
  });

  it("puts the barycentre ABOVE Pluto's surface — a true binary, unlike Earth–Moon", () => {
    for (const t of SAMPLE) {
      const plutoToBary = distance(bodyState(PLUTO, t).r, baryOf(t));
      expect(plutoToBary).toBeGreaterThan(PLUTO.radius); // ~2130 km > 1188 km radius
    }
    // Earth's barycentre, by contrast, sits inside Earth (so it reads as a normal moon).
    const earth = BODY_BY_ID.get("earth")!, moon = BODY_BY_ID.get("moon")!;
    const fE = moon.mu / (earth.mu + moon.mu);
    expect(fE * length(bodyStateRelative(moon, 0).r)).toBeLessThan(earth.radius);
  });

  it("preserves the centre-to-centre separation after the shift", () => {
    for (const t of SAMPLE) {
      const d = distance(bodyState(CHARON, t).r, bodyState(PLUTO, t).r) / 1000;
      expect(d).toBeGreaterThan(19_500);
      expect(d).toBeLessThan(19_700);
    }
  });
});

describe("Kepler's third law from the published semi-major axis", () => {
  // Real sidereal periods (days).
  const helioDays: Record<string, number> = {
    ceres: 1681.6, vesta: 1325.7, pluto: 90560, eris: 203830,
  };
  for (const [id, d] of Object.entries(helioDays)) {
    it(`${id} period ≈ ${d} d`, () => {
      const T = period(bodyElements(BODY_BY_ID.get(id)!, 0)!.a, MU_SUN) / DAY;
      expect(T).toBeGreaterThan(d * 0.97);
      expect(T).toBeLessThan(d * 1.03);
    });
  }
  const moonDays: Record<string, number> = {
    io: 1.769, europa: 3.551, ganymede: 7.155, titan: 15.945, triton: 5.877, charon: 6.387,
  };
  for (const [id, d] of Object.entries(moonDays)) {
    it(`${id} period ≈ ${d} d`, () => {
      const body = BODY_BY_ID.get(id)!;
      const mu = BODY_BY_ID.get(body.parent!)!.mu + body.mu;
      const T = period(bodyElements(body, 0)!.a, mu) / DAY;
      expect(T).toBeGreaterThan(d * 0.97);
      expect(T).toBeLessThan(d * 1.03);
    });
  }
});

describe("analytic velocity matches the numerical derivative (new bodies)", () => {
  const cases: [string, number][] = [["ceres", 1e-3], ["io", 5e-3], ["titan", 5e-3]];
  for (const [id, tol] of cases) {
    it(`${id}: |v − dr/dt| / |v| < ${tol}`, () => {
      const body = BODY_BY_ID.get(id)!;
      const t = 200 * DAY;
      const h = 30;
      const rp = bodyState(body, t + h).r;
      const rm = bodyState(body, t - h).r;
      const vNum = scale(sub(rp, rm), 1 / (2 * h));
      const vAna = bodyState(body, t).v;
      expect(distance(vNum, vAna) / length(vAna)).toBeLessThan(tol);
    });
  }
});

describe("Triton is retrograde", () => {
  it("has a negative orbital angular-momentum z about Neptune", () => {
    const st = bodyStateRelative(BODY_BY_ID.get("triton")!, 100 * DAY);
    const h = cross(st.r, st.v); // specific angular momentum
    expect(h.z).toBeLessThan(0); // retrograde ⇒ h points south of the ecliptic
  });
});

it("diagnostic: worst-case errors vs Horizons", () => {
  const lines: string[] = [];
  for (const rec of HORIZONS_SMALL_BODIES) {
    const body = BODY_BY_ID.get(rec.body)!;
    const d = distance(heliocentricRef(body, tOf(rec.jd)).r, ref(rec).r);
    lines.push(`${rec.body.padEnd(9)} JD${rec.jd}  ${(d / 1000).toFixed(0).padStart(9)} km  (${(d / AU).toExponential(2)} AU)`);
  }
  for (const rec of HORIZONS_MOONS_REL) {
    const body = BODY_BY_ID.get(rec.body)!;
    const d = distance(bodyStateRelative(body, tOf(rec.jd)).r, ref(rec).r);
    lines.push(`${rec.body.padEnd(9)} JD${rec.jd}  ${(d / 1000).toFixed(1).padStart(9)} km (rel)`);
  }
  // eslint-disable-next-line no-console
  console.log("Position error vs JPL Horizons (new bodies):\n" + lines.join("\n"));
  expect(lines.length).toBeGreaterThan(0);
});
