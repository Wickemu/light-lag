/**
 * Procedural terrain + impact-crater synthesis for the rocky/airless bodies — the
 * *maths*, kept free of THREE and the DOM so the renderer (bodyTextures.paintRocky)
 * and any offline harness paint from ONE definition. Mirrors gasGiant.ts: a pure
 * function that returns raw RGBA buffers; the DOM wrapper just blits and uploads.
 *
 * The old rocky base was a single fbm mottle plus soft radial-gradient "craters"
 * that read as grey smudges — no rims, no floors, no peaks, no ejecta. This paints
 * a real regolith with a proper impact population instead:
 *
 *   - a multi-octave, domain-warped albedo field tinted by the body's colour, with
 *     a matching low-relief height field (so the terrain between craters isn't glassy);
 *   - a power-law crater population (many small, few large) stamped OLDEST-FIRST so
 *     young craters overprint and cut into old ones — real superposition stratigraphy;
 *   - each crater a physically-shaped radial profile: dark flat floor, terraced inner
 *     wall, a bright raised RIM lip, a fading EJECTA blanket, and a CENTRAL PEAK once
 *     the crater is large enough to be "complex" — written to BOTH a colour delta and
 *     a HEIGHT delta, so the lit sphere's shader turns the rims/peaks into real
 *     directional relief (the single biggest win over flat gradient discs);
 *   - a few fresh craters throw broken, radius-faded RAY streaks (the hero rays —
 *     Tycho, Kuiper, Hokusai — are carried more boldly by the bodyFeatures tables).
 *
 * Every crater is evaluated with the true great-circle angular distance from its
 * centre, so it stays a perfect circle everywhere — no meridian seam, no polar oval
 * stretch — and placement is area-uniform on the sphere (asin latitude sampling).
 *
 * Determinism: seeded from a hash of the body id (the same contract as the textures
 * and the sim), so a world looks identical on every reload; runs once at startup.
 */

import { type BodyKind } from "@lightlag/engine/constants";

// ── PRNG + tileable value noise (self-contained, like gasGiant.ts) ──────────────

/** FNV-1a string hash → 32-bit seed. */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — seeded, reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Longitude-tileable fractal value noise (x wraps to a per-octave period so the
 * sum is seamless across u=0/1; latitude never wraps). Returns ~[0,1].
 */
function makeFbm(rng: () => number): (x: number, y: number, octaves: number, baseCells: number) => number {
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = p[i]!; p[i] = p[j]!; p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]!;

  const hash = (xi: number, yi: number): number =>
    perm[(perm[xi & 255]! + (yi & 255)) & 255]! / 255;
  const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

  const vnoise = (x: number, y: number, periodX: number): number => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = fade(x - x0), fy = fade(y - y0);
    const wx0 = ((x0 % periodX) + periodX) % periodX;
    const wx1 = (((x0 + 1) % periodX) + periodX) % periodX;
    const v00 = hash(wx0, y0), v10 = hash(wx1, y0);
    const v01 = hash(wx0, y0 + 1), v11 = hash(wx1, y0 + 1);
    const a = v00 + (v10 - v00) * fx;
    const b = v01 + (v11 - v01) * fx;
    return a + (b - a) * fy;
  };

  return (x, y, octaves, baseCells) => {
    let amp = 0.5, sum = 0, norm = 0, freq = baseCells;
    for (let o = 0; o < octaves; o++) {
      sum += amp * vnoise(x * freq, y * freq * 0.5, freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  };
}

// ── Colour helpers (0..1 RGB) ──────────────────────────────────────────────────

type RGB = [number, number, number];

function hexToRgb(hex: number): RGB {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
function clamp(x: number, a: number, b: number): number { return x < a ? a : x > b ? b : x; }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
/** Scale an RGB toward black (k<1) or white-ish highlight (k>1) about the body hue. */
function shadeRgb(c: RGB, k: number): RGB {
  if (k <= 1) return [c[0] * k, c[1] * k, c[2] * k];
  const t = k - 1;
  return [clamp01(c[0] + (1 - c[0]) * t), clamp01(c[1] + (1 - c[1]) * t), clamp01(c[2] + (1 - c[2]) * t)];
}

// ── Per-body profile shape ──────────────────────────────────────────────────────

/** How a body's impact population reads — one struct retargets heavily-cratered
 *  Mercury/Moon, lightly-cratered young surfaces, and smooth regolith moons. */
interface CraterStyle {
  /** Base crater count (further scaled by params.craterScale for young/hidden worlds). */
  count: number;
  /** Cumulative size-frequency exponent (~2.0 Moon, ~2.2 Mercury highlands). */
  bSlope: number;
  /** Angular crater radius range, degrees. */
  rMinDeg: number; rMaxDeg: number;
  /** Simple→complex threshold radius (deg): above it, terraces + a central peak appear. */
  rcDeg: number;
  /** Floor albedo drop and fresh-rim brightening (fractions). */
  floorDark: number; rimBright: number;
  /** Mean surface freshness 0..1 (young worlds high) and its spread. */
  freshMean: number; freshSpread: number;
  /** Fraction of the freshest craters that throw ray streaks. */
  rayFraction: number;
  /** Vertical exaggeration of the height buffer. */
  depthScale: number;
}

interface RockyProfile {
  /** Override the terrain base hue (else the body's marker `color`). Lets Mercury
   *  read as true dark grey-brown and Mars as ochre while their markers stay the
   *  recognisable tan/red dots. */
  baseHex?: number;
  /** Terrain albedo: dark/light lightness offsets, mix toward the body hue, noise scale. */
  darkDL: number; lightDL: number; baseMix: number; baseCells: number; octaves: number;
  /** Terrain height (inter-crater relief) amplitude. */
  reliefAmp: number;
  /** Impact population, or null for a craterless world. */
  craters: CraterStyle | null;
  /** Mars-style dark basaltic mare field from a second low-frequency noise. */
  mare?: { hex: number; cells: number; threshold: number; gain: number };
  /** Optional explicit crater rim-highlight / floor-shadow tints (else derived from hue). */
  hiHex?: number; loHex?: number;
}

// Crater counts scale roughly with how battered a class reads and how much screen
// it fills — airless rock is crowded, comets/asteroids sparser at their tiny size.
const KIND_CRATER_COUNT: Record<BodyKind, number> = {
  star: 0, planet: 700, dwarf: 650, moon: 780, asteroid: 520, comet: 200, satellite: 0,
};

const GENERIC_CRATERS: CraterStyle = {
  count: 0, // filled from KIND_CRATER_COUNT
  bSlope: 2.05, rMinDeg: 1.0, rMaxDeg: 6.5, rcDeg: 4.2,
  floorDark: 0.26, rimBright: 0.26, freshMean: 0.42, freshSpread: 0.9,
  rayFraction: 0.05, depthScale: 1.0,
};

const GENERIC: RockyProfile = {
  darkDL: -0.14, lightDL: 0.10, baseMix: 0.6, baseCells: 8, octaves: 5,
  reliefAmp: 0.22, craters: GENERIC_CRATERS,
};

/** Tuned inner-world profiles. Bodies without an entry use GENERIC (with a
 *  kind-based crater count), so the ~40 shared asteroids/comets/outer moons keep a
 *  single well-behaved path. */
const ROCKY_PROFILES: Record<string, RockyProfile> = {
  // Mercury — the most heavily-cratered inner world: a dark warm-grey regolith with
  // a very dense, ancient population and big complex peak-ring craters. Named basins,
  // smooth plains and bright ray craters ride on top from bodyFeatures.
  mercury: {
    baseHex: 0x8f8073, // true dark warm-grey (not the vivid MESSENGER false-colour)
    darkDL: -0.12, lightDL: 0.09, baseMix: 0.62, baseCells: 7, octaves: 5,
    reliefAmp: 0.26,
    craters: {
      count: 2000, bSlope: 2.2, rMinDeg: 0.9, rMaxDeg: 9.5, rcDeg: 3.4,
      floorDark: 0.24, rimBright: 0.24, freshMean: 0.30, freshSpread: 1.0,
      rayFraction: 0.06, depthScale: 1.1,
    },
    hiHex: 0xb7ab9c, loHex: 0x4c443b,
  },

  // The Moon — heavily-cratered bright anorthosite highlands (the maria darken it
  // from bodyFeatures). A dense ancient population with a scatter of crisp fresh rays.
  moon: {
    darkDL: -0.13, lightDL: 0.11, baseMix: 0.55, baseCells: 8, octaves: 5,
    reliefAmp: 0.24,
    craters: {
      count: 1700, bSlope: 2.1, rMinDeg: 0.9, rMaxDeg: 8.5, rcDeg: 3.8,
      floorDark: 0.28, rimBright: 0.30, freshMean: 0.34, freshSpread: 1.0,
      rayFraction: 0.05, depthScale: 1.05,
    },
    hiHex: 0xd8d2c6, loHex: 0x54514c,
  },

  // Mars — a butterscotch dust world: fewer, softer craters (wind + dust bury them),
  // a dusky basaltic mare field, and the named albedo/volcano/polar features on top.
  mars: {
    baseHex: 0xb0673f, // butterscotch/ochre, not the pure-red marker hint
    darkDL: -0.14, lightDL: 0.10, baseMix: 0.6, baseCells: 6, octaves: 5,
    reliefAmp: 0.20,
    craters: {
      count: 520, bSlope: 2.0, rMinDeg: 1.2, rMaxDeg: 7.0, rcDeg: 4.5,
      floorDark: 0.20, rimBright: 0.18, freshMean: 0.28, freshSpread: 0.8,
      rayFraction: 0.0, depthScale: 0.85,
    },
    mare: { hex: 0x6a4a33, cells: 4, threshold: 0.45, gain: 1.7 },
  },

  // Phobos — small but heavily battered: a very dark carbonaceous body, densely
  // cratered, with Stickney + the groove family stamped from the feature table.
  phobos: {
    baseHex: 0x554f48,
    darkDL: -0.10, lightDL: 0.07, baseMix: 0.7, baseCells: 9, octaves: 5,
    reliefAmp: 0.30,
    craters: {
      count: 900, bSlope: 2.0, rMinDeg: 1.0, rMaxDeg: 8.0, rcDeg: 12.0,
      floorDark: 0.24, rimBright: 0.16, freshMean: 0.35, freshSpread: 1.0,
      rayFraction: 0.0, depthScale: 1.0,
    },
  },

  // Deimos — a thick regolith blanket buries craters: sparse, soft, muted, very dark.
  deimos: {
    baseHex: 0x585149,
    darkDL: -0.08, lightDL: 0.06, baseMix: 0.72, baseCells: 9, octaves: 4,
    reliefAmp: 0.12,
    craters: {
      count: 130, bSlope: 1.9, rMinDeg: 1.6, rMaxDeg: 6.0, rcDeg: 8.0,
      floorDark: 0.13, rimBright: 0.08, freshMean: 0.2, freshSpread: 0.7,
      rayFraction: 0.0, depthScale: 0.5,
    },
  },
};

/** Whether this body has a tuned rocky profile (mirrors gasGiant.isGiantId). */
export function hasRockyProfile(id: string): boolean {
  return id in ROCKY_PROFILES;
}

// ── Public shape ────────────────────────────────────────────────────────────────

export interface RockyParams {
  id: string;
  color: number;
  kind: BodyKind;
  w: number; h: number;
  /** Multiplier on the profile's crater count — the wrapper trims it for young
   *  resurfaced worlds (Io/Europa/Triton) and cloud-hidden ones (Venus/Titan). */
  craterScale?: number;
}

export interface RockySurface {
  /** w*h*4 RGBA, opaque — base terrain with the crater population composited in. */
  surface: Uint8ClampedArray;
  /** w*h*4 grayscale RGBA height/bump map (crater rims/floors/peaks + inter-crater relief). */
  bump: Uint8ClampedArray;
}

// ── Crater radial profiles (see module header) ──────────────────────────────────

/** Height delta at normalized radius q for one crater. `peakH` is the central-peak
 *  height (0 for simple craters); `qf`/`qe` are the floor and ejecta-edge radii. */
function craterHeight(q: number, qf: number, qe: number, rimH: number, floorD: number, peakH: number, terrace: number): number {
  let h: number;
  if (q < qf) {
    h = floorD; // flat (or slightly domed via the peak below) floor
  } else if (q < 1.0) {
    // Inner wall: floor→rim S-curve, with a few terrace benches on complex craters.
    const t = (q - qf) / (1.0 - qf);
    h = lerp(floorD, rimH, smoothstep(0, 1, t));
    if (terrace > 0) h += terrace * rimH * 0.25 * (smoothstep(0.35, 0.65, (t * 3) % 1) - 0.5);
  } else if (q < qe) {
    // A sharp rim lip at q≈1.02, then a decaying ejecta blanket.
    const e = (q - 1.0) / (qe - 1.0);
    const crest = rimH * Math.exp(-(((q - 1.02) / 0.06) ** 2));
    const blanket = rimH * 0.32 * (1 - e) ** 1.8;
    h = crest + blanket;
  } else {
    return 0;
  }
  if (peakH > 0 && q < 0.24) h += peakH * (1 - q / 0.24) ** 2; // central cone
  return h;
}

/** Signed brightness delta at q: dark floor, bright rim lip, fading ejecta. */
function craterColor(q: number, qf: number, qe: number, floorDark: number, rimBright: number): number {
  if (q < qf) return -floorDark;
  if (q < 1.0) {
    const t = (q - qf) / (1.0 - qf);
    return lerp(-floorDark, rimBright, smoothstep(0, 1, t));
  }
  if (q < qe) {
    const e = (q - 1.0) / (qe - 1.0);
    return rimBright * Math.exp(-(((q - 1.0) / 0.10) ** 2)) + rimBright * 0.55 * (1 - e) ** 1.5;
  }
  return 0;
}

/** Broken, radius-faded ray streaks for a fresh crater. `seed` fixes the ray phase
 *  and count; returns an additive brightness (colour only — rays carry no relief). */
function rayMask(q: number, az: number, seed: number, nRays: number, qray: number): number {
  if (q <= 1.0 || q > qray) return 0;
  const spin = ((seed & 0xffff) / 0xffff) * Math.PI * 2;
  const a = (az + spin) * nRays / (Math.PI * 2);
  const lobe = a - Math.floor(a);
  const ang = smoothstep(0.5, 0.16, Math.abs(lobe - 0.5)); // 1 on a ray axis → 0 between
  if (ang <= 0) return 0;
  // Per-ray random length (not all reach qray) + along-ray breaks.
  const rayIdx = Math.floor(a);
  const rh = (Math.imul(seed ^ rayIdx, 2654435761) >>> 0) / 4294967296;
  const len = 1.0 + (0.55 + 0.45 * rh) * (qray - 1.0);
  if (q > len) return 0;
  const seg = 0.55 + 0.45 * Math.sin(q * 5.0 + rh * 40.0);
  const radial = smoothstep(1.0, 1.35, q) * ((qray - q) / (qray - 1.0)) ** 1.3;
  return ang * clamp01(seg) * radial;
}

// ── Painter ─────────────────────────────────────────────────────────────────────

/**
 * Paint a rocky body's equirectangular surface (RGBA) + height/bump (grayscale
 * RGBA). Pure: the caller blits both onto canvases. Deterministic from `id`.
 */
export function paintRockySurface(p: RockyParams): RockySurface {
  const { id, color, kind, w, h } = p;
  const profile = ROCKY_PROFILES[id] ?? GENERIC;
  const rng = mulberry32(hashStr(id + "/rocky"));
  const fbm = makeFbm(rng);

  const surface = new Uint8ClampedArray(w * h * 4);
  const height = new Float32Array(w * h); // relative elevation, mean ~0

  const base = hexToRgb(profile.baseHex ?? color);
  const light = shadeRgb(base, 1 + profile.lightDL * 2.2);
  const dark = shadeRgb(base, 1 + profile.darkDL * 2.2);
  const mare = profile.mare ? hexToRgb(profile.mare.hex) : dark;
  const hi = profile.hiHex ? hexToRgb(profile.hiHex) : shadeRgb(base, 1.5);
  const lo = profile.loHex ? hexToRgb(profile.loHex) : shadeRgb(base, 0.45);

  // 1. Base terrain: a domain-warped multi-octave albedo field tinted toward the
  //    body hue, plus a low-relief height field so the plains aren't glassy.
  const WARP = 0.03;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const wu = u + (fbm(u + 11.0, v + 5.0, 3, 4) - 0.5) * WARP;
      const n = fbm(wu, v, profile.octaves, profile.baseCells);
      const detail = fbm(u + 3.0, v + 7.0, 4, profile.baseCells * 3);
      const a = clamp01(n * 0.82 + detail * 0.18);
      let r = lerp(dark[0], light[0], a);
      let g = lerp(dark[1], light[1], a);
      let b = lerp(dark[2], light[2], a);
      r = lerp(base[0], r, profile.baseMix);
      g = lerp(base[1], g, profile.baseMix);
      b = lerp(base[2], b, profile.baseMix);
      if (profile.mare) {
        // Dusky basaltic regions where a second low-frequency field is low.
        const region = fbm(u + 4.0, v + 4.0, 3, profile.mare.cells);
        const m = clamp01((profile.mare.threshold - region) * profile.mare.gain);
        r = lerp(r, mare[0], m); g = lerp(g, mare[1], m); b = lerp(b, mare[2], m);
      }
      const i = y * w + x;
      surface[i * 4] = (r * 255) | 0;
      surface[i * 4 + 1] = (g * 255) | 0;
      surface[i * 4 + 2] = (b * 255) | 0;
      surface[i * 4 + 3] = 255;
      height[i] = (a - 0.5) * profile.reliefAmp;
    }
  }

  // 2. Crater population — power-law radii, area-uniform placement, oldest-first so
  //    young craters overprint. Great-circle distance keeps every crater circular.
  if (profile.craters) {
    const cs = profile.craters;
    const baseCount = cs.count || KIND_CRATER_COUNT[kind]; // tuned worlds set count; else by class
    const count = Math.max(0, Math.round(baseCount * (p.craterScale ?? 1)));
    stampCraters(surface, height, w, h, count, cs, hi, lo, id);
  }

  // 3. Height field → grayscale bump RGBA. 0.5 is datum; rims/peaks brighten, floors
  //    darken — the material's bumpScale turns this into directional relief.
  const bump = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const bv = clamp01(0.5 + height[i]! * 0.5) * 255;
    bump[i * 4] = bv; bump[i * 4 + 1] = bv; bump[i * 4 + 2] = bv; bump[i * 4 + 3] = 255;
  }

  return { surface, bump };
}

/** Inverse-CDF sample of a radius with pdf ∝ R^-(b+1) on [lo,hi] → many small, few large. */
function sampleRadius(x: number, lo: number, hi: number, b: number): number {
  const L = lo ** -b, Hh = hi ** -b;
  return (L + x * (Hh - L)) ** (-1 / b);
}

interface Crater { uc: number; latc: number; rDeg: number; g: number; complex: boolean; rays: number; seed: number; }

/** Generate and stamp the whole crater field into the colour + height buffers. */
function stampCraters(
  surface: Uint8ClampedArray, height: Float32Array, w: number, h: number,
  count: number, cs: CraterStyle, hi: RGB, lo: RGB, id: string,
): void {
  const rng = mulberry32(hashStr(id + "/craters"));
  const DEG = Math.PI / 180;

  const craters: Crater[] = [];
  for (let i = 0; i < count; i++) {
    const rDeg = sampleRadius(rng(), cs.rMinDeg, cs.rMaxDeg, cs.bSlope);
    const uc = rng();
    const latc = Math.asin(2 * rng() - 1); // area-uniform on the sphere
    const g = clamp01(1 - (cs.freshMean + (rng() - 0.5) * cs.freshSpread));
    const fresh = 1 - g;
    craters.push({
      uc, latc, rDeg, g,
      complex: rDeg > cs.rcDeg,
      rays: (rng() < cs.rayFraction && fresh > 0.8 && rDeg > cs.rMinDeg * 3) ? (6 + ((rng() * 10) | 0)) : 0,
      seed: (hashStr(id) ^ Math.imul(i + 1, 2654435761)) >>> 0,
    });
  }
  // Oldest first → young craters overprint and cut into old ones (stratigraphy).
  craters.sort((a, b) => b.g - a.g);

  for (const c of craters) {
    const Rang = c.rDeg * DEG;                       // angular radius (rad)
    const fresh = 1 - c.g;
    const amp = lerp(0.4, 1.0, fresh) * cs.depthScale;
    const colAmp = lerp(0.5, 1.0, fresh);
    const qf = 0.6;
    const qe = lerp(1.45, 2.3, fresh);               // ejecta shrinks with age
    const reach = c.rays ? Math.max(qe, 6.0) : qe;
    const rimH = 0.22 * amp;
    const floorD = -0.5 * amp * (0.6 + 0.4 * (c.rDeg / cs.rMaxDeg)); // bigger craters relatively shallower
    const peakH = c.complex ? 0.5 * amp * clamp01((c.rDeg - cs.rcDeg) / cs.rcDeg) : 0;
    const terrace = c.complex ? fresh : 0;
    const floorDark = cs.floorDark * colAmp;
    const rimBright = cs.rimBright * colAmp * (0.5 + 0.5 * fresh);

    // Latitude bounding box (rows clamp). The crater cap's half-height is exactly its
    // angular reach; each row's longitude span is derived per-row from the great-circle
    // geometry below — a single center-latitude half-width both clips pole-ward rows
    // (they subtend a wider longitude arc) and, once it exceeds a hemisphere, wraps a
    // column onto itself and double-stamps it. cosReach is the row-membership threshold.
    const vc = c.latc / Math.PI + 0.5;
    const halfV = (reach * Rang / Math.PI) * h;
    const y0 = Math.max(0, Math.floor(vc * h - halfV));
    const y1 = Math.min(h - 1, Math.ceil(vc * h + halfV));
    const xc = Math.round(c.uc * w);
    const sinLatc = Math.sin(c.latc), cosLatc = Math.cos(c.latc);
    const cosReach = Math.cos(Math.min(reach * Rang, Math.PI));

    for (let y = y0; y <= y1; y++) {
      const v = (y + 0.5) / h;
      const lat = (v - 0.5) * Math.PI;
      const sinLat = Math.sin(lat), cosLat = Math.cos(lat);
      // Columns of this row within reach: cos(dlon) ≥ (cosReach − sinLatc·sinLat) /
      // (cosLatc·cosLat). Off the ends this is a window; near the pole (or a crater that
      // spans it) it is the whole ring — iterate each column AT MOST ONCE either way.
      const denom = cosLatc * cosLat;
      let fullRing = false, span = 0;
      if (denom < 1e-9) {
        if (sinLatc * sinLat < cosReach) continue; // this row lies entirely outside the cap
        fullRing = true;
      } else {
        const thr = (cosReach - sinLatc * sinLat) / denom;
        if (thr > 1) continue;               // row outside the cap
        else if (thr <= -1) fullRing = true; // whole row inside the cap
        else {
          span = Math.ceil((Math.acos(thr) / (2 * Math.PI)) * w) + 1;
          if (2 * span + 1 >= w) fullRing = true;
        }
      }
      const count = fullRing ? w : 2 * span + 1;
      const startX = fullRing ? 0 : xc - span;
      for (let col = 0; col < count; col++) {
        const x = fullRing ? col : ((((startX + col) % w) + w) % w);
        const u = (x + 0.5) / w;
        let du = u - c.uc;
        if (du > 0.5) du -= 1; else if (du < -0.5) du += 1;
        const dlon = du * 2 * Math.PI;
        const cosr = sinLatc * sinLat + cosLatc * cosLat * Math.cos(dlon);
        const rAng = Math.acos(clamp(cosr, -1, 1));
        const q = rAng / Rang;
        if (q > reach) continue;

        const i = y * w + x;
        const hDelta = craterHeight(q, qf, qe, rimH, floorD, peakH, terrace);
        height[i] = height[i]! + hDelta;

        let cDelta = craterColor(q, qf, qe, floorDark, rimBright);
        if (c.rays) {
          const az = Math.atan2(Math.sin(dlon) * cosLat, cosLatc * sinLat - sinLatc * cosLat * Math.cos(dlon));
          cDelta += rayMask(q, az, c.seed, c.rays, reach) * rimBright * 1.4;
        }
        if (cDelta === 0) continue;
        // Multiplicative brightness about the local albedo, tinted toward the rim
        // highlight (bright immature regolith) or the floor shadow.
        const k = i * 4;
        const tint = cDelta >= 0 ? hi : lo;
        const m = cDelta >= 0 ? cDelta : -cDelta;
        const f0 = surface[k]! / 255, f1 = surface[k + 1]! / 255, f2 = surface[k + 2]! / 255;
        const bright = 1 + cDelta;
        surface[k] = clamp01(lerp(f0 * bright, tint[0], m * 0.35)) * 255;
        surface[k + 1] = clamp01(lerp(f1 * bright, tint[1], m * 0.35)) * 255;
        surface[k + 2] = clamp01(lerp(f2 * bright, tint[2], m * 0.35)) * 255;
      }
    }
  }
}
