import { describe, it, expect } from "vitest";
import { bodyState } from "./ephemeris.ts";
import { BODY_BY_ID, J2000_JD, DAY, AU } from "./constants.ts";
import { HORIZONS, HORIZONS_EARTH_EMB, type HorizonsRecord } from "./fixtures/horizons.ts";
import { distance, length } from "./math/vec3.ts";

const KM = 1000;

function ref(rec: HorizonsRecord) {
  return {
    r: { x: rec.r_km[0] * KM, y: rec.r_km[1] * KM, z: rec.r_km[2] * KM },
    v: { x: rec.v_kms[0] * KM, y: rec.v_kms[1] * KM, z: rec.v_kms[2] * KM },
  };
}
const tOf = (jd: number) => (jd - J2000_JD) * DAY;

// Position tolerance (m) per body — the JPL 1800–2050 approximate model is
// arc-minute class, a larger absolute distance the farther the body. These are
// the measured worst-case errors vs Horizons (2000–2025) with ~2× margin.
const POS_TOL: Record<string, number> = {
  mercury: 6e6, venus: 2.5e7, earth: 1.5e7, mars: 4e7, // inner: a few–20 thousand km
  jupiter: 2.5e9, saturn: 8e9, uranus: 3e9, neptune: 2.5e9, // giants: ~1–4 million km
};

describe("ephemeris vs JPL Horizons (geometric, ecliptic-J2000, heliocentric)", () => {
  for (const rec of HORIZONS) {
    it(`${rec.body} @ JD ${rec.jd} matches Horizons within tolerance`, () => {
      const st = bodyState(BODY_BY_ID.get(rec.body)!, tOf(rec.jd));
      const { r, v } = ref(rec);
      const dPos = distance(st.r, r);
      const dVel = distance(st.v, v);
      // Velocity tol scales with the position tol over an orbital timescale;
      // keep it generous (the osculating velocity omits slow element drift).
      expect(dPos).toBeLessThan(POS_TOL[rec.body]!);
      // Osculating velocity omits the slow element drift; the giants show ~0.3%.
      expect(dVel / length(v)).toBeLessThan(5e-3); // < 0.5% of speed
    });
  }

  it("the EMB→true-centre shift (D2) moves Earth closer to its real centre", () => {
    for (const emb of HORIZONS_EARTH_EMB) {
      const st = bodyState(BODY_BY_ID.get("earth")!, tOf(emb.jd));
      const center = HORIZONS.find((r) => r.body === "earth" && r.jd === emb.jd)!;
      const toCenter = distance(st.r, ref(center).r);
      const toEmb = distance(st.r, ref(emb).r);
      expect(toCenter).toBeLessThan(toEmb); // we now track the true centre, not the barycentre
      expect(toEmb).toBeGreaterThan(3e6); // the offset is real (~4–5 thousand km)
    }
  });

  it("reports the worst-case error per body (diagnostic)", () => {
    const worst: Record<string, number> = {};
    for (const rec of HORIZONS) {
      const st = bodyState(BODY_BY_ID.get(rec.body)!, tOf(rec.jd));
      const d = distance(st.r, ref(rec).r);
      worst[rec.body] = Math.max(worst[rec.body] ?? 0, d);
    }
    const lines = Object.entries(worst).map(
      ([b, d]) => `${b.padEnd(8)} ${(d / 1000).toFixed(0).padStart(8)} km  (${(d / AU).toExponential(2)} AU)`,
    );
    // eslint-disable-next-line no-console
    console.log("Max heliocentric position error vs JPL Horizons:\n" + lines.join("\n"));
    expect(Object.keys(worst).length).toBe(8);
  });
});
