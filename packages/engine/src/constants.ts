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

/**
 * Heliocentric dynamical region — the small-body POPULATION a body belongs to.
 * Purely a grouping tag (it has no effect on the physics): the navigator uses it
 * to gather the belt / Kuiper / Oort populations into sections that can be shown
 * or hidden as a unit. Set only on heliocentric small bodies (asteroids & the
 * large TNOs we model as "dwarf"); planets, moons, satellites and comets are
 * grouped by kind instead, so they carry no region.
 */
export type BodyRegion =
  | "near_earth" // near-Earth asteroids (Aten/Apollo/Amor)
  | "main_belt"  // the main asteroid belt, ~2.1–3.5 AU
  | "trojan"     // Jupiter's L4/L5 Trojan swarms, co-orbital at ~5.2 AU
  | "kuiper"     // the Kuiper belt — classical & resonant trans-Neptunian objects
  | "scattered"  // the scattered disc — high-eccentricity TNOs flung by Neptune
  | "oort";      // detached / inner-Oort-cloud bodies (sparsely sampled)

export interface BodyDef {
  id: string;
  name: string;
  parent: string | null;
  mu: number; // own GM (m^3/s^2)
  radius: number; // mean radius (m)
  kind: BodyKind;
  /** Heliocentric small-body population, for the navigator's region grouping. Only
   *  set on heliocentric asteroids / large TNOs; never on planets, moons, satellites
   *  or comets. Has no effect on the physics — see BodyRegion. */
  region?: BodyRegion;
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
  /** This body's orbit row tracks the BARYCENTRE of itself and the named
   *  co-orbiting satellite, not its own centre — so ephemeris.ts shifts the body
   *  off the barycentre by the satellite's mass fraction f = μ_sat/(μ_body+μ_sat).
   *  Earth↔Moon (barycentre ~4670 km, inside Earth) and Pluto↔Charon (barycentre
   *  ~2130 km, ABOVE Pluto's surface — a true binary). The satellite's own row is
   *  parent-centre-relative, so the chain recombines to the original barycentre. */
  barycenterChild?: string;
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
    // Standish "EM Bary" row: the Earth–Moon barycentre. ephemeris.ts shifts it to
    // Earth's true centre via barycenterChild (the ~4670 km offset sits inside Earth).
    barycenterChild: "moon",
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
    kind: "dwarf", region: "main_belt", color: 0x9a8f80,
    rotationPeriod: 32667.0, hasSurface: true,
    helio: { a: 2.7664960200, e: 0.0783756264716304, i: 10.58336045805628, node: 80.49435747295276, peri: 73.92286274285223, M0: 6.176654513180486 },
  },
  {
    id: "pallas", name: "Pallas", parent: "sun", mu: 1.363e10, radius: 2.565e5,
    kind: "asteroid", region: "main_belt", color: 0x8a8a96,
    rotationPeriod: 28480.0, hasSurface: true,
    helio: { a: 2.7723224751, e: 0.2296435321697976, i: 34.84614003622473, node: 173.1977991340821, peri: 310.2656379003444, M0: 352.9602856167207 },
  },
  {
    id: "vesta", name: "Vesta", parent: "sun", mu: 1.728828e10, radius: 2.61385e5,
    kind: "asteroid", region: "main_belt", color: 0xa8a090,
    rotationPeriod: 19231.0, hasSurface: true,
    helio: { a: 2.3615349347, e: 0.09002244561937413, i: 7.133935828421654, node: 103.9514370845001, peri: 149.5866679599199, M0: 341.0238343838706 },
  },
  {
    // 433 Eros — the Mars-crossing NEA NEAR Shoemaker orbited and landed on (2001).
    // GM/radius from JPL; elements @ J2000 (Horizons, ecliptic-J2000, ω not ϖ).
    id: "eros", name: "433 Eros", parent: "sun", mu: 4.463e5, radius: 8.42e3,
    kind: "asteroid", region: "near_earth", color: 0x9a7b5a, rotationPeriod: 18972.0, hasSurface: true, // 5.27 h
    helio: { a: 1.458339407824060, e: 0.2227585463818351, i: 10.82844050869488, node: 304.4156610725765, peri: 178.6458706145036, M0: 57.69232527092141 },
  },
  {
    // 10 Hygiea — the fourth-largest main-belt asteroid (a dark C-type), rounding out
    // the "big four" with Ceres/Vesta/Pallas. GM ~7 km³/s² (Horizons).
    id: "hygiea", name: "10 Hygiea", parent: "sun", mu: 7e9, radius: 2.0356e5,
    kind: "asteroid", region: "main_belt", color: 0x5a5a55, rotationPeriod: 49780.8, hasSurface: true, // 13.83 h
    helio: { a: 3.138421324853723, e: 0.1194647926154634, i: 3.842651449337091, node: 283.6632054163321, peri: 314.3682343023398, M0: 339.2148139451292 },
  },
  {
    // 3 Juno — one of the first asteroids discovered (1804), a large S-type. Its GM is
    // not well measured; a representative estimate is used (nothing orbits it here).
    id: "juno", name: "3 Juno", parent: "sun", mu: 1.5e9, radius: 1.23298e5,
    kind: "asteroid", region: "main_belt", color: 0x9a8a72, rotationPeriod: 25956.0, hasSurface: true, // 7.21 h
    helio: { a: 2.668034901649998, e: 0.2584434725495511, i: 12.96742544316528, node: 170.1725855271043, peri: 248.0317243376480, M0: 240.2686465738877 },
  },
  {
    id: "pluto", name: "Pluto", parent: "sun", mu: 8.696e11, radius: 1.1883e6,
    kind: "dwarf", region: "kuiper", color: 0xd6b89a,
    rotationPeriod: -551856.7, hasSurface: true, atmosphere: { surfacePressure: 1.0, surfaceDensity: 8.4e-05, scaleHeight: 19000.0 },
    // The helio row is the Pluto–Charon system barycentre (JPL body 9); ephemeris.ts
    // shifts Pluto to its true centre via barycenterChild. The barycentre lies
    // ~2130 km from Pluto's centre — above its 1188 km surface — so the pair reads
    // as a true binary (bodyViews draws Pluto's loop about that external point).
    barycenterChild: "charon",
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
    kind: "dwarf", region: "kuiper", color: 0xe8e0d8,
    rotationPeriod: 14102.0, hasSurface: true,
    helio: { a: 42.9092576609, e: 0.1999209495775153, i: 28.20614176692041, node: 121.9332385932473, peri: 240.5907776701779, M0: 189.5952699212157 },
  },
  {
    id: "makemake", name: "Makemake", parent: "sun", mu: 2.069e11, radius: 7.15e5,
    kind: "dwarf", region: "kuiper", color: 0xc97f5a,
    rotationPeriod: 80640.0, hasSurface: true,
    helio: { a: 45.3720577831, e: 0.1645232903298833, i: 29.00018553920377, node: 79.2749060739329, peri: 296.2809991935295, M0: 139.7201624508081 },
  },
  {
    id: "eris", name: "Eris", parent: "sun", mu: 1.108e12, radius: 1.163e6,
    kind: "dwarf", region: "scattered", color: 0xd8d8d0,
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
    kind: "dwarf", region: "kuiper", color: 0xb89a86, hasSurface: true,
    helio: { a: 43.13300738, e: 0.0395100738, i: 8.00508947, node: 189.07999045, peri: 163.78549070, M0: 258.95550934 },
  },
  {
    id: "sedna", name: "Sedna", parent: "sun", mu: 5.3e10, radius: 4.95e5,
    kind: "dwarf", region: "oort", color: 0xa05030, hasSurface: true,
    helio: { a: 549.87326861, e: 0.8609804671, i: 11.92524942, node: 144.31692861, peri: 310.73286356, M0: 357.90147667 },
  },
  {
    id: "gonggong", name: "Gonggong", parent: "sun", mu: 1.17e11, radius: 6.15e5,
    kind: "dwarf", region: "scattered", color: 0xa86a5a, hasSurface: true,
    helio: { a: 67.05123024, e: 0.4995732868, i: 30.71460913, node: 336.87541457, peri: 206.94088653, M0: 94.20399154 },
  },
  {
    id: "orcus", name: "Orcus", parent: "sun", mu: 4.2e10, radius: 4.55e5,
    kind: "dwarf", region: "kuiper", color: 0x9aa6b0, hasSurface: true,
    helio: { a: 39.26252229, e: 0.2257511424, i: 20.53929450, node: 268.45724311, peri: 73.75098678, M0: 150.04005960 },
  },
  {
    // (486958) Arrokoth — the cold-classical Kuiper-belt contact binary New Horizons
    // flew past in 2019, the most distant body ever explored. GM unmeasured (tiny);
    // radius ~10 km. Classed "asteroid" here (the taxonomy has no KBO kind).
    id: "arrokoth", name: "Arrokoth", parent: "sun", mu: 5e4, radius: 1.0e4,
    kind: "asteroid", region: "kuiper", color: 0x8a4a3a, rotationPeriod: 57304.8, hasSurface: true, // 15.92 h; 2014 MU69
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

  // ── Expanded body set: more moons & small bodies (real JPL Horizons data) ────
  // Generated from JPL Horizons geometric state vectors @ J2000 (ECLIPTIC / mean
  // equinox J2000), converted to osculating Keplerian elements the same way the
  // bodies above are — exact at the epoch, a pure two-body conic thereafter (the
  // documented FixedHelioRow/MoonRow approximation). GM & mean radius are Horizons
  // physical parameters where published; where a tiny body has no measured GM it is
  // estimated from the radius and an assumed bulk density (mass matters only for a
  // body something orbits, which none of these are). Regular moons are tidally
  // locked (rotationPeriod = orbital period); captured / chaotic irregulars whose
  // spin is unknown carry no rotationPeriod. Cross-checked against Horizons at the
  // epoch in fixtures/horizons.ts (HORIZONS_ADDED_*).

  // ── Jupiter's lesser moons (inner 'Amalthea group' + classical irregulars) ──
  {
    id: "metis", name: "Metis", parent: "jupiter", mu: 2.500000e+6, radius: 2.150000e+4,
    kind: "moon", color: 0x8a7a6a,
    rotationPeriod: 25827.5, hasSurface: true,
    moon: { a: 1.288780e+8, e: 0.006129080250241762, i: 2.217168421004586, node: 337.6541522842064, nodeDot: 0, peri: 188.55787973919206, periDot: 0, M0: 358.02074829723546, MDot: 1204.296779482265 },
  },
  {
    id: "adrastea", name: "Adrastea", parent: "jupiter", mu: 1.000000e+5, radius: 8.200000e+3,
    kind: "moon", color: 0x9a8a7a,
    rotationPeriod: 26127.7, hasSurface: true,
    moon: { a: 1.298746e+8, e: 0.0074602898197227326, i: 2.2096694594538, node: 337.7408049825866, nodeDot: 0, peri: 233.8229063526655, periDot: 0, M0: 1.111373981686721, MDot: 1190.4607128233235 },
  },
  {
    id: "amalthea", name: "Amalthea", parent: "jupiter", mu: 1.646000e+8, radius: 8.350000e+4,
    kind: "moon", color: 0x9a5a44,
    rotationPeriod: 43342.1, hasSurface: true,
    moon: { a: 1.819967e+8, e: 0.0061314814421850215, i: 2.4420891336377113, node: 330.4106584847095, nodeDot: 0, peri: 105.11764759120601, periDot: 0, M0: 336.2663452674131, MDot: 717.6393126543602 },
  },
  {
    id: "thebe", name: "Thebe", parent: "jupiter", mu: 3.010000e+7, radius: 4.930000e+4,
    kind: "moon", color: 0x8a6a5a,
    rotationPeriod: 58542.3, hasSurface: true,
    moon: { a: 2.223838e+8, e: 0.015243532174486454, i: 3.2842578738214443, node: 338.0945696328999, nodeDot: 0, peri: 26.729525958444597, periDot: 0, M0: 182.49251247685294, MDot: 531.3085436582496 },
  },
  {
    id: "himalia", name: "Himalia", parent: "jupiter", mu: 1.515520e+8, radius: 8.500000e+4,
    kind: "moon", color: 0x5e554c,
    rotationPeriod: 28015.2, hasSurface: true,
    moon: { a: 1.137211e+10, e: 0.166199967829006, i: 30.24690236958536, node: 64.19218276806915, nodeDot: 0, peri: 321.13985978331, periDot: 0, M0: 78.24220120282057, MDot: 1.4529139206953408 },
  },
  {
    id: "elara", name: "Elara", parent: "jupiter", mu: 4.652085e+7, radius: 4.000000e+4,
    kind: "moon", color: 0x5a5048,
    hasSurface: true,
    moon: { a: 1.174117e+10, e: 0.22186598843000158, i: 28.91229539610507, node: 112.7974917676072, nodeDot: 0, peri: 129.9137723759315, periDot: 0, M0: 346.90668105859623, MDot: 1.3849520401477047 },
  },
  {
    id: "pasiphae", name: "Pasiphae", parent: "jupiter", mu: 4.239213e+6, radius: 1.800000e+4,
    kind: "moon", color: 0x544b44,
    hasSurface: true,
    moon: { a: 2.342524e+10, e: 0.37953951038828637, i: 140.08742101592168, node: 315.7488905940656, nodeDot: 0, peri: 172.82935043548275, periDot: 0, M0: 279.2244898378189, MDot: 0.49144566147436863 },
  },
  {
    id: "sinope", name: "Sinope", parent: "jupiter", mu: 1.994582e+6, radius: 1.400000e+4,
    kind: "moon", color: 0x544b44,
    hasSurface: true,
    moon: { a: 2.296878e+10, e: 0.316414592428353, i: 152.13733767925686, node: 308.0215445965139, nodeDot: 0, peri: 354.2787747727065, periDot: 0, M0: 157.45056457198137, MDot: 0.5061679536141991 },
  },
  {
    id: "carme", name: "Carme", parent: "jupiter", mu: 2.453248e+6, radius: 1.500000e+4,
    kind: "moon", color: 0x504842,
    hasSurface: true,
    moon: { a: 2.420289e+10, e: 0.24247879942278258, i: 164.72283776113824, node: 115.49890266170387, nodeDot: 0, peri: 6.482509699264487, periDot: 0, M0: 259.4765045266816, MDot: 0.4679513306875565 },
  },
  {
    id: "ananke", name: "Ananke", parent: "jupiter", mu: 7.268883e+5, radius: 1.000000e+4,
    kind: "moon", color: 0x544b44,
    hasSurface: true,
    moon: { a: 2.168383e+10, e: 0.3803569915939057, i: 151.6548695520142, node: 13.692785712429641, nodeDot: 0, peri: 78.71995065427103, periDot: 0, M0: 271.8197028328203, MDot: 0.5518202800909617 },
  },

  // ── Saturn's lesser moons (ring shepherds, co-orbitals, Hyperion, Phoebe) ──
  {
    id: "pan", name: "Pan", parent: "saturn", mu: 5.974877e+5, radius: 1.720000e+4,
    kind: "moon", color: 0xc8c2b4,
    rotationPeriod: 50190.3, hasSurface: true,
    moon: { a: 1.342637e+8, e: 0.005064185722853172, i: 28.051412531625008, node: 169.52667174506377, nodeDot: 0, peri: 106.68603885913673, periDot: 0, M0: 359.93405972439416, MDot: 619.721703732936 },
  },
  {
    id: "atlas", name: "Atlas", parent: "saturn", mu: 1.107934e+6, radius: 2.050000e+4,
    kind: "moon", color: 0xccc6b8,
    rotationPeriod: 52484.4, hasSurface: true,
    moon: { a: 1.383245e+8, e: 0.005197047403978028, i: 28.04811529260849, node: 169.52532271405752, nodeDot: 0, peri: 345.4176061726043, periDot: 0, M0: 347.6264201580408, MDot: 592.6332162460523 },
  },
  {
    id: "prometheus", name: "Prometheus", parent: "saturn", mu: 4.256853e+7, radius: 6.820000e+4,
    kind: "moon", color: 0xc6c0b2,
    rotationPeriod: 53456.3, hasSurface: true,
    moon: { a: 1.400269e+8, e: 0.004807727874694179, i: 28.051837901645154, node: 169.51030329057767, nodeDot: 0, peri: 28.895653572116004, periDot: 0, M0: 26.82162826278383, MDot: 581.8585201649565 },
  },
  {
    id: "pandora", name: "Pandora", parent: "saturn", mu: 1.948507e+7, radius: 5.220000e+4,
    kind: "moon", color: 0xc6c0b2,
    rotationPeriod: 54791.1, hasSurface: true,
    moon: { a: 1.423483e+8, e: 0.004055569084580726, i: 28.03601467542509, node: 169.6291296360357, nodeDot: 0, peri: 238.52464511938828, periDot: 0, M0: 58.805964258391676, MDot: 567.6832218220602 },
  },
  {
    id: "epimetheus", name: "Epimetheus", parent: "saturn", mu: 4.891121e+7, radius: 6.490000e+4,
    kind: "moon", color: 0xc2bcae,
    rotationPeriod: 60500.6, hasSurface: true,
    moon: { a: 1.520729e+8, e: 0.0060319489642798015, i: 27.738155579322473, node: 169.87376984949768, nodeDot: 0, peri: 230.58522252177252, periDot: 0, M0: 198.16618275910764, MDot: 514.1107899772381 },
  },
  {
    id: "janus", name: "Janus", parent: "saturn", mu: 1.852669e+8, radius: 1.017000e+5,
    kind: "moon", color: 0xc8c2b4,
    rotationPeriod: 60477.4, hasSurface: true,
    moon: { a: 1.520341e+8, e: 0.0061667012166364945, i: 27.984140892013976, node: 169.84949571349446, nodeDot: 0, peri: 163.91249391823555, periDot: 0, M0: 79.73670555764207, MDot: 514.3077302353964 },
  },
  {
    id: "hyperion", name: "Hyperion", parent: "saturn", mu: 3.705000e+8, radius: 1.330000e+5,
    kind: "moon", color: 0xa89878,
    hasSurface: true,
    moon: { a: 1.485061e+9, e: 0.12673097307977235, i: 27.209029032805148, node: 168.30501399176194, nodeDot: 0, peri: 188.69349725709193, periDot: 0, M0: 70.60363385153528, MDot: 16.846820629729677 },
  },
  {
    id: "phoebe", name: "Phoebe", parent: "saturn", mu: 5.548000e+8, radius: 1.066000e+5,
    kind: "moon", color: 0x4a4642,
    rotationPeriod: 33384.6, hasSurface: true,
    moon: { a: 1.294379e+10, e: 0.16540540240444196, i: 173.25871204685865, node: 263.1990084749371, nodeDot: 0, peri: 353.7302013137559, periDot: 0, M0: 58.64886724751783, MDot: 0.6546999483862554 },
  },

  // ── Uranus's lesser moons (Puck-group inner + irregular Caliban/Sycorax) ──
  {
    id: "puck", name: "Puck", parent: "uranus", mu: 1.659242e+8, radius: 7.700000e+4,
    kind: "moon", color: 0x8a8e92,
    rotationPeriod: -65893.7, hasSurface: true,
    moon: { a: 8.605326e+7, e: 0.009538150369986686, i: 97.68078194074853, node: 166.58881138552474, nodeDot: 0, peri: 280.56026403101595, periDot: 0, M0: 344.35736429594584, MDot: 472.0329572135581 },
  },
  {
    id: "portia", name: "Portia", parent: "uranus", mu: 6.046802e+7, radius: 5.500000e+4,
    kind: "moon", color: 0x82868a,
    rotationPeriod: -44419.5, hasSurface: true,
    moon: { a: 6.615877e+7, e: 0.003017461887590134, i: 95.10582030393101, node: 167.09905211473915, nodeDot: 0, peri: 148.6487828069397, periDot: 0, M0: 125.6168683387722, MDot: 700.2324286718994 },
  },
  {
    id: "cressida", name: "Cressida", parent: "uranus", mu: 1.306109e+7, radius: 3.300000e+4,
    kind: "moon", color: 0x82868a,
    rotationPeriod: -40135.8, hasSurface: true,
    moon: { a: 6.183384e+7, e: 0.004665923085162944, i: 97.04108722440617, node: 169.30218225514474, nodeDot: 0, peri: 237.47655982012796, periDot: 0, M0: 66.26626280736726, MDot: 774.9684376997701 },
  },
  {
    id: "caliban", name: "Caliban", parent: "uranus", mu: 1.956560e+7, radius: 3.600000e+4,
    kind: "moon", color: 0x6a4a44,
    rotationPeriod: 9720, hasSurface: true,
    moon: { a: 7.169893e+9, e: 0.08119912921913836, i: 139.77533904095299, node: 175.0836444212196, nodeDot: 0, peri: 339.28146721004924, periDot: 0, M0: 26.261107355850992, MDot: 0.6206608281225332 },
  },
  {
    id: "sycorax", name: "Sycorax", parent: "uranus", mu: 1.990075e+8, radius: 7.800000e+4,
    kind: "moon", color: 0x6e4a42,
    rotationPeriod: 24840, hasSurface: true,
    moon: { a: 1.217806e+10, e: 0.5134926860145936, i: 152.607124767252, node: 255.59471582776203, nodeDot: 0, peri: 17.232453856107927, periDot: 0, M0: 261.59893091526436, MDot: 0.28038598975435036 },
  },

  // ── Neptune's lesser moons (Naiad-group inner regulars + eccentric Nereid) ──
  {
    id: "naiad", name: "Naiad", parent: "neptune", mu: 8.530000e+6, radius: 2.900000e+4,
    kind: "moon", color: 0x7a7e82,
    rotationPeriod: 25495.2, hasSurface: true,
    moon: { a: 4.828336e+7, e: 0.0013225666533307604, i: 33.088867419644245, node: 51.00210970622281, nodeDot: 0, peri: 102.15660391413121, periDot: 0, M0: 359.99753727804614, MDot: 1219.9949822138578 },
  },
  {
    id: "thalassa", name: "Thalassa", parent: "neptune", mu: 2.359000e+7, radius: 4.000000e+4,
    kind: "moon", color: 0x7e8286,
    rotationPeriod: 26971.1, hasSurface: true,
    moon: { a: 5.012920e+7, e: 0.0012832686439983945, i: 28.452449548785303, node: 49.168294173234706, nodeDot: 0, peri: 273.00098788247993, periDot: 0, M0: 356.1582650352594, MDot: 1153.235504717448 },
  },
  {
    id: "despina", name: "Despina", parent: "neptune", mu: 1.167300e+8, radius: 7.400000e+4,
    kind: "moon", color: 0x7a7e82,
    rotationPeriod: 28970.6, hasSurface: true,
    moon: { a: 5.257710e+7, e: 0.000775298272281571, i: 28.516667710330722, node: 48.92147982054467, nodeDot: 0, peri: 77.65058074996352, periDot: 0, M0: 20.502215198655293, MDot: 1073.641312954366 },
  },
  {
    id: "galatea", name: "Galatea", parent: "neptune", mu: 1.899000e+8, radius: 7.900000e+4,
    kind: "moon", color: 0x7e8286,
    rotationPeriod: 37090.9, hasSurface: true,
    moon: { a: 6.199223e+7, e: 0.0008091343095409985, i: 28.50167067951242, node: 48.82249299386802, nodeDot: 0, peri: 51.93460219635176, periDot: 0, M0: 7.8886051950161535, MDot: 838.5873725835257 },
  },
  {
    id: "larissa", name: "Larissa", parent: "neptune", mu: 2.548400e+8, radius: 9.600000e+4,
    kind: "moon", color: 0x82868a,
    rotationPeriod: 47959.5, hasSurface: true,
    moon: { a: 7.357696e+7, e: 0.0008566947015894284, i: 28.586690133774596, node: 48.35675928783893, nodeDot: 0, peri: 178.98417297495487, periDot: 0, M0: 159.2969173553743, MDot: 648.546964021805 },
  },
  {
    id: "proteus", name: "Proteus", parent: "neptune", mu: 2.580000e+9, radius: 2.080000e+5,
    kind: "moon", color: 0x86888c,
    rotationPeriod: 96973, hasSurface: true,
    moon: { a: 1.176502e+8, e: 0.0004852941251126914, i: 28.99162748434596, node: 48.27896963963908, nodeDot: 0, peri: 351.44702053823704, periDot: 0, M0: 258.98129533475, MDot: 320.74897351264343 },
  },
  {
    id: "nereid", name: "Nereid", parent: "neptune", mu: 2.060309e+9, radius: 1.700000e+5,
    kind: "moon", color: 0x8a8e90,
    rotationPeriod: 41738.4, hasSurface: true,
    moon: { a: 5.510954e+9, e: 0.750691301439532, i: 5.060515309908998, node: 319.5898305060961, nodeDot: 0, peri: 297.00389946806513, periDot: 0, M0: 215.6212108498938, MDot: 1.000493072025144 },
  },

  // ── More main-belt asteroids ──
  {
    id: "psyche", name: "16 Psyche", parent: "sun", mu: 1.601000e+9, radius: 1.110000e+5,
    kind: "asteroid", color: 0x8a8278, region: "main_belt",
    rotationPeriod: 15105.6, hasSurface: true,
    helio: { a: 2.9205653969251943, e: 0.13824193654695516, i: 3.093373175073467, node: 150.46599638142214, peri: 229.11895342795364, M0: 335.5922611906655 },
  },
  {
    id: "hebe", name: "6 Hebe", parent: "sun", mu: 6.657449e+8, radius: 9.259000e+4,
    kind: "asteroid", color: 0x9a8a6a, region: "main_belt",
    rotationPeriod: 26188.2, hasSurface: true,
    helio: { a: 2.4248414850265645, e: 0.20215128111224406, i: 14.767926074096971, node: 138.8649662057039, peri: 238.949960083186, M0: 46.07377213229534 },
  },
  {
    id: "iris", name: "7 Iris", parent: "sun", mu: 7.529223e+8, radius: 9.991500e+4,
    kind: "asteroid", color: 0xa89a78, region: "main_belt",
    rotationPeriod: 25700.4, hasSurface: true,
    helio: { a: 2.3853370067042863, e: 0.23039838069996446, i: 5.524141947817452, node: 259.8742984040545, peri: 145.0800048666169, M0: 53.402734640112044 },
  },
  {
    id: "eunomia", name: "15 Eunomia", parent: "sun", mu: 1.173503e+9, radius: 1.158445e+5,
    kind: "asteroid", color: 0x9a8a6a, region: "main_belt",
    rotationPeriod: 21898.8, hasSurface: true,
    helio: { a: 2.643741568966596, e: 0.1862036783271153, i: 11.747338244354536, node: 293.5162118573675, peri: 96.96009463471556, M0: 107.163137303305 },
  },
  {
    id: "europa_ast", name: "52 Europa", parent: "sun", mu: 1.471516e+9, radius: 1.519590e+5,
    kind: "asteroid", color: 0x55504a, region: "main_belt",
    rotationPeriod: 20269.4, hasSurface: true,
    helio: { a: 3.098886919959848, e: 0.10097607801451454, i: 7.467844983992888, node: 129.0464773912736, peri: 342.3292858441201, M0: 42.6418322689723 },
  },
  {
    id: "davida", name: "511 Davida", parent: "sun", mu: 9.664973e+8, radius: 1.351635e+5,
    kind: "asteroid", color: 0x504a44, region: "main_belt",
    rotationPeriod: 18466.9, hasSurface: true,
    helio: { a: 3.170008847210493, e: 0.18307779962158433, i: 15.942471788209133, node: 107.76420598811343, peri: 338.884547445458, M0: 178.05347607404718 },
  },
  {
    id: "interamnia", name: "704 Interamnia", parent: "sun", mu: 5.000000e+9, radius: 1.531565e+5,
    kind: "asteroid", color: 0x4e4842, region: "main_belt",
    rotationPeriod: 31417.2, hasSurface: true,
    helio: { a: 3.063980265852141, e: 0.14613529533970512, i: 17.323327593427752, node: 280.6565199262021, peri: 94.51451448162167, M0: 242.5881771690532 },
  },
  {
    id: "sylvia", name: "87 Sylvia", parent: "sun", mu: 7.361594e+8, radius: 1.265255e+5,
    kind: "asteroid", color: 0x4a4540, region: "main_belt",
    rotationPeriod: 18662.4, hasSurface: true,
    helio: { a: 3.48671620853302, e: 0.07994419385650563, i: 10.858890628542444, node: 73.3429028766404, peri: 267.44928728487923, M0: 100.90372367733939 },
  },
  {
    id: "cybele", name: "65 Cybele", parent: "sun", mu: 7.001147e+8, radius: 1.186300e+5,
    kind: "asteroid", color: 0x504a42, region: "main_belt",
    rotationPeriod: 21893, hasSurface: true,
    helio: { a: 3.433867698885727, e: 0.10360439821978958, i: 3.54760719400164, node: 155.83886015557695, peri: 106.456705160638, M0: 243.48330663794846 },
  },
  {
    id: "lutetia", name: "21 Lutetia", parent: "sun", mu: 1.134000e+8, radius: 4.900000e+4,
    kind: "asteroid", color: 0x6a6258, region: "main_belt",
    rotationPeriod: 29395.8, hasSurface: true,
    helio: { a: 2.4357334902736714, e: 0.16171348434232616, i: 3.0660839496208263, node: 80.94686964624415, peri: 250.11664395911305, M0: 314.4208683209311 },
  },
  {
    id: "gaspra", name: "951 Gaspra", parent: "sun", mu: 1.713356e+5, radius: 6.100000e+3,
    kind: "asteroid", color: 0x9a8868, region: "main_belt",
    rotationPeriod: 25351.2, hasSurface: true,
    helio: { a: 2.209420544578243, e: 0.17356210256930724, i: 4.102675152082991, node: 253.32155298500572, peri: 129.30665624991482, M0: 96.50292109414322 },
  },
  {
    id: "ida", name: "243 Ida", parent: "sun", mu: 2.750000e+6, radius: 1.600000e+4,
    kind: "asteroid", color: 0x9a8a6c, region: "main_belt",
    rotationPeriod: 16682.4, hasSurface: true,
    helio: { a: 2.8596901349751525, e: 0.04575543739802269, i: 1.1370255115941854, node: 324.3802458172565, peri: 112.29100087492155, M0: 244.32658003618226 },
  },
  {
    id: "mathilde", name: "253 Mathilde", parent: "sun", mu: 6.890000e+6, radius: 2.640000e+4,
    kind: "asteroid", color: 0x46423c, region: "main_belt",
    rotationPeriod: 1503720, hasSurface: true,
    helio: { a: 2.647185793659079, e: 0.2654734893449862, i: 6.708713761054813, node: 179.8632753584114, peri: 156.3128713183203, M0: 225.7188763678109 },
  },

  // ── Near-Earth asteroids (sample-return / radar targets) ──
  {
    id: "bennu", name: "101955 Bennu", parent: "sun", mu: 4.656852e+0, radius: 2.410000e+2,
    kind: "asteroid", color: 0x47433f, region: "near_earth",
    rotationPeriod: 15465.8, hasSurface: true,
    helio: { a: 1.1289233627349666, e: 0.2046521730439485, i: 6.025536314644521, node: 2.1785444862326884, peri: 65.67192637209605, M0: 35.41801658970683 },
  },
  {
    id: "ryugu", name: "162173 Ryugu", parent: "sun", mu: 3.000000e+1, radius: 4.480000e+2,
    kind: "asteroid", color: 0x45413d, region: "near_earth",
    rotationPeriod: 27477.4, hasSurface: true,
    helio: { a: 1.189053952194159, e: 0.19001606957763173, i: 5.88447644924522, node: 251.72673810182883, peri: 211.27224417143293, M0: 288.65282800071725 },
  },
  {
    id: "itokawa", name: "25143 Itokawa", parent: "sun", mu: 2.100000e+0, radius: 1.650000e+2,
    kind: "asteroid", color: 0x9a8868, region: "near_earth",
    rotationPeriod: 43675.2, hasSurface: true,
    helio: { a: 1.3249457318356073, e: 0.2805282352323027, i: 1.7170900609757913, node: 71.61397274240683, peri: 160.1384777529646, M0: 44.091336661699 },
  },
  {
    id: "apophis", name: "99942 Apophis", parent: "sun", mu: 3.571202e+0, radius: 1.700000e+2,
    kind: "asteroid", color: 0x8a7a5c, region: "near_earth",
    rotationPeriod: 110016, hasSurface: true,
    helio: { a: 0.9223418471814196, e: 0.19139263548457533, i: 3.3312458341877904, node: 204.65682222567028, peri: 126.06484044257662, M0: 232.1807986283445 },
  },

  // ── Jupiter Trojans (L4 'Greek' & L5 'Trojan' camps; dark D-types) ──
  {
    id: "hektor", name: "624 Hektor", parent: "sun", mu: 3.980631e+8, radius: 1.125000e+5,
    kind: "asteroid", color: 0x5a3a30, region: "trojan",
    rotationPeriod: 24926.4, hasSurface: true,
    helio: { a: 5.209382516270022, e: 0.023137266709897814, i: 18.210220364988565, node: 342.7908032229638, peri: 179.2553807375424, M0: 313.65169662896346 },
  },
  {
    id: "patroclus", name: "617 Patroclus", parent: "sun", mu: 1.043703e+8, radius: 7.018100e+4,
    kind: "asteroid", color: 0x563a32, region: "trojan",
    rotationPeriod: 370080, hasSurface: true,
    helio: { a: 5.225536834278032, e: 0.13921448799909267, i: 22.051778282596214, node: 44.422044007788905, peri: 307.3013815377812, M0: 340.5787686501955 },
  },
  {
    id: "achilles", name: "588 Achilles", parent: "sun", mu: 7.695312e+7, radius: 6.504950e+4,
    kind: "asteroid", color: 0x5a3a30, region: "trojan",
    rotationPeriod: 26301.6, hasSurface: true,
    helio: { a: 5.182568404658655, e: 0.1486568350713682, i: 10.328127683695206, node: 316.5831671188614, peri: 132.13625608354496, M0: 11.750368935429172 },
  },
  {
    id: "eurybates", name: "3548 Eurybates", parent: "sun", mu: 9.111734e+6, radius: 3.194250e+4,
    kind: "asteroid", color: 0x4a3830, region: "trojan",
    rotationPeriod: 31359.6, hasSurface: true,
    helio: { a: 5.143715008713586, e: 0.09104886622254442, i: 8.082636676832927, node: 43.52651130810498, peri: 26.529659958190482, M0: 39.66877650402241 },
  },

  // ── More Kuiper-belt objects (classical / resonant TNOs) ──
  {
    id: "varuna", name: "20000 Varuna", parent: "sun", mu: 2.547604e+10, radius: 4.500000e+5,
    kind: "dwarf", color: 0x9a6a52, region: "kuiper",
    rotationPeriod: 22837, hasSurface: true,
    helio: { a: 43.15603903895661, e: 0.0568878452877949, i: 17.148655819148303, node: 97.28729257228194, peri: 272.0096750525996, M0: 82.88961329284743 },
  },
  {
    id: "ixion", name: "28978 Ixion", parent: "sun", mu: 9.850110e+9, radius: 3.085000e+5,
    kind: "dwarf", color: 0xa05840, region: "kuiper",
    rotationPeriod: 44640, hasSurface: true,
    helio: { a: 39.36089688749649, e: 0.24755626931552524, i: 19.687538632408554, node: 71.01506827077273, peri: 300.54176193994465, M0: 256.97074579397184 },
  },
  {
    id: "salacia", name: "120347 Salacia", parent: "sun", mu: 2.729639e+10, radius: 4.230000e+5,
    kind: "dwarf", color: 0x7a6a60, region: "kuiper",
    rotationPeriod: 21924, hasSurface: true,
    helio: { a: 42.23522042502905, e: 0.10275107210595562, i: 23.946454648518046, node: 280.18230943070387, peri: 312.0490956079951, M0: 96.76333806576878 },
  },
  {
    id: "huya", name: "38628 Huya", parent: "sun", mu: 2.827280e+9, radius: 2.035000e+5,
    kind: "dwarf", color: 0x9a6850, region: "kuiper",
    rotationPeriod: 19008, hasSurface: true,
    helio: { a: 39.156604792382915, e: 0.2717944138710741, i: 15.500853432663538, node: 169.37508652067854, peri: 68.22561777939755, M0: 337.5266589061018 },
  },

  // ── Detached / inner Oort cloud ──
  {
    id: "leleakuhonua", name: "541132 Leleākūhonua", parent: "sun", mu: 5.581663e+8, radius: 1.100000e+5,
    kind: "dwarf", color: 0x8a5a48, region: "oort",
    hasSurface: true,
    helio: { a: 1573.3756064438815, e: 0.9587637616128466, i: 11.672452560815143, node: 301.00861415790826, peri: 117.8418800481208, M0: 359.54973494311804 },
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
