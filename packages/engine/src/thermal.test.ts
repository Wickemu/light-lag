import { describe, it, expect } from "vitest";
import {
  solarFlux,
  solarPower,
  radiatedPower,
  radiatorArea,
  equilibriumTemp,
  detectionRange,
  sensorNoiseW,
  minDetectablePowerW,
  snrAtRange,
  type SensorSpec,
  DEFAULT_SENSOR,
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

describe("detection — no stealth in space (radiometer equation)", () => {
  // A detector-limited base sensor (negligible background) for the clean laws.
  const base: SensorSpec = { ...DEFAULT_SENSOR, backgroundInBeamW: 0 };

  it("range grows as √(signature) and is never zero for a warm object", () => {
    const r1 = detectionRange(1e6, base);
    const r2 = detectionRange(4e6, base);
    expect(r1).toBeGreaterThan(0);
    expect(r2 / r1).toBeCloseTo(2, 3); // 4× power → 2× range
  });

  it("the minimum detectable power is SNR × the limiting noise", () => {
    expect(minDetectablePowerW(base)).toBeCloseTo(base.snrThreshold * sensorNoiseW(base), 12);
    // Detector-limited base: noise is NEP folded over Δf = 1/(2τ).
    expect(sensorNoiseW(base)).toBeCloseTo(base.nep / Math.sqrt(2 * base.integrationTimeS), 12);
  });

  it("a longer integration deepens the range as τ^(1/4)", () => {
    // P_min ∝ τ^(−1/2) and d ∝ P_min^(−1/2) ⇒ d ∝ τ^(1/4): 16× τ → 2× range.
    const r1 = detectionRange(1e6, { ...base, integrationTimeS: 3600 });
    const r16 = detectionRange(1e6, { ...base, integrationTimeS: 16 * 3600 });
    expect(r16 / r1).toBeCloseTo(2, 2);
  });

  it("a stricter SNR threshold shortens the range as 1/√SNR", () => {
    const r5 = detectionRange(1e6, { ...base, snrThreshold: 5 });
    const r20 = detectionRange(1e6, { ...base, snrThreshold: 20 });
    expect(r5 / r20).toBeCloseTo(2, 3); // 4× SNR → half the range
  });

  it("a bigger mirror reaches farther as √(aperture)", () => {
    const r1 = detectionRange(1e6, { ...base, apertureM2: 1 });
    const r2 = detectionRange(1e6, { ...base, apertureM2: 2 });
    expect(r2 / r1).toBeCloseTo(Math.SQRT2, 3);
  });

  it("the SNR curve falls as 1/d² and hits the threshold exactly at the detection range", () => {
    const sig = 3e4;
    const d = detectionRange(sig, DEFAULT_SENSOR);
    expect(snrAtRange(sig, DEFAULT_SENSOR, d)).toBeCloseTo(DEFAULT_SENSOR.snrThreshold, 6);
    // Half the range → 4× the SNR (inverse-square).
    expect(snrAtRange(sig, DEFAULT_SENSOR, d / 2) / snrAtRange(sig, DEFAULT_SENSOR, d)).toBeCloseTo(4, 6);
  });

  it("a rising sky background makes detection background-limited, not detector-limited", () => {
    const sig = 3e4; // a cold ~30 kW hull
    const detectorLimited = detectionRange(sig, base); // negligible background
    // Raise the in-beam background until photon shot noise dominates the NEP.
    const skyLimited = detectionRange(sig, { ...base, backgroundInBeamW: 1e-8 });
    expect(sensorNoiseW({ ...base, backgroundInBeamW: 1e-8 })).toBeGreaterThan(sensorNoiseW(base));
    expect(skyLimited).toBeLessThan(detectorLimited); // a better detector buys nothing
    // Under the SAME floor a thrusting drive still vastly outshines the cold hull;
    // the noise cancels in the ratio, so the √(signature) law is preserved.
    const drive = detectionRange(1e9, { ...base, backgroundInBeamW: 1e-8 });
    expect(drive / skyLimited).toBeCloseTo(Math.sqrt(1e9 / sig), 3);
  });
});

describe("hull geometry", () => {
  it("a 1 t water-density sphere has ~4.8 m² of surface", () => {
    expect(hullArea(1000)).toBeGreaterThan(4.6);
    expect(hullArea(1000)).toBeLessThan(5.0);
  });
});
