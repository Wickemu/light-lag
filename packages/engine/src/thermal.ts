/**
 * Thermodynamics: the constraint you cannot engineer away.
 *
 * In vacuum a ship can shed heat ONLY by radiating it (no air, no water, nothing
 * to conduct into). That single fact — Stefan-Boltzmann, P = εσAT⁴ — drives a
 * chain of consequences the game takes seriously:
 *
 *  - Power costs radiator area, and radiators are big, hot, and fragile.
 *  - Everything warmer than the 2.7 K sky glows in the infrared, so there is no
 *    real stealth in space: a hot drive is a beacon, and even a cold hull
 *    re-radiates the sunlight it absorbs. Detection range falls only as 1/√, not
 *    to zero.
 *  - Sunlight itself thins as 1/r², so solar power collapses toward the outer
 *    system and forces nuclear power past the asteroid belt.
 *
 * Pure SI; depends only on physical constants.
 */

import { SIGMA, L_SUN, AU, IR_BAND_PHOTON_J } from "./constants.ts";

/** Cosmic-microwave-background floor (K) — the coldest sink a radiator ever sees. */
export const T_SPACE = 2.725;

/** Solar irradiance at heliocentric distance r (W/m²). ≈1361 at 1 AU. */
export function solarFlux(r: number): number {
  return L_SUN / (4 * Math.PI * r * r);
}

/** Electrical power from a solar array of area A (m²) and efficiency η at distance r. */
export function solarPower(r: number, area: number, eta = 0.3): number {
  return solarFlux(r) * area * eta;
}

/** Net power radiated by a surface: P = εσA(T⁴ − T_env⁴) (W). */
export function radiatedPower(eps: number, area: number, T: number, Tenv = T_SPACE): number {
  return eps * SIGMA * area * (T ** 4 - Tenv ** 4);
}

/** Radiator area (m²) needed to reject `wasteW` of heat at temperature T. The
 *  T⁴ dependence is brutal: halving the radiator temperature needs 16× the area. */
export function radiatorArea(wasteW: number, T: number, eps = 0.9, Tenv = T_SPACE): number {
  const q = eps * SIGMA * (T ** 4 - Tenv ** 4);
  return q > 0 ? wasteW / q : Infinity;
}

/** Equilibrium temperature (K) of a body radiating `inW` from area A. */
export function equilibriumTemp(inW: number, eps: number, area: number, Tenv = T_SPACE): number {
  return Math.pow(inW / (eps * SIGMA * area) + Tenv ** 4, 0.25);
}

/** Irradiance (W/m²) of a source of power P seen at distance d. */
export function irradiance(P: number, d: number): number {
  return P / (4 * Math.PI * d * d);
}

/**
 * A watching telescope's detection parameters — the radiometer equation made
 * explicit. The 1/r², √-power, and √-aperture relationships are exact physics;
 * the absolute numbers (NEP, integration time, the in-beam background) are a
 * documented calibration that sets only the detection SCALE, exactly like
 * THERMAL_PARAMS/SENSOR in ships.ts.
 */
export interface SensorSpec {
  apertureM2: number; // A_tel, collecting area (m²)
  nep: number; // detector noise-equivalent power (W/√Hz)
  integrationTimeS: number; // τ, dwell / integration time (s)
  snrThreshold: number; // SNR needed to call a detection (dimensionless; 5σ convention)
  bandPhotonEnergyJ: number; // hν of the sensing band (J) — sets background shot noise
  backgroundInBeamW: number; // P_bg, in-beam zodiacal-IR + CMB power (W). Aperture-
  // independent: a diffraction-limited system has étendue A_tel·Ω = λ², so a bigger
  // mirror sees a proportionally smaller patch of sky and the in-beam power is fixed.
}

/** A reference cooled-IR watching telescope. Documented calibration. */
export const DEFAULT_SENSOR: SensorSpec = {
  apertureM2: 1,
  nep: 1e-16, // cooled IR detector
  integrationTimeS: 3600, // stares for an hour
  snrThreshold: 5, // 5σ astronomy convention
  bandPhotonEnergyJ: IR_BAND_PHOTON_J, // ≈2e-20 J at 10 µm
  backgroundInBeamW: 1e-14, // zodiacal + CMB in-beam power
};

/**
 * Limiting noise POWER (W) of a sensor after integrating for τ: the detector
 * noise-equivalent power folded over the post-detection bandwidth Δf = 1/(2τ)
 * (`NEP/√(2τ)`), in quadrature with the background photon shot noise
 * `√(P_bg·hν/τ)` (N = P_bg·τ/hν background photons, σ = √N, so the power
 * fluctuation is hν·√N/τ). Both fall as 1/√τ. Past the background term the sensor
 * is sky-limited, not detector-limited, and a better detector buys nothing.
 */
export function sensorNoiseW(s: SensorSpec): number {
  const pDet = s.nep / Math.sqrt(2 * s.integrationTimeS);
  const pBg = Math.sqrt((s.backgroundInBeamW * s.bandPhotonEnergyJ) / s.integrationTimeS);
  return Math.hypot(pDet, pBg);
}

/** Minimum detectable collected power (W): the SNR threshold × the limiting noise. */
export function minDetectablePowerW(s: SensorSpec): number {
  return s.snrThreshold * sensorNoiseW(s);
}

/**
 * Maximum range (m) at which a source radiating `signatureW` reaches the sensor's
 * detection threshold: the distance at which the collected power
 * `P·A_tel/(4π d²)` falls to the minimum detectable power.
 *   d_max = √( P·A_tel / (4π·P_min) )
 *
 * Falls only as √P — halving the signature only cuts the range by √2, so there is
 * no real stealth in space. It improves as τ^(1/4) (range ∝ √(1/P_min), P_min ∝
 * 1/√τ) and as √(aperture), and shortens as √(SNR threshold).
 */
export function detectionRange(signatureW: number, s: SensorSpec): number {
  if (signatureW <= 0) return 0;
  return Math.sqrt((signatureW * s.apertureM2) / (4 * Math.PI * minDetectablePowerW(s)));
}

/** Instantaneous detection SNR of `signatureW` seen at range d (m): collected
 *  power over the limiting noise. Falls as 1/d²; equals the sensor's SNR
 *  threshold exactly at detectionRange(). */
export function snrAtRange(signatureW: number, s: SensorSpec, d: number): number {
  if (signatureW <= 0) return 0;
  if (d <= 0) return Infinity;
  return (signatureW * s.apertureM2) / (4 * Math.PI * d * d * sensorNoiseW(s));
}

/** Radiating/cross-section area (m²) of a ship of mass m, modelled as a sphere of
 *  bulk density ρ (≈ water). Surface area for radiating; A/4 is the mean
 *  sun-facing cross-section. */
export function hullArea(massKg: number, rho = 1000): number {
  const V = massKg / rho;
  const r = Math.cbrt((3 * V) / (4 * Math.PI));
  return 4 * Math.PI * r * r;
}

/** Convenience: a length in metres expressed in AU. */
export function toAU(m: number): number {
  return m / AU;
}
