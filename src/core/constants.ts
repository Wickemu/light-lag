/**
 * Physical constants and real Solar-System body data.
 *
 * The one inviolable rule of this project: physics is not hand-waved. So the
 * numbers here are the real ones. Planetary motion uses the JPL "Keplerian
 * Elements for Approximate Positions of the Major Planets" (Standish), the same
 * low-precision ephemeris used for planetarium-grade accuracy (arc-minute level
 * over 1800–2050). Gravitational parameters are published mu = GM values, not
 * G*M — G is only known to ~4 significant figures and we refuse to throw away
 * precision we already have.
 *
 * SI units throughout: metres, seconds, kilograms, kelvin, watts, radians.
 */

// ── Fundamental constants ────────────────────────────────────────────────────
/** Speed of light in vacuum (m/s) — exact by definition. The hard ceiling on
 *  every signal, every command, every piece of telemetry in the game. */
export const C = 299_792_458;
/** Standard gravity (m/s^2) — DEFINES specific impulse (ve = Isp·g0). It is not
 *  the local gravitational field of anything. */
export const G0 = 9.80665;
/** Stefan–Boltzmann constant (W·m^-2·K^-4) — radiators and IR signatures. */
export const SIGMA = 5.670374419e-8;
/** Solar luminosity (W) — drives the 1/r^2 fall-off of solar power. */
export const L_SUN = 3.828e26;
/** Newtonian gravitational constant (m^3·kg^-1·s^-2) — used only where a raw
 *  mass is unavoidable; prefer mu directly. */
export const G = 6.67430e-11;

// ── Units & time ─────────────────────────────────────────────────────────────
/** Astronomical unit (m) — exact by IAU definition. */
export const AU = 1.495978707e11;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const DAY = 86_400; // s
export const JULIAN_YEAR = 365.25 * DAY; // s
export const JULIAN_CENTURY = 36_525 * DAY; // s
/** Julian Date of the J2000.0 epoch (2000-01-01 12:00 TT). Our sim clock t is
 *  seconds since this instant. */
export const J2000_JD = 2_451_545.0;

// ── Gravitational parameters mu = GM (m^3/s^2) ──────────────────────────────
export const MU_SUN = 1.327_124_400_18e20;

// ── Standish element table ───────────────────────────────────────────────────
/**
 * One row of the JPL approximate ephemeris. Units as published:
 *   a   in AU,          rates per Julian century
 *   e   dimensionless
 *   angles in DEGREES,  rates in degrees per Julian century
 * L is the mean longitude, peri is the longitude of perihelion (ϖ),
 * node is the longitude of the ascending node (Ω).
 */
export interface StandishRow {
  a: number; aDot: number;
  e: number; eDot: number;
  i: number; iDot: number;
  L: number; LDot: number;
  peri: number; periDot: number;
  node: number; nodeDot: number;
}

/** Simple precessing Keplerian elements for a moon, geocentric/parent-centric.
 *  Units: a in metres, angles in degrees, rates in degrees PER DAY. */
export interface MoonRow {
  a: number;
  e: number;
  i: number;
  node: number; nodeDot: number;
  peri: number; periDot: number; // argument of periapsis ω
  M0: number; MDot: number;       // mean anomaly
}

export type BodyKind = "star" | "planet" | "moon";

export interface BodyDef {
  id: string;
  name: string;
  parent: string | null;
  mu: number; // own GM (m^3/s^2)
  radius: number; // mean radius (m)
  kind: BodyKind;
  color: number; // render hint (hex RGB)
  standish?: StandishRow; // heliocentric planets
  moon?: MoonRow; // parent-centric moons
}

// JPL Standish elements, valid 1800 AD – 2050 AD (no extra correction terms).
export const BODIES: BodyDef[] = [
  {
    id: "sun", name: "Sun", parent: null, mu: MU_SUN, radius: 6.957e8,
    kind: "star", color: 0xffd66b,
  },
  {
    id: "mercury", name: "Mercury", parent: "sun", mu: 2.2032e13, radius: 2.4397e6,
    kind: "planet", color: 0xa6855a,
    standish: {
      a: 0.38709927, aDot: 0.00000037, e: 0.20563593, eDot: 0.00001906,
      i: 7.00497902, iDot: -0.00594749, L: 252.25032350, LDot: 149472.67411175,
      peri: 77.45779628, periDot: 0.16047689, node: 48.33076593, nodeDot: -0.12534081,
    },
  },
  {
    id: "venus", name: "Venus", parent: "sun", mu: 3.24859e14, radius: 6.0518e6,
    kind: "planet", color: 0xd9b38c,
    standish: {
      a: 0.72333566, aDot: 0.00000390, e: 0.00677672, eDot: -0.00004107,
      i: 3.39467605, iDot: -0.00078890, L: 181.97909950, LDot: 58517.81538729,
      peri: 131.60246718, periDot: 0.00268329, node: 76.67984255, nodeDot: -0.27769418,
    },
  },
  {
    id: "earth", name: "Earth", parent: "sun", mu: 3.986004418e14, radius: 6.371e6,
    kind: "planet", color: 0x4a90d9,
    // Standish "EM Bary" row; we treat it as Earth (the Earth–barycentre offset
    // of ~4670 km is far below visual relevance at 1 AU).
    standish: {
      a: 1.00000261, aDot: 0.00000562, e: 0.01671123, eDot: -0.00004392,
      i: -0.00001531, iDot: -0.01294668, L: 100.46457166, LDot: 35999.37244981,
      peri: 102.93768193, periDot: 0.32327364, node: 0.0, nodeDot: 0.0,
    },
  },
  {
    id: "moon", name: "Moon", parent: "earth", mu: 4.9028e12, radius: 1.7374e6,
    kind: "moon", color: 0x9a9a9a,
    // Mean precessing elements; a physically valid two-body Moon (perturbations
    // neglected — it will drift over years but is correct in character).
    moon: {
      a: 3.844e8, e: 0.0549, i: 5.145,
      node: 125.045, nodeDot: -0.0529539,
      peri: 318.308, periDot: 0.1643586,
      M0: 134.963, MDot: 13.064993,
    },
  },
  {
    id: "mars", name: "Mars", parent: "sun", mu: 4.282837e13, radius: 3.3895e6,
    kind: "planet", color: 0xc1440e,
    standish: {
      a: 1.52371034, aDot: 0.00001847, e: 0.09339410, eDot: 0.00007882,
      i: 1.84969142, iDot: -0.00813131, L: -4.55343205, LDot: 19140.30268499,
      peri: -23.94362959, periDot: 0.44441088, node: 49.55953891, nodeDot: -0.29257343,
    },
  },
  {
    id: "jupiter", name: "Jupiter", parent: "sun", mu: 1.26686534e17, radius: 6.9911e7,
    kind: "planet", color: 0xd8a878,
    standish: {
      a: 5.20288700, aDot: -0.00011607, e: 0.04838624, eDot: -0.00013253,
      i: 1.30439695, iDot: -0.00183714, L: 34.39644051, LDot: 3034.74612775,
      peri: 14.72847983, periDot: 0.21252668, node: 100.47390909, nodeDot: 0.20469106,
    },
  },
  {
    id: "saturn", name: "Saturn", parent: "sun", mu: 3.7931187e16, radius: 5.8232e7,
    kind: "planet", color: 0xead6a8,
    standish: {
      a: 9.53667594, aDot: -0.00125060, e: 0.05386179, eDot: -0.00050991,
      i: 2.48599187, iDot: 0.00193609, L: 49.95424423, LDot: 1222.49362201,
      peri: 92.59887831, periDot: -0.41897216, node: 113.66242448, nodeDot: -0.28867794,
    },
  },
  {
    id: "uranus", name: "Uranus", parent: "sun", mu: 5.793939e15, radius: 2.5362e7,
    kind: "planet", color: 0x9fd8e0,
    standish: {
      a: 19.18916464, aDot: -0.00196176, e: 0.04725744, eDot: -0.00004397,
      i: 0.77263783, iDot: -0.00242939, L: 313.23810451, LDot: 428.48202785,
      peri: 170.95427630, periDot: 0.40805281, node: 74.01692503, nodeDot: 0.04240589,
    },
  },
  {
    id: "neptune", name: "Neptune", parent: "sun", mu: 6.836529e15, radius: 2.4622e7,
    kind: "planet", color: 0x4f7cdb,
    standish: {
      a: 30.06992276, aDot: 0.00026291, e: 0.00859048, eDot: 0.00005105,
      i: 1.77004347, iDot: 0.00035372, L: -55.12002969, LDot: 218.45945325,
      peri: 44.96476227, periDot: -0.32241464, node: 131.78422574, nodeDot: -0.00508664,
    },
  },
];

export const BODY_BY_ID: Map<string, BodyDef> = new Map(BODIES.map((b) => [b.id, b]));
