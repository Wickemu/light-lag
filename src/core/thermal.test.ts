import { describe, it, expect } from "vitest";
import {
  solarFlux,
  solarPower,
  radiatedPower,
  radiatorArea,
  equilibriumTemp,
  detectionRange,
  hullArea,
} from "./thermal.ts";
import { AU, SIGMA } from "./constants.ts";

describe("solar power falls as 1/r²", () => {
  it("is ~1361 W/m² at 1 AU (the solar constant)", () => {
    const s = solarFlux(AU);
    expect(s).toBeGreaterThan(1350);
    expect(s).toBeLessThan(1370);
  });

  it("collapses by ~1/27 at Jupiter (5.2 AU)", () => {
    const ratio = solarFlux(5.2 * AU) / solarFlux(AU);
    expect(ratio).toBeCloseTo(1 / (5.2 * 5.2), 4);
  });

  it("a 100 m² array at 30% efficiency yields ~41 kW at 1 AU, ~1.5 kW at Jupiter", () => {
    expect(solarPower(AU, 100, 0.3) / 1000).toBeGreaterThan(38);
    expect(solarPower(AU, 100, 0.3) / 1000).toBeLessThan(44);
    expect(solarPower(5.2 * AU, 100, 0.3)).toBeLessThan(2000);
  });
});

describe("Stefan-Boltzmann radiators", () => {
  it("radiated power is εσA(T⁴−T_env⁴)", () => {
    expect(radiatedPower(1, 1, 300, 0)).toBeCloseTo(SIGMA * 300 ** 4, 6);
  });

  it("a 1 MW radiator at 350 K needs ~1300 m² (T⁴ makes hot radiators small)", () => {
    const a = radiatorArea(1e6, 350);
    expect(a).toBeGreaterThan(1200);
    expect(a).toBeLessThan(1450);
  });

  it("halving radiator temperature needs ~16× the area", () => {
    const ratio = radiatorArea(1e6, 175) / radiatorArea(1e6, 350);
    expect(ratio).toBeGreaterThan(15);
    expect(ratio).toBeLessThan(17);
  });

  it("a blackbody sphere at 1 AU equilibrates near 278 K", () => {
    const A = 10;
    const absorbed = solarFlux(AU) * (A / 4); // mean cross-section A/4, full absorption
    const T = equilibriumTemp(absorbed, 1, A, 0);
    expect(T).toBeGreaterThan(275);
    expect(T).toBeLessThan(282);
  });
});

describe("detection — no stealth in space", () => {
  it("range grows as √(signature) and is never zero for a warm object", () => {
    const r1 = detectionRange(1e6, 1, 1e-15);
    const r2 = detectionRange(4e6, 1, 1e-15);
    expect(r1).toBeGreaterThan(0);
    expect(r2 / r1).toBeCloseTo(2, 3); // 4× power → 2× range
  });

  it("a sky background floor makes detection background-limited, not detector-limited", () => {
    const sig = 3e4; // a cold ~30 kW hull
    const detectorLimited = detectionRange(sig, 1, 1e-15); // NEP only
    const skyLimited = detectionRange(sig, 1, 1e-15, 1e-14); // floor 10× the NEP dominates
    // The floor shortens the achievable range — a better detector buys nothing.
    expect(skyLimited).toBeLessThan(detectorLimited);
    expect(skyLimited / detectorLimited).toBeCloseTo(1 / Math.sqrt(10), 3); // √(NEP/floor)
    // Under the SAME floor a thrusting drive still vastly outshines the cold hull;
    // the floor cancels in the ratio, so the √(signature) law is preserved.
    const drive = detectionRange(1e9, 1, 1e-15, 1e-14);
    expect(drive / skyLimited).toBeCloseTo(Math.sqrt(1e9 / sig), 3);
  });
});

describe("hull geometry", () => {
  it("a 1 t water-density sphere has ~4.8 m² of surface", () => {
    expect(hullArea(1000)).toBeGreaterThan(4.6);
    expect(hullArea(1000)).toBeLessThan(5.0);
  });
});
