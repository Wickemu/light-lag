/**
 * The nearest star systems — the first step toward interstellar play.
 *
 * Real measured data (J2000 RA/Dec + parallax distance) for the ~24 nearest
 * systems within ~12 light-years. Positions are converted ONCE at module load
 * from equatorial RA/Dec/distance to ECLIPTIC-J2000 Cartesian metres — the SAME
 * root frame the planetary ephemeris and the light-lag comms use — so distances,
 * light-times, and 3D placement all reuse the existing machinery unchanged.
 *
 * Stars are treated as fixed points: their proper motion (arcsec/yr) is real but
 * negligible over a single voyage at solar-system scale, and modelling it is a
 * documented future refinement. Binary/multiple components carry a parentId.
 *
 * SI throughout (metres, radians, seconds). Luminosity in L_sun, mass in M_sun.
 */

import { type Vec3 } from "./math/vec3.ts";
import { AU, C, JULIAN_YEAR } from "./constants.ts";

/** One light-year in metres (derived, exact): c · one Julian year. */
export const LIGHT_YEAR = C * JULIAN_YEAR;

/** Obliquity of the ecliptic at J2000 (rad) — the equatorial→ecliptic tilt. */
const OBLIQUITY = (23.4392911 * Math.PI) / 180;

/**
 * Equatorial RA/Dec/distance → ecliptic-J2000 Cartesian metres. Build the unit
 * direction in the equatorial frame, rotate by the obliquity about the x-axis
 * (vernal equinox) into the ecliptic frame, then scale by distance. Exact.
 */
export function radecToEcliptic(ra: number, dec: number, distanceM: number): Vec3 {
  const xe = Math.cos(dec) * Math.cos(ra);
  const ye = Math.cos(dec) * Math.sin(ra);
  const ze = Math.sin(dec);
  const co = Math.cos(OBLIQUITY), so = Math.sin(OBLIQUITY);
  return {
    x: distanceM * xe,
    y: distanceM * (ye * co + ze * so),
    z: distanceM * (-ye * so + ze * co),
  };
}

/** A star (or stellar component) with real measured data. `pos` is derived at
 *  module load — do not hand-set it. */
export interface StarDef {
  id: string;
  name: string;
  ra: number; // J2000 right ascension (rad)
  dec: number; // J2000 declination (rad)
  distanceLy: number; // light-years (from parallax)
  pos: Vec3; // ecliptic-J2000 Cartesian metres (DERIVED)
  spectralType: string;
  luminosity: number; // L_sun
  massSun: number; // M_sun
  parentId?: string; // for binary/multiple components
}

type StarSeed = Omit<StarDef, "pos">;

const SEEDS: StarSeed[] = [
  { id: "proxima", name: "Proxima Centauri", ra: 3.7948475760, dec: -1.0939626789, distanceLy: 4.2465, spectralType: "M5.5Ve", luminosity: 0.0017, massSun: 0.1221, parentId: "alpha-cen-a" },
  { id: "alpha-cen-a", name: "Alpha Centauri A", ra: 3.8380153862, dec: -1.0617516579, distanceLy: 4.365, spectralType: "G2V", luminosity: 1.519, massSun: 1.0788 },
  { id: "alpha-cen-b", name: "Alpha Centauri B", ra: 3.8379135753, dec: -1.0618098355, distanceLy: 4.365, spectralType: "K1V", luminosity: 0.5, massSun: 0.9092, parentId: "alpha-cen-a" },
  { id: "barnard", name: "Barnard's Star", ra: 4.7028260305, dec: 0.0819141196, distanceLy: 5.963, spectralType: "M4.0V", luminosity: 0.0035, massSun: 0.144 },
  { id: "luhman16", name: "Luhman 16", ra: 2.8329311754, dec: -0.9305804683, distanceLy: 6.5, spectralType: "L7.5+T0.5", luminosity: 2e-05, massSun: 0.032 },
  { id: "wolf359", name: "Wolf 359", ra: 2.8644416406, dec: 0.1224299989, distanceLy: 7.856, spectralType: "M6.0V", luminosity: 0.0014, massSun: 0.09 },
  { id: "lalande21185", name: "Lalande 21185", ra: 2.8943522206, dec: 0.6277949319, distanceLy: 8.307, spectralType: "M2.0V", luminosity: 0.021, massSun: 0.389 },
  { id: "sirius-a", name: "Sirius A", ra: 1.7677930939, dec: -0.2917511770, distanceLy: 8.611, spectralType: "A1V", luminosity: 25.4, massSun: 2.063 },
  { id: "sirius-b", name: "Sirius B", ra: 1.7678003661, dec: -0.2917899621, distanceLy: 8.611, spectralType: "DA2", luminosity: 0.056, massSun: 1.018, parentId: "sirius-a" },
  { id: "luyten726-8a", name: "Luyten 726-8 A", ra: 0.4320635285, dec: -0.3132914489, distanceLy: 8.728, spectralType: "M5.5V", luminosity: 6e-05, massSun: 0.102 },
  { id: "luyten726-8b", name: "Luyten 726-8 B", ra: 0.4320635285, dec: -0.3132914489, distanceLy: 8.728, spectralType: "M6.0V", luminosity: 4e-05, massSun: 0.1, parentId: "luyten726-8a" },
  { id: "ross154", name: "Ross 154", ra: 4.9297842831, dec: -0.4160186198, distanceLy: 9.7, spectralType: "M3.5V", luminosity: 0.0038, massSun: 0.17 },
  { id: "ross248", name: "Ross 248", ra: 6.2042600640, dec: 0.7710428303, distanceLy: 10.3, spectralType: "M5.5V", luminosity: 0.0018, massSun: 0.136 },
  { id: "epsilon-eridani", name: "Epsilon Eridani", ra: 0.9290823941, dec: -0.1650790584, distanceLy: 10.475, spectralType: "K2V", luminosity: 0.34, massSun: 0.82 },
  { id: "lacaille9352", name: "Lacaille 9352", ra: 6.0469840817, dec: -0.6257538663, distanceLy: 10.742, spectralType: "M1.5V", luminosity: 0.033, massSun: 0.486 },
  { id: "ross128", name: "Ross 128", ra: 3.0880983120, dec: 0.0140402042, distanceLy: 11.007, spectralType: "M4.0V", luminosity: 0.0036, massSun: 0.168 },
  { id: "ez-aquarii", name: "EZ Aquarii", ra: 5.9278217271, dec: -0.2670693125, distanceLy: 11.103, spectralType: "M5.0V", luminosity: 0.0006, massSun: 0.11 },
  { id: "procyon-a", name: "Procyon A", ra: 2.0040815858, dec: 0.0911934534, distanceLy: 11.402, spectralType: "F5IV-V", luminosity: 6.93, massSun: 1.499 },
  { id: "procyon-b", name: "Procyon B", ra: 2.0041106746, dec: 0.0912370866, distanceLy: 11.402, spectralType: "DQZ", luminosity: 0.00055, massSun: 0.602, parentId: "procyon-a" },
  { id: "61cyg-a", name: "61 Cygni A", ra: 5.5278868012, dec: 0.6763053889, distanceLy: 11.403, spectralType: "K5V", luminosity: 0.153, massSun: 0.7 },
  { id: "61cyg-b", name: "61 Cygni B", ra: 5.5279886120, dec: 0.6761744892, distanceLy: 11.403, spectralType: "K7V", luminosity: 0.085, massSun: 0.63, parentId: "61cyg-a" },
  { id: "struve2398a", name: "Struve 2398 A", ra: 4.8990446717, dec: 1.0407446811, distanceLy: 11.525, spectralType: "M3.0V", luminosity: 0.0029, massSun: 0.334 },
  { id: "struve2398b", name: "Struve 2398 B", ra: 4.8990592161, dec: 1.0406865035, distanceLy: 11.525, spectralType: "M3.5V", luminosity: 0.0014, massSun: 0.248, parentId: "struve2398a" },
  { id: "groombridge34a", name: "Groombridge 34 A", ra: 0.0802051513, dec: 0.7683472662, distanceLy: 11.624, spectralType: "M1.5V", luminosity: 0.0064, massSun: 0.38 },
  { id: "groombridge34b", name: "Groombridge 34 B", ra: 0.0804160453, dec: 0.7684393808, distanceLy: 11.624, spectralType: "M3.5V", luminosity: 0.0004, massSun: 0.15, parentId: "groombridge34a" },
  { id: "epsilon-indi", name: "Epsilon Indi", ra: 5.7742545695, dec: -0.9911046083, distanceLy: 11.867, spectralType: "K5V", luminosity: 0.22, massSun: 0.762 },
  { id: "tau-ceti", name: "Tau Ceti", ra: 0.4540837659, dec: -0.2781618495, distanceLy: 11.912, spectralType: "G8.5V", luminosity: 0.52, massSun: 0.783 },
];

export const STARS: StarDef[] = SEEDS.map((s) => ({
  ...s,
  pos: radecToEcliptic(s.ra, s.dec, s.distanceLy * LIGHT_YEAR),
}));

export const STAR_BY_ID: Map<string, StarDef> = new Map(STARS.map((s) => [s.id, s]));

/** Distance from the Sun to a star in AU (a sanity bridge to in-system scale). */
export function starDistanceAU(star: StarDef): number {
  return (star.distanceLy * LIGHT_YEAR) / AU;
}
