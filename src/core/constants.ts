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
/** Planck constant (J·s) — photon energy hν = hc/λ, sets detector shot noise. */
export const H_PLANCK = 6.62607015e-34;
/** Sensing band for IR detection (m). 10 µm — the thermal-IR window where warm
 *  (~300 K) hulls peak. */
export const IR_BAND_WAVELENGTH = 10e-6;
/** Photon energy of the IR sensing band (J): hν = hc/λ ≈ 1.99e-20 J at 10 µm. */
export const IR_BAND_PHOTON_J = (H_PLANCK * C) / IR_BAND_WAVELENGTH;
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

/** Default altitude (m) of the low parking orbit used as the capture target when
 *  planning an arrival; the real capture burn (Phase 4) uses the same value. */
export const DEFAULT_CAPTURE_ALT = 4e5; // 400 km

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

/**
 * Fixed heliocentric osculating Keplerian elements at the J2000 epoch, for the
 * small bodies (dwarf planets, asteroids) that have no published Standish-style
 * linear-rate fit. Units: a in AU, angles in degrees, M0 the mean anomaly at
 * J2000. The mean motion is DERIVED from MU_SUN (n = √(MU_SUN/a³)) rather than
 * stored, so a and M0 fully determine the motion — a pure two-body conic with
 * perturbations neglected (it drifts over decades, exactly like the Moon row),
 * but correct in character and exact in energy/period.
 *
 * IMPORTANT: `peri` here is the argument of perihelion ω, taken DIRECTLY from
 * the JPL Small-Body Database (field W), NOT the longitude of perihelion ϖ.
 * StandishRow stores ϖ and converts ϖ→ω in ephemeris.ts; this row needs no such
 * conversion. Do not "harmonise" the two — a Horizons vector test guards it.
 * Source: JPL Horizons / Small-Body DB osculating elements @ JD 2451545.0.
 */
export interface FixedHelioRow {
  a: number;   // AU
  e: number;
  i: number;   // deg
  node: number; // Ω, deg (longitude of ascending node)
  peri: number; // ω, deg (argument of perihelion)
  M0: number;  // mean anomaly at J2000, deg
}

/**
 * Exponential isothermal atmosphere: ρ(h) = ρ0·exp(−h/H), P(h) = P0·exp(−h/H).
 * A single-scale-height fit — a documented first-order approximation (real
 * atmospheres have a temperature-dependent, layered scale height). SI units.
 * Used by surface.ts for ascent drag losses and descent aerobraking estimates.
 */
export interface Atmosphere {
  surfacePressure: number; // P0, Pa
  surfaceDensity: number;  // ρ0, kg/m^3
  scaleHeight: number;     // H, m
}

export type BodyKind = "star" | "planet" | "dwarf" | "asteroid" | "moon" | "comet" | "satellite";

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
  helio?: FixedHelioRow; // heliocentric dwarfs/asteroids (fixed J2000 conic)
  /** Sidereal rotation period (s); negative ⇒ retrograde. Drives the equatorial
   *  surface speed a launch inherits / a landing must cancel (surface.ts). */
  rotationPeriod?: number;
  /** Axial tilt of the spin axis from the ecliptic +Z, in degrees. The diurnal
   *  rotation — and anything co-rotating with the surface (a landed ship, a launch
   *  pad) — turns about THIS tilted pole, which is also the pole the rendered globe
   *  spins about (render/bodyViews node tilt), so a pad stays fixed on the surface
   *  instead of drifting across it. Absent ⇒ 0 (pole along ecliptic +Z). */
  obliquityDeg?: number;
  /** Present only for bodies with a real atmosphere (ascent drag / aerobraking). */
  atmosphere?: Atmosphere;
  /** True for bodies with a solid surface to land on. The Sun and the gas giants
   *  have no surface, so landing/launch is physically impossible there. */
  hasSurface?: boolean;
  /** J2 zonal harmonic (oblateness) — the leading non-spherical gravity term. It
   *  drives the secular nodal/apsidal precession of orbits about this body
   *  (orbit.ts j2Rates). Absent ⇒ the body is treated as a point/sphere. */
  J2?: number;
  /** Equatorial radius (m) — the reference radius J2 is conventionally normalized
   *  to (j2Rates / sunSyncInclination, via j2RefRadius). DISTINCT from `radius`
   *  (the mean radius). Only meaningful for, and only set on, bodies that carry a
   *  J2; falls back to mean `radius` when absent. Do NOT use it for surface
   *  gravity, SOI, escape velocity, altitudes, or rendering — those use mean
   *  `radius`. For an oblate giant (Jupiter/Saturn) equatorial exceeds mean by
   *  several %, and the J2 rate (∝ R²) is wrong by ~5–7% if fed the mean radius. */
  equatorialRadius?: number;
}

// JPL Standish elements, valid 1800 AD – 2050 AD (no extra correction terms).
export const BODIES: BodyDef[] = [
  {
    id: "sun", name: "Sun", parent: null, mu: MU_SUN, radius: 6.957e8,
    kind: "star", color: 0xffd66b, hasSurface: false,
  },
  {
    id: "mercury", name: "Mercury", parent: "sun", mu: 2.2032e13, radius: 2.4397e6,
    kind: "planet", color: 0xa6855a,
    rotationPeriod: 5067360, hasSurface: true, J2: 5.03e-5, equatorialRadius: 2440500, // 58.646 d; trace exosphere ⇒ airless
    standish: {
      a: 0.38709927, aDot: 0.00000037, e: 0.20563593, eDot: 0.00001906,
      i: 7.00497902, iDot: -0.00594749, L: 252.25032350, LDot: 149472.67411175,
      peri: 77.45779628, periDot: 0.16047689, node: 48.33076593, nodeDot: -0.12534081,
    },
  },
  {
    id: "venus", name: "Venus", parent: "sun", mu: 3.24859e14, radius: 6.0518e6,
    kind: "planet", color: 0xd9b38c,
    rotationPeriod: -20996760, hasSurface: true, J2: 4.458e-6, equatorialRadius: 6051800, // retrograde, 243.025 d (Venus is near-spherical: eq ≈ mean)
    atmosphere: { surfacePressure: 9.2e6, surfaceDensity: 65, scaleHeight: 15900 },
    standish: {
      a: 0.72333566, aDot: 0.00000390, e: 0.00677672, eDot: -0.00004107,
      i: 3.39467605, iDot: -0.00078890, L: 181.97909950, LDot: 58517.81538729,
      peri: 131.60246718, periDot: 0.00268329, node: 76.67984255, nodeDot: -0.27769418,
    },
  },
  {
    id: "earth", name: "Earth", parent: "sun", mu: 3.986004418e14, radius: 6.371e6,
    kind: "planet", color: 0x4a90d9,
    rotationPeriod: 86164.0905, obliquityDeg: 23.44, hasSurface: true, J2: 1.08263e-3, equatorialRadius: 6378137, // sidereal day; eq radius WGS84
    atmosphere: { surfacePressure: 101325, surfaceDensity: 1.225, scaleHeight: 8500 },
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
    rotationPeriod: 2360591.5, hasSurface: true, J2: 2.034e-4, equatorialRadius: 1738100, // synchronous, 27.321661 d
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
    rotationPeriod: 88642.66, obliquityDeg: 25.19, hasSurface: true, J2: 1.96045e-3, equatorialRadius: 3396200, // 24.6229 h
    atmosphere: { surfacePressure: 610, surfaceDensity: 0.020, scaleHeight: 11100 },
    standish: {
      a: 1.52371034, aDot: 0.00001847, e: 0.09339410, eDot: 0.00007882,
      i: 1.84969142, iDot: -0.00813131, L: -4.55343205, LDot: 19140.30268499,
      peri: -23.94362959, periDot: 0.44441088, node: 49.55953891, nodeDot: -0.29257343,
    },
  },
  {
    id: "jupiter", name: "Jupiter", parent: "sun", mu: 1.26686534e17, radius: 6.9911e7,
    kind: "planet", color: 0xd8a878,
    rotationPeriod: 35730, obliquityDeg: 3.13, hasSurface: false, J2: 0.0146965, equatorialRadius: 71492000, // 9.925 h; no solid surface. J2 from Juno (Iess et al. 2018), referenced to eq radius 71492 km
    standish: {
      a: 5.20288700, aDot: -0.00011607, e: 0.04838624, eDot: -0.00013253,
      i: 1.30439695, iDot: -0.00183714, L: 34.39644051, LDot: 3034.74612775,
      peri: 14.72847983, periDot: 0.21252668, node: 100.47390909, nodeDot: 0.20469106,
    },
  },
  {
    id: "saturn", name: "Saturn", parent: "sun", mu: 3.7931187e16, radius: 5.8232e7,
    kind: "planet", color: 0xead6a8,
    rotationPeriod: 38362, obliquityDeg: 26.73, hasSurface: false, J2: 0.016298, equatorialRadius: 60268000, // 10.656 h; no solid surface; J2 ref eq radius 60268 km
    standish: {
      a: 9.53667594, aDot: -0.00125060, e: 0.05386179, eDot: -0.00050991,
      i: 2.48599187, iDot: 0.00193609, L: 49.95424423, LDot: 1222.49362201,
      peri: 92.59887831, periDot: -0.41897216, node: 113.66242448, nodeDot: -0.28867794,
    },
  },
  {
    id: "uranus", name: "Uranus", parent: "sun", mu: 5.793939e15, radius: 2.5362e7,
    kind: "planet", color: 0x9fd8e0,
    rotationPeriod: -62064, obliquityDeg: 97.77, hasSurface: false, J2: 0.003343, equatorialRadius: 25559000, // retrograde, 17.24 h; no solid surface
    standish: {
      a: 19.18916464, aDot: -0.00196176, e: 0.04725744, eDot: -0.00004397,
      i: 0.77263783, iDot: -0.00242939, L: 313.23810451, LDot: 428.48202785,
      peri: 170.95427630, periDot: 0.40805281, node: 74.01692503, nodeDot: 0.04240589,
    },
  },
  {
    id: "neptune", name: "Neptune", parent: "sun", mu: 6.836529e15, radius: 2.4622e7,
    kind: "planet", color: 0x4f7cdb,
    rotationPeriod: 57996, obliquityDeg: 28.32, hasSurface: false, J2: 0.003411, equatorialRadius: 24764000, // 16.11 h; no solid surface
    standish: {
      a: 30.06992276, aDot: 0.00026291, e: 0.00859048, eDot: 0.00005105,
      i: 1.77004347, iDot: 0.00035372, L: -55.12002969, LDot: 218.45945325,
      peri: 44.96476227, periDot: -0.32241464, node: 131.78422574, nodeDot: -0.00508664,
    },
  },
  {
    id: "ceres", name: "Ceres", parent: "sun", mu: 6.26284e10, radius: 4.697e5,
    kind: "dwarf", color: 0x9a8f80,
    rotationPeriod: 32667.0, hasSurface: true,
    helio: { a: 2.7664960200, e: 0.0783756264716304, i: 10.58336045805628, node: 80.49435747295276, peri: 73.92286274285223, M0: 6.176654513180486 },
  },
  {
    id: "pallas", name: "Pallas", parent: "sun", mu: 1.363e10, radius: 2.565e5,
    kind: "asteroid", color: 0x8a8a96,
    rotationPeriod: 28480.0, hasSurface: true,
    helio: { a: 2.7723224751, e: 0.2296435321697976, i: 34.84614003622473, node: 173.1977991340821, peri: 310.2656379003444, M0: 352.9602856167207 },
  },
  {
    id: "vesta", name: "Vesta", parent: "sun", mu: 1.728828e10, radius: 2.61385e5,
    kind: "asteroid", color: 0xa8a090,
    rotationPeriod: 19231.0, hasSurface: true,
    helio: { a: 2.3615349347, e: 0.09002244561937413, i: 7.133935828421654, node: 103.9514370845001, peri: 149.5866679599199, M0: 341.0238343838706 },
  },
  {
    // 433 Eros — the Mars-crossing NEA NEAR Shoemaker orbited and landed on (2001).
    // GM/radius from JPL; elements @ J2000 (Horizons, ecliptic-J2000, ω not ϖ).
    id: "eros", name: "433 Eros", parent: "sun", mu: 4.463e5, radius: 8.42e3,
    kind: "asteroid", color: 0x9a7b5a, rotationPeriod: 18972.0, hasSurface: true, // 5.27 h
    helio: { a: 1.458339407824060, e: 0.2227585463818351, i: 10.82844050869488, node: 304.4156610725765, peri: 178.6458706145036, M0: 57.69232527092141 },
  },
  {
    // 10 Hygiea — the fourth-largest main-belt asteroid (a dark C-type), rounding out
    // the "big four" with Ceres/Vesta/Pallas. GM ~7 km³/s² (Horizons).
    id: "hygiea", name: "10 Hygiea", parent: "sun", mu: 7e9, radius: 2.0356e5,
    kind: "asteroid", color: 0x5a5a55, rotationPeriod: 49780.8, hasSurface: true, // 13.83 h
    helio: { a: 3.138421324853723, e: 0.1194647926154634, i: 3.842651449337091, node: 283.6632054163321, peri: 314.3682343023398, M0: 339.2148139451292 },
  },
  {
    // 3 Juno — one of the first asteroids discovered (1804), a large S-type. Its GM is
    // not well measured; a representative estimate is used (nothing orbits it here).
    id: "juno", name: "3 Juno", parent: "sun", mu: 1.5e9, radius: 1.23298e5,
    kind: "asteroid", color: 0x9a8a72, rotationPeriod: 25956.0, hasSurface: true, // 7.21 h
    helio: { a: 2.668034901649998, e: 0.2584434725495511, i: 12.96742544316528, node: 170.1725855271043, peri: 248.0317243376480, M0: 240.2686465738877 },
  },
  {
    id: "pluto", name: "Pluto", parent: "sun", mu: 8.696e11, radius: 1.1883e6,
    kind: "dwarf", color: 0xd6b89a,
    rotationPeriod: -551856.7, hasSurface: true, atmosphere: { surfacePressure: 1.0, surfaceDensity: 8.4e-05, scaleHeight: 19000.0 },
    helio: { a: 39.2643374175, e: 0.2446745123195729, i: 17.15136439626299, node: 110.286929741788, peri: 113.76290248852, M0: 15.0232691500142 },
  },
  {
    id: "charon", name: "Charon", parent: "pluto", mu: 1.061e11, radius: 6.06e5,
    kind: "moon", color: 0x8a8278,
    rotationPeriod: 551778.7, hasSurface: true,
    moon: { a: 1.959576e7, e: 0.0001610672790944719, i: 112.8908097641467, node: 227.3916867008565, nodeDot: 0, peri: 172.5855027165132, periDot: 0, M0: 148.6651344828103, MDot: 56.37042275 },
  },
  {
    id: "haumea", name: "Haumea", parent: "sun", mu: 2.674e11, radius: 7.98e5,
    kind: "dwarf", color: 0xe8e0d8,
    rotationPeriod: 14102.0, hasSurface: true,
    helio: { a: 42.9092576609, e: 0.1999209495775153, i: 28.20614176692041, node: 121.9332385932473, peri: 240.5907776701779, M0: 189.5952699212157 },
  },
  {
    id: "makemake", name: "Makemake", parent: "sun", mu: 2.069e11, radius: 7.15e5,
    kind: "dwarf", color: 0xc97f5a,
    rotationPeriod: 80640.0, hasSurface: true,
    helio: { a: 45.3720577831, e: 0.1645232903298833, i: 29.00018553920377, node: 79.2749060739329, peri: 296.2809991935295, M0: 139.7201624508081 },
  },
  {
    id: "eris", name: "Eris", parent: "sun", mu: 1.108e12, radius: 1.163e6,
    kind: "dwarf", color: 0xd8d8d0,
    hasSurface: true,
    helio: { a: 68.1398686523, e: 0.4325050983099001, i: 43.74050564207168, node: 36.12852074096747, peri: 150.8448096449848, M0: 194.2903409988061 },
  },
  {
    id: "phobos", name: "Phobos", parent: "mars", mu: 7.087e5, radius: 1.108e4,
    kind: "moon", color: 0x6e655c,
    rotationPeriod: 27575.4, hasSurface: true,
    moon: { a: 9.37861e6, e: 0.01469841851969655, i: 26.05670195883539, node: 84.81514244056581, nodeDot: 0, peri: 342.7848642391356, periDot: 0, M0: 189.8224342278868, MDot: 1127.96185694 },
  },
  {
    id: "deimos", name: "Deimos", parent: "mars", mu: 9.615e4, radius: 6.2e3,
    kind: "moon", color: 0x6e655c,
    rotationPeriod: 109082.6, hasSurface: true,
    moon: { a: 2.345818e7, e: 0.0003299624878237082, i: 27.56936980386812, node: 83.66926662588133, nodeDot: 0, peri: 211.8947925261645, periDot: 0, M0: 5.093950813525924, MDot: 285.14161628 },
  },
  {
    id: "io", name: "Io", parent: "jupiter", mu: 5.959916e12, radius: 1.82149e6,
    kind: "moon", color: 0xe6d96b,
    rotationPeriod: 153048.6, hasSurface: true,
    moon: { a: 4.220364e8, e: 0.004715688921345897, i: 2.212617763556377, node: 336.8524452085695, nodeDot: 0, peri: 66.16488500283468, periDot: 0, M0: 335.153206478952, MDot: 203.22957277 },
  },
  {
    id: "europa", name: "Europa", parent: "jupiter", mu: 3.202712e12, radius: 1.5608e6,
    kind: "moon", color: 0xcdb89a,
    rotationPeriod: 306997.0, hasSurface: true,
    moon: { a: 6.712485e8, e: 0.009812823575576082, i: 1.790971209716447, node: 332.6287323572119, nodeDot: 0, peri: 254.6471423731226, periDot: 0, M0: 345.411036769848, MDot: 101.31694862 },
  },
  {
    id: "ganymede", name: "Ganymede", parent: "jupiter", mu: 9.887833e12, radius: 2.6312e6,
    kind: "moon", color: 0x9a8d7c,
    rotationPeriod: 618267.1, hasSurface: true,
    moon: { a: 1.070497e9, e: 0.001457215292672099, i: 2.214148041848081, node: 343.1728455275238, nodeDot: 0, peri: 319.8078127226449, periDot: 0, M0: 277.0487684461206, MDot: 50.30835017 },
  },
  {
    id: "callisto", name: "Callisto", parent: "jupiter", mu: 7.179283e12, radius: 2.4103e6,
    kind: "moon", color: 0x6b5d50,
    rotationPeriod: 1442112.9, hasSurface: true,
    moon: { a: 1.882773e9, e: 0.007439434600948234, i: 2.016916220859312, node: 337.9426103461244, nodeDot: 0, peri: 16.12689497888475, periDot: 0, M0: 85.11888858079212, MDot: 21.56835291 },
  },
  {
    id: "mimas", name: "Mimas", parent: "saturn", mu: 2.503489e9, radius: 1.982e5,
    kind: "moon", color: 0xc8c8c2,
    rotationPeriod: 81861.6, hasSurface: true,
    moon: { a: 1.860368e8, e: 0.02175634846415301, i: 27.00265761372071, node: 172.0569449519339, nodeDot: 0, peri: 108.7253838060412, periDot: 0, M0: 37.39805775106126, MDot: 379.95856308 },
  },
  {
    id: "enceladus", name: "Enceladus", parent: "saturn", mu: 7.210367e9, radius: 2.521e5,
    kind: "moon", color: 0xf0f4f8,
    rotationPeriod: 118766.9, hasSurface: true,
    moon: { a: 2.384199e8, e: 0.006351597350212341, i: 28.05202310549093, node: 169.5065956328603, nodeDot: 0, peri: 135.4830251984964, periDot: 0, M0: 6.953398474767734, MDot: 261.89123630 },
  },
  {
    id: "tethys", name: "Tethys", parent: "saturn", mu: 4.121e10, radius: 5.311e5,
    kind: "moon", color: 0xc8c8c2,
    rotationPeriod: 163444.7, hasSurface: true,
    moon: { a: 2.949803e8, e: 0.0009698778768676897, i: 27.22072909012297, node: 167.9977256763769, nodeDot: 0, peri: 158.0570744864902, periDot: 0, M0: 350.3828192477454, MDot: 190.30290229 },
  },
  {
    id: "dione", name: "Dione", parent: "saturn", mu: 7.3116e10, radius: 5.614e5,
    kind: "moon", color: 0xc2c2bc,
    rotationPeriod: 236765.9, hasSurface: true,
    moon: { a: 3.776522e8, e: 0.002928360145096942, i: 28.04139510566285, node: 169.470196786071, nodeDot: 0, peri: 164.9353995421455, periDot: 0, M0: 332.0565629313631, MDot: 131.37024771 },
  },
  {
    id: "rhea", name: "Rhea", parent: "saturn", mu: 1.5394e11, radius: 7.638e5,
    kind: "moon", color: 0xbcbcb4,
    rotationPeriod: 390548.6, hasSurface: true,
    moon: { a: 5.272253e8, e: 0.0008002149724314739, i: 28.24141737577452, node: 168.9842022220848, nodeDot: 0, peri: 165.7818213737295, periDot: 0, M0: 206.9021112955066, MDot: 79.64181841 },
  },
  {
    id: "titan", name: "Titan", parent: "saturn", mu: 8.97814e12, radius: 2.5747e6,
    kind: "moon", color: 0xd9a441,
    rotationPeriod: 1377851.2, hasSurface: true, atmosphere: { surfacePressure: 146700.0, surfaceDensity: 5.3, scaleHeight: 20000.0 },
    moon: { a: 1.221935e9, e: 0.02860066256432539, i: 27.71833887311165, node: 169.2391602866279, nodeDot: 0, peri: 164.4091285733822, periDot: 0, M0: 163.4361974944248, MDot: 22.57428131 },
  },
  {
    id: "iapetus", name: "Iapetus", parent: "saturn", mu: 1.2052e11, radius: 7.345e5,
    kind: "moon", color: 0x9a8c70,
    rotationPeriod: 6860020.9, hasSurface: true,
    moon: { a: 3.562567e9, e: 0.02786249162022612, i: 17.23820439459392, node: 139.6917551276544, nodeDot: 0, peri: 229.658395405145, periDot: 0, M0: 208.0175928163262, MDot: 4.53409694 },
  },
  {
    id: "miranda", name: "Miranda", parent: "uranus", mu: 4.3e9, radius: 2.358e5,
    kind: "moon", color: 0x8a9498,
    rotationPeriod: 122170.1, hasSurface: true,
    moon: { a: 1.298718e8, e: 0.001509798566639019, i: 97.25415391960598, node: 172.0875833032825, nodeDot: 0, peri: 261.0221270814858, periDot: 0, M0: 62.06189119864032, MDot: 254.59591482 },
  },
  {
    id: "ariel", name: "Ariel", parent: "uranus", mu: 8.343e10, radius: 5.789e5,
    kind: "moon", color: 0x9aa0a2,
    rotationPeriod: 217790.9, hasSurface: true,
    moon: { a: 1.909413e8, e: 0.001520812328868678, i: 97.719319228073, node: 167.6455486422633, nodeDot: 0, peri: 45.35674156751863, periDot: 0, M0: 152.7943682479845, MDot: 142.81587599 },
  },
  {
    id: "umbriel", name: "Umbriel", parent: "uranus", mu: 8.54e10, radius: 5.847e5,
    kind: "moon", color: 0x7a8488,
    rotationPeriod: 358131.1, hasSurface: true,
    moon: { a: 2.660122e8, e: 0.004170165145635332, i: 97.66606723745439, node: 167.6381821495947, nodeDot: 0, peri: 334.9516684490692, periDot: 0, M0: 271.2233789529364, MDot: 86.85088134 },
  },
  {
    id: "titania", name: "Titania", parent: "uranus", mu: 2.228e11, radius: 7.884e5,
    kind: "moon", color: 0x9a9490,
    rotationPeriod: 752231.4, hasSurface: true,
    moon: { a: 4.362927e8, e: 0.002479000317146799, i: 97.818368383812, node: 167.6178145945835, nodeDot: 0, peri: 202.1167721066045, periDot: 0, M0: 74.41677554285916, MDot: 41.34898001 },
  },
  {
    id: "oberon", name: "Oberon", parent: "uranus", mu: 2.0534e11, radius: 7.614e5,
    kind: "moon", color: 0x8a847e,
    rotationPeriod: 1163596.1, hasSurface: true,
    moon: { a: 5.835499e8, e: 0.0005523244847399845, i: 97.87585296035932, node: 167.7555265636234, nodeDot: 0, peri: 254.006725206052, periDot: 0, M0: 93.49629094330373, MDot: 26.73092468 },
  },
  {
    id: "triton", name: "Triton", parent: "neptune", mu: 1.428495e12, radius: 1.3526e6,
    kind: "moon", color: 0xd4c8b8,
    rotationPeriod: 507726.0, hasSurface: true,
    moon: { a: 3.547659e8, e: 6.368939270099938e-06, i: 130.2557894944188, node: 215.8516384153697, nodeDot: 0, peri: 74.71431790690689, periDot: 0, M0: 359.9145795589976, MDot: 61.26138326 },
  },
  {
    id: "quaoar", name: "Quaoar", parent: "sun", mu: 8e10, radius: 5.45e5,
    kind: "dwarf", color: 0xb89a86, hasSurface: true,
    helio: { a: 43.13300738, e: 0.0395100738, i: 8.00508947, node: 189.07999045, peri: 163.78549070, M0: 258.95550934 },
  },
  {
    id: "sedna", name: "Sedna", parent: "sun", mu: 5.3e10, radius: 4.95e5,
    kind: "dwarf", color: 0xa05030, hasSurface: true,
    helio: { a: 549.87326861, e: 0.8609804671, i: 11.92524942, node: 144.31692861, peri: 310.73286356, M0: 357.90147667 },
  },
  {
    id: "gonggong", name: "Gonggong", parent: "sun", mu: 1.17e11, radius: 6.15e5,
    kind: "dwarf", color: 0xa86a5a, hasSurface: true,
    helio: { a: 67.05123024, e: 0.4995732868, i: 30.71460913, node: 336.87541457, peri: 206.94088653, M0: 94.20399154 },
  },
  {
    id: "orcus", name: "Orcus", parent: "sun", mu: 4.2e10, radius: 4.55e5,
    kind: "dwarf", color: 0x9aa6b0, hasSurface: true,
    helio: { a: 39.26252229, e: 0.2257511424, i: 20.53929450, node: 268.45724311, peri: 73.75098678, M0: 150.04005960 },
  },
  {
    // (486958) Arrokoth — the cold-classical Kuiper-belt contact binary New Horizons
    // flew past in 2019, the most distant body ever explored. GM unmeasured (tiny);
    // radius ~10 km. Classed "asteroid" here (the taxonomy has no KBO kind).
    id: "arrokoth", name: "Arrokoth", parent: "sun", mu: 5e4, radius: 1.0e4,
    kind: "asteroid", color: 0x8a4a3a, rotationPeriod: 57304.8, hasSurface: true, // 15.92 h; 2014 MU69
    helio: { a: 44.07371295812492, e: 0.03971684377527177, i: 2.448398975784269, node: 159.2027822226525, peri: 189.4428790567422, M0: 278.0873839113186 },
  },
  {
    id: "halley", name: "1P/Halley", parent: "sun", mu: 1.5e4, radius: 5.5e3,
    kind: "comet", color: 0xcfd8e0, hasSurface: true,
    helio: { a: 17.92150741, e: 0.9672702024, i: 162.19604262, node: 59.50786535, peri: 112.44962203, M0: 65.84890058 },
  },
  {
    id: "encke", name: "2P/Encke", parent: "sun", mu: 7e2, radius: 2.4e3,
    kind: "comet", color: 0xcfd8e0, hasSurface: true,
    helio: { a: 2.21753963, e: 0.8470517263, i: 11.76429574, node: 334.62961233, peri: 186.47268752, M0: 284.74223251 },
  },

  // ── Major crewed/scientific satellites in Earth orbit ────────────────────────
  // Representative low-Earth-orbit elements (these are actively station-kept and
  // decay in reality, so a fixed J2000-anchored conic is a deliberate stand-in):
  // a/e/i are real, the J2 nodal/apsidal precession rates are derived from the
  // orbit, and the phase (node/peri/M0) is illustrative. mu/radius are the body's
  // own (negligible) — nothing patches into their gravity. hasSurface:false, so
  // landing/launch is disabled (you don't set down on a space station).
  {
    id: "iss", name: "ISS", parent: "earth", mu: 3.0e-5, radius: 54,
    kind: "satellite", color: 0xdfe6ef, hasSurface: false, // ~415 km, 51.64°
    moon: { a: 6.793e6, e: 0.0006, i: 51.64, node: 60.0, nodeDot: -4.948671, peri: 90.0, periDot: 3.690867, M0: 0.0, MDot: 5582.295740 },
  },
  {
    id: "hubble", name: "Hubble (HST)", parent: "earth", mu: 8.0e-7, radius: 7,
    kind: "satellite", color: 0xc8d0d8, hasSurface: false, // ~540 km, 28.47°
    moon: { a: 6.918e6, e: 0.0003, i: 28.47, node: 110.0, nodeDot: -6.576303, peri: 250.0, periDot: 10.712022, M0: 200.0, MDot: 5431.683128 },
  },
  {
    id: "tiangong", name: "Tiangong", parent: "earth", mu: 6.7e-6, radius: 30,
    kind: "satellite", color: 0xe8d0a0, hasSurface: false, // ~390 km, 41.47°
    moon: { a: 6.771e6, e: 0.0005, i: 41.47, node: 200.0, nodeDot: -6.043164, peri: 130.0, periDot: 7.287870, M0: 300.0, MDot: 5609.524408 },
  },
];

/** The reference radius the J2 secular rates are normalized to: a body's
 *  EQUATORIAL radius by convention, falling back to the mean `radius` when none is
 *  recorded. Use ONLY for J2 (orbit.ts j2Rates / sunSyncInclination); the mean
 *  `radius` remains correct for surface gravity, SOI, escape velocity, altitudes,
 *  and rendering. Structurally typed (not BodyDef) so callers can pass any body. */
export function j2RefRadius(body: { radius: number; equatorialRadius?: number }): number {
  return body.equatorialRadius ?? body.radius;
}

export const BODY_BY_ID: Map<string, BodyDef> = new Map(BODIES.map((b) => [b.id, b]));
