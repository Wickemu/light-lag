/**
 * The nearest star systems — the first step toward interstellar play.
 *
 * Real measured data (J2000 RA/Dec + parallax distance, plus proper motion and
 * radial velocity) for the ~24 nearest systems within ~12 light-years. The J2000
 * position is converted ONCE at module load from equatorial RA/Dec/distance to
 * ECLIPTIC-J2000 Cartesian metres — the SAME root frame the planetary ephemeris
 * and the light-lag comms use — so distances, light-times, and 3D placement all
 * reuse the existing machinery unchanged.
 *
 * Stars are NOT fixed points: each carries a real space-velocity vector derived
 * from its proper motion (μα*, μδ in mas/yr) and radial velocity (km/s). A star's
 * state is propagated linearly — r(t) = pos + vel·t — which is exact: an isolated
 * star coasts in a straight line at constant velocity, so there is no curvature to
 * integrate. `starState(star, t)` is read-time analytic and exact at any time-warp.
 * Over the decade-to-century voyages the interstellar layer simulates this matters:
 * Barnard's Star alone sweeps ~10.4″/yr. Binary/multiple components carry a parentId
 * and inherit the system's bulk space velocity where a per-component PM is not
 * separately measured — the small orbital motion of the pair is neglected (a
 * documented approximation, like the Pluto–Charon barycentre).
 *
 * Sources: Hipparcos / Gaia DR3 / SIMBAD.
 *
 * SI throughout (metres, radians, seconds). Luminosity in L_sun, mass in M_sun.
 * Proper motion is stored in catalog-natural mas/yr (μα* already includes cosδ)
 * and radial velocity in km/s; both are converted to SI when the velocity vector
 * is built.
 */

import { type Vec3, addScaled, length } from "./math/vec3.ts";
import { AU, C, JULIAN_YEAR } from "./constants.ts";
import { NAVIGABLE_ADDITION_SEEDS, BACKDROP_SEEDS } from "./brightStars.generated.ts";

/** One light-year in metres (derived, exact): c · one Julian year. */
export const LIGHT_YEAR = C * JULIAN_YEAR;

/** Obliquity of the ecliptic at J2000 (rad) — the equatorial→ecliptic tilt. */
const OBLIQUITY = (23.4392911 * Math.PI) / 180;

/** mas/yr → rad/s (milliarcsec → rad, per Julian year → per second). */
const MAS_PER_YR_TO_RAD_PER_S = Math.PI / (180 * 3600 * 1000) / JULIAN_YEAR;

/** Rotate a vector from the equatorial-J2000 frame into the ecliptic-J2000 frame
 *  by the obliquity about the x-axis (vernal equinox). Orthogonal — preserves
 *  length. Shared by both position and velocity so they stay in one frame. */
export function equatorialToEcliptic(v: Vec3): Vec3 {
  const co = Math.cos(OBLIQUITY), so = Math.sin(OBLIQUITY);
  return { x: v.x, y: v.y * co + v.z * so, z: -v.y * so + v.z * co };
}

/**
 * Equatorial RA/Dec/distance → ecliptic-J2000 Cartesian metres. Build the unit
 * direction in the equatorial frame, scale by distance, then rotate into the
 * ecliptic frame. Exact.
 */
export function radecToEcliptic(ra: number, dec: number, distanceM: number): Vec3 {
  const xe = Math.cos(dec) * Math.cos(ra);
  const ye = Math.cos(dec) * Math.sin(ra);
  const ze = Math.sin(dec);
  return equatorialToEcliptic({ x: distanceM * xe, y: distanceM * ye, z: distanceM * ze });
}

/** A star (or stellar component) with real measured data. `pos`/`vel` are derived
 *  at module load — do not hand-set them. */
export interface StarDef {
  id: string;
  name: string;
  ra: number; // J2000 right ascension (rad)
  dec: number; // J2000 declination (rad)
  distanceLy: number; // light-years (from parallax)
  pmRA: number; // proper motion μα* = μα·cosδ (mas/yr)
  pmDec: number; // proper motion in declination μδ (mas/yr)
  rv: number; // radial velocity (km/s, + = receding)
  pos: Vec3; // ecliptic-J2000 Cartesian metres at J2000 (DERIVED)
  vel: Vec3; // ecliptic-J2000 space velocity, m/s (DERIVED)
  spectralType: string;
  luminosity: number; // L_sun
  massSun: number; // M_sun
  parentId?: string; // for binary/multiple components
  appMag?: number; // real catalog apparent (visual) magnitude — preferred for sizing
  con?: string; // IAU 3-letter constellation (e.g. "Aql")
  bayer?: string; // Bayer / Flamsteed designation, for labels
  hip?: number; // Hipparcos id (provenance)
}

export type StarSeed = Omit<StarDef, "pos" | "vel">;

/** A distant backdrop star: a point on the unzoomable sky, never simulated and
 *  never a travel target — so it carries only what the renderer needs (no mass,
 *  no proper motion: at >25 ly the drift is sub-pixel over the simulated span).
 *  `pos` is derived at module load; `vel` is zero. */
export interface BackdropStar {
  id: string;
  name: string;
  ra: number; // J2000 right ascension (rad)
  dec: number; // J2000 declination (rad)
  distanceLy: number;
  spectralType: string;
  appMag: number; // real catalog apparent (visual) magnitude
  con?: string;
  bayer?: string;
  pos: Vec3; // ecliptic-J2000 Cartesian metres at J2000 (DERIVED)
  vel: Vec3; // zero (DERIVED) — kept for a uniform shape with StarDef
}

export type BackdropSeed = Omit<BackdropStar, "pos" | "vel">;

/**
 * The ecliptic-J2000 space velocity (m/s) from proper motion + radial velocity.
 * Decompose into the standard local tangent basis at (ra, dec): the radial unit
 * r̂, the increasing-RA unit p̂, and the increasing-Dec unit q̂. The tangential
 * linear speeds are μ·d (μ in rad/s, d the distance in metres); μα* already
 * carries cosδ, so the RA-direction speed is μα*·d directly. Then rotate the
 * equatorial-frame velocity into the ecliptic frame.
 */
export function starSpaceVelocity(seed: Pick<StarDef, "ra" | "dec" | "distanceLy" | "pmRA" | "pmDec" | "rv">): Vec3 {
  const d = seed.distanceLy * LIGHT_YEAR;
  const vAlpha = seed.pmRA * MAS_PER_YR_TO_RAD_PER_S * d; // m/s, along p̂
  const vDelta = seed.pmDec * MAS_PER_YR_TO_RAD_PER_S * d; // m/s, along q̂
  const vR = seed.rv * 1000; // km/s → m/s, along r̂
  const ca = Math.cos(seed.ra), sa = Math.sin(seed.ra);
  const cd = Math.cos(seed.dec), sd = Math.sin(seed.dec);
  const rHat = { x: cd * ca, y: cd * sa, z: sd };
  const pHat = { x: -sa, y: ca, z: 0 };
  const qHat = { x: -sd * ca, y: -sd * sa, z: cd };
  const vEq = {
    x: vR * rHat.x + vAlpha * pHat.x + vDelta * qHat.x,
    y: vR * rHat.y + vAlpha * pHat.y + vDelta * qHat.y,
    z: vR * rHat.z + vAlpha * pHat.z + vDelta * qHat.z,
  };
  return equatorialToEcliptic(vEq);
}

const SEEDS: StarSeed[] = [
  { id: "proxima", name: "Proxima Centauri", ra: 3.7948475760, dec: -1.0939626789, distanceLy: 4.2465, pmRA: -3781.74, pmDec: 769.47, rv: -22.40, spectralType: "M5.5Ve", luminosity: 0.0017, massSun: 0.1221, parentId: "alpha-cen-a" },
  { id: "alpha-cen-a", name: "Alpha Centauri A", ra: 3.8380153862, dec: -1.0617516579, distanceLy: 4.365, pmRA: -3679.25, pmDec: 473.67, rv: -22.30, spectralType: "G2V", luminosity: 1.519, massSun: 1.0788 },
  { id: "alpha-cen-b", name: "Alpha Centauri B", ra: 3.8379135753, dec: -1.0618098355, distanceLy: 4.365, pmRA: -3614.39, pmDec: 802.98, rv: -20.60, spectralType: "K1V", luminosity: 0.5, massSun: 0.9092, parentId: "alpha-cen-a" },
  { id: "barnard", name: "Barnard's Star", ra: 4.7028260305, dec: 0.0819141196, distanceLy: 5.963, pmRA: -802.80, pmDec: 10362.54, rv: -110.51, spectralType: "M4.0V", luminosity: 0.0035, massSun: 0.144 },
  { id: "luhman16", name: "Luhman 16", ra: 2.8329311754, dec: -0.9305804683, distanceLy: 6.5, pmRA: -2759.0, pmDec: 358.0, rv: 22.0, spectralType: "L7.5+T0.5", luminosity: 2e-05, massSun: 0.032 },
  { id: "wolf359", name: "Wolf 359", ra: 2.8644416406, dec: 0.1224299989, distanceLy: 7.856, pmRA: -3866.30, pmDec: -2699.20, rv: 19.32, spectralType: "M6.0V", luminosity: 0.0014, massSun: 0.09 },
  { id: "lalande21185", name: "Lalande 21185", ra: 2.8943522206, dec: 0.6277949319, distanceLy: 8.307, pmRA: -580.06, pmDec: -4776.59, rv: -85.11, spectralType: "M2.0V", luminosity: 0.021, massSun: 0.389 },
  { id: "sirius-a", name: "Sirius A", ra: 1.7677930939, dec: -0.2917511770, distanceLy: 8.611, pmRA: -546.01, pmDec: -1223.07, rv: -5.50, spectralType: "A1V", luminosity: 25.4, massSun: 2.063 },
  { id: "sirius-b", name: "Sirius B", ra: 1.7678003661, dec: -0.2917899621, distanceLy: 8.611, pmRA: -546.01, pmDec: -1223.07, rv: -5.50, spectralType: "DA2", luminosity: 0.056, massSun: 1.018, parentId: "sirius-a" },
  { id: "luyten726-8a", name: "Luyten 726-8 A", ra: 0.4320635285, dec: -0.3132914489, distanceLy: 8.728, pmRA: 3296.00, pmDec: 563.00, rv: 29.00, spectralType: "M5.5V", luminosity: 6e-05, massSun: 0.102 },
  { id: "luyten726-8b", name: "Luyten 726-8 B", ra: 0.4320635285, dec: -0.3132914489, distanceLy: 8.728, pmRA: 3296.00, pmDec: 563.00, rv: 29.00, spectralType: "M6.0V", luminosity: 4e-05, massSun: 0.1, parentId: "luyten726-8a" },
  { id: "ross154", name: "Ross 154", ra: 4.9297842831, dec: -0.4160186198, distanceLy: 9.7, pmRA: 639.37, pmDec: -193.96, rv: -10.50, spectralType: "M3.5V", luminosity: 0.0038, massSun: 0.17 },
  { id: "ross248", name: "Ross 248", ra: 6.2042600640, dec: 0.7710428303, distanceLy: 10.3, pmRA: 112.53, pmDec: -1591.65, rv: -77.29, spectralType: "M5.5V", luminosity: 0.0018, massSun: 0.136 },
  { id: "epsilon-eridani", name: "Epsilon Eridani", ra: 0.9290823941, dec: -0.1650790584, distanceLy: 10.475, pmRA: -975.17, pmDec: 19.49, rv: 15.50, spectralType: "K2V", luminosity: 0.34, massSun: 0.82 },
  { id: "lacaille9352", name: "Lacaille 9352", ra: 6.0469840817, dec: -0.6257538663, distanceLy: 10.742, pmRA: 6766.63, pmDec: 1326.66, rv: 9.50, spectralType: "M1.5V", luminosity: 0.033, massSun: 0.486 },
  { id: "ross128", name: "Ross 128", ra: 3.0880983120, dec: 0.0140402042, distanceLy: 11.007, pmRA: 607.30, pmDec: -1223.03, rv: -31.00, spectralType: "M4.0V", luminosity: 0.0036, massSun: 0.168 },
  { id: "ez-aquarii", name: "EZ Aquarii", ra: 5.9278217271, dec: -0.2670693125, distanceLy: 11.103, pmRA: 2314.00, pmDec: 2295.00, rv: -59.90, spectralType: "M5.0V", luminosity: 0.0006, massSun: 0.11 },
  { id: "procyon-a", name: "Procyon A", ra: 2.0040815858, dec: 0.0911934534, distanceLy: 11.402, pmRA: -714.59, pmDec: -1036.80, rv: -3.20, spectralType: "F5IV-V", luminosity: 6.93, massSun: 1.499 },
  { id: "procyon-b", name: "Procyon B", ra: 2.0041106746, dec: 0.0912370866, distanceLy: 11.402, pmRA: -714.59, pmDec: -1036.80, rv: -3.20, spectralType: "DQZ", luminosity: 0.00055, massSun: 0.602, parentId: "procyon-a" },
  { id: "61cyg-a", name: "61 Cygni A", ra: 5.5278868012, dec: 0.6763053889, distanceLy: 11.403, pmRA: 4164.17, pmDec: 3249.99, rv: -65.74, spectralType: "K5V", luminosity: 0.153, massSun: 0.7 },
  { id: "61cyg-b", name: "61 Cygni B", ra: 5.5279886120, dec: 0.6761744892, distanceLy: 11.403, pmRA: 4109.78, pmDec: 3144.28, rv: -64.07, spectralType: "K7V", luminosity: 0.085, massSun: 0.63, parentId: "61cyg-a" },
  { id: "struve2398a", name: "Struve 2398 A", ra: 4.8990446717, dec: 1.0407446811, distanceLy: 11.525, pmRA: -1332.03, pmDec: 1807.48, rv: -1.07, spectralType: "M3.0V", luminosity: 0.0029, massSun: 0.334 },
  { id: "struve2398b", name: "Struve 2398 B", ra: 4.8990592161, dec: 1.0406865035, distanceLy: 11.525, pmRA: -1338.68, pmDec: 1809.15, rv: 1.09, spectralType: "M3.5V", luminosity: 0.0014, massSun: 0.248, parentId: "struve2398a" },
  { id: "groombridge34a", name: "Groombridge 34 A", ra: 0.0802051513, dec: 0.7683472662, distanceLy: 11.624, pmRA: 2891.52, pmDec: 411.83, rv: 11.60, spectralType: "M1.5V", luminosity: 0.0064, massSun: 0.38 },
  { id: "groombridge34b", name: "Groombridge 34 B", ra: 0.0804160453, dec: 0.7684393808, distanceLy: 11.624, pmRA: 2891.52, pmDec: 411.83, rv: 11.60, spectralType: "M3.5V", luminosity: 0.0004, massSun: 0.15, parentId: "groombridge34a" },
  { id: "epsilon-indi", name: "Epsilon Indi", ra: 5.7742545695, dec: -0.9911046083, distanceLy: 11.867, pmRA: 3967.00, pmDec: -2538.00, rv: -40.40, spectralType: "K5V", luminosity: 0.22, massSun: 0.762 },
  { id: "tau-ceti", name: "Tau Ceti", ra: 0.4540837659, dec: -0.2781618495, distanceLy: 11.912, pmRA: -1721.05, pmDec: 854.16, rv: -16.40, spectralType: "G8.5V", luminosity: 0.52, massSun: 0.783 },
];

/** The navigable catalogue: the hand-curated nearest systems (≤ 12 ly) plus the
 *  generated notable additions out to ~26 ly (Altair, Vega, Fomalhaut, 40 Eridani,
 *  …). These are the only stars that are interstellar travel targets and the only
 *  ones in STAR_BY_ID — so flight code can never aim at a backdrop star. */
export const STARS: StarDef[] = [...SEEDS, ...NAVIGABLE_ADDITION_SEEDS].map((s) => ({
  ...s,
  pos: radecToEcliptic(s.ra, s.dec, s.distanceLy * LIGHT_YEAR),
  vel: starSpaceVelocity(s),
}));

export const STAR_BY_ID: Map<string, StarDef> = new Map(STARS.map((s) => [s.id, s]));

/** The distant backdrop: bright stars beyond ~26 ly down to mag ~4.0 (Betelgeuse,
 *  Rigel, the constellation-filling stars). A fixed celestial sphere in both the
 *  in-system and interstellar views — never simulated, never a travel target, so
 *  deliberately NOT in STAR_BY_ID. Velocity is zero (negligible drift at this range). */
export const BACKDROP_STARS: BackdropStar[] = BACKDROP_SEEDS.map((s) => ({
  ...s,
  pos: radecToEcliptic(s.ra, s.dec, s.distanceLy * LIGHT_YEAR),
  vel: { x: 0, y: 0, z: 0 },
}));

/** A star's analytic state at coordinate time t (seconds since J2000): the J2000
 *  position carried forward along its constant space velocity. Exact (a free star
 *  coasts in a straight line) and read-time — no integration. */
export interface StarState {
  r: Vec3;
  v: Vec3;
}
export function starState(star: StarDef, t: number): StarState {
  return { r: addScaled(star.pos, star.vel, t), v: star.vel };
}

/** Convenience: a star's ecliptic-J2000 position at coordinate time t. */
export function starPosition(star: StarDef, t: number): Vec3 {
  return addScaled(star.pos, star.vel, t);
}

/** Distance from the Sun to a star in AU at time t (default J2000) — a sanity
 *  bridge to in-system scale. */
export function starDistanceAU(star: StarDef, t = 0): number {
  return length(starPosition(star, t)) / AU;
}
