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

import { SIGMA, L_SUN, AU } from "./constants.ts";

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
 * Maximum range (m) at which a source radiating `signatureW` is detectable by a
 * telescope of collecting area `aperture` (m²): the distance at which the
 * collected power falls to the limiting noise power.
 *   d_max = √( P·A_tel / (4π·N) )
 *
 * The limiting noise N is the GREATER of the detector's own noise-equivalent
 * power `nep` and an astrophysical `backgroundFloorW` — the in-beam zodiacal-IR +
 * CMB photon background a real sensor integrates against and cannot null out.
 * Past that floor the sensor is background-limited, not detector-limited, so a
 * perfect detector buys nothing: the sky itself sets the range. Default 0 keeps
 * the pure detector-limited behaviour.
 */
export function detectionRange(signatureW: number, aperture: number, nep: number, backgroundFloorW = 0): number {
  if (signatureW <= 0) return 0;
  const noise = Math.max(nep, backgroundFloorW);
  return Math.sqrt((signatureW * aperture) / (4 * Math.PI * noise));
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
