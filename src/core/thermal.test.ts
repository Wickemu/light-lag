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
});

describe("hull geometry", () => {
  it("a 1 t water-density sphere has ~4.8 m² of surface", () => {
    expect(hullArea(1000)).toBeGreaterThan(4.6);
    expect(hullArea(1000)).toBeLessThan(5.0);
  });
});
