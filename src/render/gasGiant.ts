/**
 * Procedural cloud maps for the gas/ice giants — the *maths*, deliberately kept
 * free of THREE and the DOM so the renderer (bodyTextures.paintGasGiant) and the
 * offline preview harness (scripts/preview-giants.ts) paint from ONE definition
 * of every band, storm and swirl. The renderer just blits the RGBA buffer this
 * returns onto a canvas and uploads it; nothing visual lives only in the browser.
 *
 * The look is built from real structure, not a photo:
 *   - a per-body table of the planet's named belts and zones at their REAL
 *     latitudes and true-ish colours (the cream ammonia zones, the brown/orange
 *     belts, the dusky polar hoods) — sampled as a smooth latitude→colour ramp;
 *   - strong ZONAL turbulence: anisotropic value-noise stretched east–west, the
 *     way the planet's jet streams smear every cloud feature into long streaks;
 *   - bright/dark filaments along the belt/zone shear lines (the turbulent edges);
 *   - signature storms drawn as elliptical vortices with spiral shading — Jupiter's
 *     Great Red Spot, Oval BA and white ovals, Neptune's Great Dark Spot and its
 *     bright methane companions — plus Saturn's polar hexagon jet.
 *
 * Determinism: every body seeds its noise from a hash of its id, so a world looks
 * identical on every reload — the same contract the sim itself honours.
 */

// ── Tiny self-contained PRNG + value noise (no shared deps, so this stays pure) ──

/** FNV-1a string hash → 32-bit seed. */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — seeded, so textures are reproducible. */
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
 * Anisotropic, longitude-tileable fractal value noise. Unlike the renderer's
 * shared isotropic fbm, this takes SEPARATE horizontal/vertical cell counts so a
 * caller can stretch the field east–west: few `cellsX` + many `cellsY` makes the
 * wide, thin streaks that the giants' zonal winds comb every feature into. The x
 * index wraps to a per-octave period (= the integer cell count) so the sum stays
 * seamless across the u=0/1 meridian; latitude never wraps (it ends at the poles).
 */
function makeGiantNoise(seed: number): (x: number, y: number, octaves: number, cellsX: number, cellsY: number) => number {
  const rng = mulberry32(seed);
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

  return (x, y, octaves, cellsX, cellsY) => {
    let amp = 0.5, sum = 0, norm = 0, fx = Math.max(1, Math.round(cellsX)), fy = cellsY;
    for (let o = 0; o < octaves; o++) {
      sum += amp * vnoise(x * fx, y * fy, fx);
      norm += amp;
      amp *= 0.5;
      fx *= 2;
      fy *= 2;
    }
    return sum / norm;
  };
}

// ── Colour helpers (0..1 RGB) ────────────────────────────────────────────────

export type RGB = [number, number, number];

function hexToRgb(hex: number): RGB {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

// ── Per-body profile shape ───────────────────────────────────────────────────

/** A colour anchored at a latitude; the painter interpolates between adjacent
 *  stops to get a continuous belt/zone ramp. Authored south→north (ascending lat). */
interface BandStop { lat: number; col: number }

/** An elliptical storm/vortex drawn with spiral shading. */
interface Storm {
  /** Centre (east-positive lon, lat), degrees. Longitude is cosmetic (planet spins). */
  lon: number; lat: number;
  /** Angular semi-axes, degrees. */
  rx: number; ry: number;
  /** Core colour and the colour its rim fades toward. */
  core: number; rim: number;
  /** Spiral strength 0..1 and winding rate (sign sets the sense of rotation). */
  swirl: number; wind: number;
  /** Coverage alpha at the core. */
  alpha: number;
}

interface GiantProfile {
  stops: BandStop[];
  /** Latitude domain-warp amplitude (deg): how much the bands wave and scallop. */
  warpDeg: number;
  /** Warp field cells — few X (long zonal undulations), more Y (finer scallops). */
  warpCellsX: number; warpCellsY: number;
  /** Fine brightness mottle amplitude (cloud texture within a band). */
  detail: number;
  /** Bright-filament strength along belt/zone shear lines (turbulent edges). */
  filament: number;
  /** Tint bright filaments toward this colour (cream cirrus on the giants;
   *  near-white methane cloud on Neptune). */
  filamentCol: number;
  storms: Storm[];
  /** Saturn's north-polar hexagon jet, if any. `lat` is the apothem latitude (the
   *  edge midpoints); `round` blends the corner shape from a circle (0) to a true
   *  regular hexagon (1) — i.e. how sharply the six corners pinch. */
  hexagon?: { lat: number; round: number; jet: number; vortex: number };
}

// Latitudes follow the real (planetographic) belt/zone system; colours are
// true-ish, nudged for contrast so the structure reads on a small disc.
const GIANT_PROFILES: Record<string, GiantProfile> = {
  // ── Jupiter ────────────────────────────────────────────────────────────────
  // The classic alternation: pale ammonia ZONES and dark reddish-brown BELTS,
  // the NEB/SEB the boldest, the EZ cream-yellow, dusky grey-brown polar hoods.
  jupiter: {
    stops: [
      { lat: -90, col: 0x55504b }, // S polar hood
      { lat: -76, col: 0x796a5a },
      { lat: -60, col: 0x9a8164 }, // SPR edge
      { lat: -49, col: 0xc6ad84 }, // S temperate zone (light)
      { lat: -40, col: 0x9a6e48 }, // STB (dark)
      { lat: -32, col: 0xd3be93 }, // STZ (light)
      { lat: -24, col: 0xdec99c }, // S Tropical Zone (bright) — GRS hangs on its S edge
      { lat: -19, col: 0xa5754d }, // SEB south component
      { lat: -13, col: 0x925f39 }, // SEB (dark brown)
      { lat: -8,  col: 0xc8a877 }, // SEB→EZ shear (lighter)
      { lat: -3,  col: 0xe8d4a2 }, // EZ (cream-yellow)
      { lat:  3,  col: 0xead7a4 }, // EZ
      { lat:  7,  col: 0xba8b53 }, // NEB south edge (festoon roots)
      { lat: 11,  col: 0x8a5530 }, // NEB (darkest reddish-brown)
      { lat: 16,  col: 0x9b6536 }, // NEB
      { lat: 20,  col: 0xceb588 }, // N Tropical Zone (light)
      { lat: 26,  col: 0xd7c290 }, // NTrZ / NTZ
      { lat: 31,  col: 0xa4794e }, // NTB (dark)
      { lat: 37,  col: 0xceb888 }, // NTZ (light)
      { lat: 45,  col: 0x9c8160 }, // NNTB (faint dark)
      { lat: 60,  col: 0x8a785f }, // NPR edge
      { lat: 76,  col: 0x756758 },
      { lat: 90,  col: 0x55504b }, // N polar hood
    ],
    warpDeg: 2.6, warpCellsX: 5, warpCellsY: 8,
    detail: 0.15, filament: 0.62, filamentCol: 0xf2e6c8,
    storms: [
      // Great Red Spot — a vast anticyclone on the SEB/STrZ boundary (~22°S).
      { lon: 40, lat: -22, rx: 12, ry: 7.5, core: 0xa54e2f, rim: 0xcf9560, swirl: 0.85, wind: 2.4, alpha: 0.95 },
      // Oval BA ("Red Spot Jr.") — the pale-orange storm a temperate band south.
      { lon: -64, lat: -33, rx: 4.6, ry: 3.1, core: 0xc78a55, rim: 0xe4cba2, swirl: 0.7, wind: 2.2, alpha: 0.85 },
      // Long-lived white ovals in the temperate belts.
      { lon: 128, lat: -41, rx: 3.6, ry: 2.4, core: 0xeae2d1, rim: 0xcdbf9d, swirl: 0.5, wind: 2.0, alpha: 0.8 },
      { lon: -134, lat: 35, rx: 3.1, ry: 2.2, core: 0xe7dec9, rim: 0xc9ba98, swirl: 0.5, wind: -2.0, alpha: 0.78 },
      // A "brown barge" — a dark elongated cyclone embedded in the NEB.
      { lon: 150, lat: 14, rx: 5.2, ry: 2.1, core: 0x5f3a22, rim: 0x9c6a40, swirl: 0.4, wind: 1.5, alpha: 0.7 },
    ],
  },

  // ── Saturn ───────────────────────────────────────────────────────────────────
  // Softer, hazier and more golden than Jupiter — an overlying haze mutes the
  // bands — with a blue-grey northern polar region crowned by the hexagon jet.
  saturn: {
    stops: [
      { lat: -90, col: 0x988a6a }, // S polar
      { lat: -72, col: 0xc6b386 },
      { lat: -55, col: 0xdccb97 },
      { lat: -42, col: 0xccb884 },
      { lat: -28, col: 0xe3d5a3 },
      { lat: -16, col: 0xd3c08a },
      { lat: -6,  col: 0xeaddae },
      { lat:  3,  col: 0xf1e5b7 }, // EZ — bright gold
      { lat: 12,  col: 0xdccb92 },
      { lat: 22,  col: 0xe5d79f },
      { lat: 34,  col: 0xcfbd85 },
      { lat: 46,  col: 0xc0b48a }, // transition to the blue-grey collar
      { lat: 60,  col: 0xa6ac8e },
      { lat: 74,  col: 0x8d9a8d }, // N polar hood (Cassini blue-grey)
      { lat: 90,  col: 0x84928c },
    ],
    warpDeg: 1.7, warpCellsX: 4, warpCellsY: 7,
    detail: 0.07, filament: 0.28, filamentCol: 0xf3ead0,
    storms: [
      // A modest white storm — Saturn's outbreaks are rarer and fainter than Jove's.
      { lon: 95, lat: 36, rx: 4.2, ry: 2.0, core: 0xf0e9d6, rim: 0xd6c79f, swirl: 0.35, wind: 6, alpha: 0.55 },
    ],
    hexagon: { lat: 77.5, round: 0.92, jet: 0x6e7d71, vortex: 0x7e8d80 },
  },

  // ── Uranus ───────────────────────────────────────────────────────────────────
  // Famously bland: a near-featureless pale cyan methane haze, a touch brighter
  // toward the (sunlit) pole. Almost no banding, almost no turbulence.
  uranus: {
    stops: [
      { lat: -90, col: 0x9bced5 },
      { lat: -45, col: 0xa0d5dc },
      { lat:   0, col: 0x9ed5dc },
      { lat:  45, col: 0xa6dbe2 },
      { lat:  70, col: 0xbae3e8 },
      { lat:  90, col: 0xc8eaee }, // bright polar cap
    ],
    warpDeg: 0.8, warpCellsX: 4, warpCellsY: 6,
    detail: 0.03, filament: 0.06, filamentCol: 0xd8eef2,
    storms: [],
  },

  // ── Neptune ──────────────────────────────────────────────────────────────────
  // Deep methane blue, a few subtle bands, bright white cirrus streaks, and the
  // Great Dark Spot with its bright companion clouds + the fast "Scooter".
  neptune: {
    stops: [
      { lat: -90, col: 0x36589f },
      { lat: -55, col: 0x3f64b0 },
      { lat: -35, col: 0x4a74cb },
      { lat: -20, col: 0x537ddd }, // brighter zone
      { lat:   0, col: 0x4a76d4 },
      { lat:  20, col: 0x416bc6 },
      { lat:  45, col: 0x3a61b5 },
      { lat:  70, col: 0x35589f },
      { lat:  90, col: 0x31518f },
    ],
    warpDeg: 2.0, warpCellsX: 5, warpCellsY: 9,
    detail: 0.10, filament: 0.55, filamentCol: 0xe6eef8,
    storms: [
      // Great Dark Spot (southern), a high-pressure vortex.
      { lon: -32, lat: -22, rx: 11, ry: 6.8, core: 0x1d2b54, rim: 0x32477e, swirl: 0.55, wind: 2.0, alpha: 0.9 },
      // Bright methane companion clouds that hug the GDS.
      { lon: -18, lat: -27, rx: 3.0, ry: 1.4, core: 0xdfe8f2, rim: 0x9fb6d4, swirl: 0.25, wind: 2.0, alpha: 0.7 },
      // The "Scooter" — a fast bright cloud feature further south.
      { lon: 86, lat: -42, rx: 4.2, ry: 1.8, core: 0xd8e4f0, rim: 0x9bb2d2, swirl: 0.3, wind: 2.0, alpha: 0.65 },
    ],
  },
};

/** Whether this body has a giant cloud map (i.e. is one of the four giants). */
export function isGiantId(id: string): boolean {
  return id in GIANT_PROFILES;
}

const LUMA = (r: number, g: number, b: number): number => 0.3 * r + 0.59 * g + 0.11 * b;

/** Interpolate the belt/zone colour ramp at a latitude (deg), into `out`. */
function sampleBands(stops: readonly BandStop[], cols: readonly RGB[], lat: number, out: RGB): void {
  if (lat <= stops[0]!.lat) { const c = cols[0]!; out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return; }
  const n = stops.length;
  if (lat >= stops[n - 1]!.lat) { const c = cols[n - 1]!; out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return; }
  let i = 1;
  while (i < n && stops[i]!.lat < lat) i++;
  const a = stops[i - 1]!, b = stops[i]!;
  const ca = cols[i - 1]!, cb = cols[i]!;
  const t = (lat - a.lat) / (b.lat - a.lat);
  out[0] = ca[0] + (cb[0] - ca[0]) * t;
  out[1] = ca[1] + (cb[1] - ca[1]) * t;
  out[2] = ca[2] + (cb[2] - ca[2]) * t;
}

/**
 * Paint a giant's full equirectangular cloud map (2:1) as an RGBA buffer. Pure:
 * the caller blits this onto a canvas. `id` must be one of the four giants.
 */
export function paintGiant(id: string, w: number, h: number): Uint8ClampedArray {
  const profile = GIANT_PROFILES[id];
  if (!profile) throw new Error(`paintGiant: no profile for ${id}`);
  const noise = makeGiantNoise(hashStr(id + "/giant"));
  const cols = profile.stops.map((s) => hexToRgb(s.col));
  const fcol = hexToRgb(profile.filamentCol);
  const storms = profile.storms.map((s) => ({ ...s, c: hexToRgb(s.core), r: hexToRgb(s.rim) }));
  const hex = profile.hexagon;
  const hexJet = hex ? hexToRgb(hex.jet) : null;
  const hexVortex = hex ? hexToRgb(hex.vortex) : null;

  const out = new Uint8ClampedArray(w * h * 4);
  const base: RGB = [0, 0, 0];
  const above: RGB = [0, 0, 0];
  const below: RGB = [0, 0, 0];

  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    const lat = 90 - v * 180; // +90 (north) at the top row
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const lon = u * 360 - 180;

      // 1. Zonal domain warp: displace the latitude we read the bands at, so the
      //    belts wave and scallop instead of running as dead-straight rulers. Two
      //    octaves of differing scale give both a long undulation and finer curls.
      const warp =
        (noise(u, v, 4, profile.warpCellsX, profile.warpCellsY) - 0.5) * profile.warpDeg +
        (noise(u + 5.3, v + 2.7, 3, profile.warpCellsX * 2, profile.warpCellsY * 2) - 0.5) * profile.warpDeg * 0.45;
      const sLat = lat + warp;

      sampleBands(profile.stops, cols, sLat, base);
      let r = base[0], g = base[1], b = base[2];

      // 2. Fine cloud mottle, stretched east–west (the zonal-wind comb).
      const mottle = (noise(u + 9.1, v + 13.4, 3, profile.warpCellsX * 5, profile.warpCellsY * 6) - 0.5) * profile.detail;
      r = clamp01(r * (1 + mottle));
      g = clamp01(g * (1 + mottle));
      b = clamp01(b * (1 + mottle));

      // 3. Shear-line filaments: where the band colour changes fastest in latitude
      //    (belt↔zone edges), lay long thin streaks of bright cirrus — the
      //    turbulent festoons that ring those boundaries.
      if (profile.filament > 0) {
        sampleBands(profile.stops, cols, sLat - 2.2, above);
        sampleBands(profile.stops, cols, sLat + 2.2, below);
        const grad = Math.abs(LUMA(above[0], above[1], above[2]) - LUMA(below[0], below[1], below[2]));
        const edge = smoothstep(0.04, 0.22, grad);
        if (edge > 0) {
          const ridge = noise(u + 21.0, v + 4.0, 4, profile.warpCellsX, profile.warpCellsY * 16);
          const streak = clamp01((ridge - 0.45) / 0.55);
          const amt = profile.filament * edge * streak * streak;
          r = r + (fcol[0] - r) * amt;
          g = g + (fcol[1] - g) * amt;
          b = b + (fcol[2] - b) * amt;
        }
      }

      // 4. Storms — elliptical vortices with spiral shading.
      for (const s of storms) {
        let dlon = lon - s.lon;
        dlon = ((dlon + 540) % 360) - 180; // shortest way round
        const dlat = lat - s.lat;
        if (Math.abs(dlat) > s.ry * 1.4 || Math.abs(dlon) > s.rx * 1.4) continue;
        const nx = dlon / s.rx, ny = dlat / s.ry;
        const er = Math.hypot(nx, ny);
        if (er >= 1.18) continue;
        const cover = (1 - smoothstep(0.75, 1.12, er)) * s.alpha;
        if (cover <= 0) continue;
        // A turbulent vortex, not a clean spiral: a soft single arm wound with
        // radius, heavily broken up by storm-local noise so it reads as churning
        // cloud rather than a hypnotic coil.
        const ang = Math.atan2(ny, nx);
        const tex = noise(0.5 + nx * 0.55, 0.5 + ny * 0.55 + s.lat * 0.01, 3, 10, 10) - 0.5;
        const arm = Math.sin(ang + er * s.wind * Math.PI + tex * 5.0);
        const swirl = (arm * 0.55 + tex * 1.4) * s.swirl;
        const shade = 0.82 + 0.42 * swirl;
        // Core colour fading to the rim colour outward.
        const sr = (s.c[0] + (s.r[0] - s.c[0]) * er) * shade;
        const sg = (s.c[1] + (s.r[1] - s.c[1]) * er) * shade;
        const sb = (s.c[2] + (s.r[2] - s.c[2]) * er) * shade;
        r = r + (clamp01(sr) - r) * cover;
        g = g + (clamp01(sg) - g) * cover;
        b = b + (clamp01(sb) - b) * cover;
      }

      // 5. Saturn's polar hexagon: the six-sided north-polar jet. Modelled as a
      //    real regular hexagon — straight sides that pinch only ~15% at the six
      //    corners — not a sinusoidal lobe, which over-pinches into a flower/star.
      //    A polygon's edge sits at apothem/cos(angle-from-the-edge-normal); we
      //    soften that toward a circle by `round`. Pole-on it reads as the hexagon;
      //    the vortex "eye" is tinted inside.
      if (hex && hexJet && hexVortex && lat > hex.lat - 12) {
        const apo = 90 - hex.lat; // apothem colatitude (deg from the pole)
        const phi = (((((lon % 60) + 60) % 60) - 30) * Math.PI) / 180; // ∈ [-30°,30°]
        const poly = 1 / Math.cos(phi); // 1 at an edge midpoint → 1.1547 at a corner
        const edgeLat = 90 - apo * (1 + hex.round * (poly - 1));
        if (lat > edgeLat) {
          const tin = smoothstep(0, 4, lat - edgeLat);
          r += (hexVortex[0] - r) * 0.28 * tin;
          g += (hexVortex[1] - g) * 0.28 * tin;
          b += (hexVortex[2] - b) * 0.28 * tin;
        }
        const line = 1 - smoothstep(0, 1.4, Math.abs(lat - edgeLat));
        if (line > 0) {
          r += (hexJet[0] - r) * 0.5 * line;
          g += (hexJet[1] - g) * 0.5 * line;
          b += (hexJet[2] - b) * 0.5 * line;
        }
      }

      const i = (y * w + x) * 4;
      out[i] = (clamp01(r) * 255) | 0;
      out[i + 1] = (clamp01(g) * 255) | 0;
      out[i + 2] = (clamp01(b) * 255) | 0;
      out[i + 3] = 255;
    }
  }
  return out;
}

// ── Saturn's rings ────────────────────────────────────────────────────────────

/**
 * Paint Saturn's ring system as a 1-D radial RGBA strip (w × h, all rows equal)
 * that the RingGeometry samples inner→outer. The render span is the C-ring inner
 * edge to the A-ring outer edge (SATURN_RING_FRACTIONS), so real ring structure
 * maps onto it by radius fraction r∈[0,1]:
 *   C ring (faint grey) · B ring (bright, dense, warm) · Cassini Division (gap) ·
 *   A ring (medium) with the Encke and Keeler gaps near its outer edge.
 * Alpha carries optical density; thousands of fine ringlets ride on fractal noise.
 */
export function paintGiantRing(w: number, h: number): Uint8ClampedArray {
  const noise = makeGiantNoise(hashStr("saturn/ring"));
  const out = new Uint8ClampedArray(w * h * 4);

  // Region boundaries as fractions of the rendered span (see header).
  const C_OUT = 0.279, B_OUT = 0.690, CASS_OUT = 0.762;
  const ENCKE = 0.945, KEELER = 0.995;

  for (let x = 0; x < w; x++) {
    const r = (x + 0.5) / w; // 0 inner → 1 outer
    let dens: number, col: RGB;

    if (r < C_OUT) {
      // C ring: thin, translucent, grey — denser toward the B-ring boundary.
      dens = 0.16 + 0.20 * (r / C_OUT);
      col = [0.70, 0.66, 0.58];
    } else if (r < B_OUT) {
      // B ring: the bright, dense, warm-tan heart of the system, with broad
      // density swells across it.
      const f = (r - C_OUT) / (B_OUT - C_OUT);
      dens = 0.82 + 0.16 * Math.sin(f * Math.PI); // fullest mid-B
      col = [0.86, 0.79, 0.64];
    } else if (r < CASS_OUT) {
      // Cassini Division: a near-empty gap (some faint ringlets remain).
      dens = 0.05 + 0.06 * (1 - (r - B_OUT) / (CASS_OUT - B_OUT));
      col = [0.62, 0.58, 0.50];
    } else {
      // A ring: medium density, slightly cooler tan, with the two famous gaps.
      dens = 0.60;
      col = [0.80, 0.74, 0.62];
      dens *= 1 - 0.95 * Math.exp(-((r - ENCKE) * (r - ENCKE)) / (2 * 0.006 * 0.006));   // Encke gap
      dens *= 1 - 0.85 * Math.exp(-((r - KEELER) * (r - KEELER)) / (2 * 0.0025 * 0.0025)); // Keeler gap
    }

    // Thousands of fine ringlets: layered noise + a high-frequency ripple.
    const fine = noise(r, 0.5, 5, 220, 1) * 0.45 + noise(r, 0.5, 3, 40, 1) * 0.2;
    dens *= 0.72 + fine;
    const bright = 0.86 + 0.14 * Math.sin(r * 180.0);

    // Feather both rims to fully transparent.
    if (r < 0.02) dens *= clamp01(r / 0.02);
    else if (r > 0.985) dens *= clamp01((1 - r) / 0.015);

    dens = clamp01(dens);
    const a = (clamp01(dens) * 240) | 0;
    const rr = (clamp01(col[0] * bright) * 255) | 0;
    const gg = (clamp01(col[1] * bright) * 255) | 0;
    const bb = (clamp01(col[2] * bright) * 255) | 0;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      out[i] = rr; out[i + 1] = gg; out[i + 2] = bb; out[i + 3] = a;
    }
  }
  return out;
}
