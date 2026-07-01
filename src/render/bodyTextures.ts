/**
 * Procedural surface textures for the natural bodies.
 *
 * The project keeps zero binary assets — everything is computed. So instead of
 * shipping photographic NASA maps, each body's surface is *painted at startup*
 * onto a canvas and uploaded as a texture: granulation for the Sun, latitudinal
 * bands for the gas giants, oceans/ice for Earth, cratered noise for the airless
 * rocks. The result is an honest impression, not a claim of cartographic truth —
 * but it is keyed to the body's REAL data where that reads on screen:
 *
 *   - colour comes from each `BodyDef.color`;
 *   - the spin rate is the real `rotationPeriod` (retrograde falls out of its
 *     sign), applied per-frame in bodyViews;
 *   - an atmosphere shell appears only for bodies that actually have one, and its
 *     opacity scales with the real surface pressure (Venus opaque, Mars a whisper).
 *
 * Generation is deterministic: every body seeds its noise from a hash of its id,
 * so a given world looks identical on every reload — the same contract the sim
 * itself honours. This is the only place in the renderer allowed a PRNG, and it
 * runs once at construction, never in the frame loop.
 */

import * as THREE from "three";
import { type BodyDef, type BodyKind } from "@lightlag/engine/constants";
import { LAND_POLYS } from "./earthLand.ts";
import { BODY_FEATURES } from "./bodyFeatures.ts";
import { paintGiant, paintGiantRing } from "./gasGiant.ts";
import { paintRockySurface } from "./rockyBody.ts";

// ── Determinism ──────────────────────────────────────────────────────────────

/** FNV-1a string hash → 32-bit seed. */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small fast PRNG (mulberry32) — seeded, so textures are reproducible. */
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

// ── Colour helpers (operate on [r,g,b] in 0..1 to avoid per-pixel allocation) ──

type RGB = [number, number, number];

function hexToRgb(hex: number): RGB {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

function lerpRgb(a: RGB, b: RGB, t: number, out: RGB): RGB {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

/** Shift lightness (and optionally saturation/hue) of an sRGB colour via THREE.
 *  Allocates — only used a handful of times to build palettes, never per-pixel. */
function shade(hex: number, dl: number, ds = 0, dh = 0): RGB {
  const c = new THREE.Color(hex);
  c.offsetHSL(dh, ds, dl);
  return [c.r, c.g, c.b];
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

// ── Tileable fractal value noise ─────────────────────────────────────────────
//
// Horizontal tiling matters: the texture wraps in longitude, so a seam at u=0/1
// would show as a meridian scar. We hash an integer lattice and wrap the x index
// to a per-octave period, which makes every octave (and thus the sum) seamless
// in x. Latitude (y) never wraps — it terminates at the poles.

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
    const wx1 = ((x0 + 1) % periodX + periodX) % periodX;
    const v00 = hash(wx0, y0), v10 = hash(wx1, y0);
    const v01 = hash(wx0, y0 + 1), v11 = hash(wx1, y0 + 1);
    const a = v00 + (v10 - v00) * fx;
    const b = v01 + (v11 - v01) * fx;
    return a + (b - a) * fy;
  };

  // x,y expected in [0,1). Returns ~[0,1].
  return (x, y, octaves, baseCells) => {
    let amp = 0.5, sum = 0, norm = 0, freq = baseCells;
    for (let o = 0; o < octaves; o++) {
      // period in lattice cells == freq, so x*freq spans exactly [0,freq) → tiles.
      sum += amp * vnoise(x * freq, y * freq * 0.5, freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  };
}

// ── Tileable cellular (Worley) noise ─────────────────────────────────────────
//
// Solar granulation is a convection pattern: bright polygonal cells (granule tops)
// separated by narrow dark lanes where cooled plasma sinks. A cellular/Worley field
// captures exactly that, where value noise only gives a formless mottle. Feature
// points sit on a jittered integer lattice whose x index wraps to `cellsX`, so the
// field is seamless across the u=0/1 meridian; latitude never wraps (it ends at the
// poles). F1 (nearest feature) measures depth into a granule, F2−F1 proximity to a
// lane. Seeded off the shared PRNG so the Sun looks identical on every reload.

function makeCellular(rng: () => number): (x: number, y: number, cellsX: number, cellsY: number) => { f1: number; f2: number } {
  const perm = new Uint16Array(1024);
  for (let i = 0; i < 1024; i++) perm[i] = (rng() * 65536) & 0xffff;
  return (x, y, cellsX, cellsY) => {
    // Cell counts differ per axis (cellsY ≈ cellsX/2 on the 2:1 map) so the cells
    // stay round in pixels; distances are then Euclidean in cell-index space.
    const gx = x * cellsX, gy = y * cellsY;
    const xi = Math.floor(gx), yi = Math.floor(gy);
    let f1 = 1e9, f2 = 1e9;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cxi = xi + ox, cyi = yi + oy;
        const wx = ((cxi % cellsX) + cellsX) % cellsX; // wrap the x lattice → seamless
        const p = perm[(((wx * 73856093) ^ (cyi * 19349663)) >>> 0) & 1023]!;
        const fx = cxi + (p & 255) / 255;             // jittered feature point, placed
        const fy = cyi + ((p >> 8) & 255) / 255;      // adjacent to this pixel
        const dx = fx - gx, dy = fy - gy;
        const d = dx * dx + dy * dy;
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
      }
    }
    return { f1: Math.sqrt(f1), f2: Math.sqrt(f2) };
  };
}

// ── Canvas plumbing ──────────────────────────────────────────────────────────

interface Painted {
  canvas: HTMLCanvasElement;
  data: ImageData;
}

function makeCanvas(w: number, h: number): { ctx: CanvasRenderingContext2D; painted: Painted } {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const data = ctx.createImageData(w, h);
  return { ctx, painted: { canvas, data } };
}

/** Wrap a painted canvas as a texture. Pass `onCanvas` when the final pixels are
 *  already drawn directly on the canvas (e.g. after paintCraters) so we skip the
 *  redundant ImageData re-upload. */
function toTexture(painted: Painted, maxAniso: number, srgb: boolean, onCanvas = false): THREE.CanvasTexture {
  if (!onCanvas) painted.canvas.getContext("2d")!.putImageData(painted.data, 0, 0);
  const tex = new THREE.CanvasTexture(painted.canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping; // seamless in longitude
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = maxAniso;
  tex.needsUpdate = true;
  return tex;
}

function setPx(d: ImageData, i: number, r: number, g: number, b: number, a = 255): void {
  d.data[i] = (r * 255) | 0;
  d.data[i + 1] = (g * 255) | 0;
  d.data[i + 2] = (b * 255) | 0;
  d.data[i + 3] = a;
}

// ── Texture sizes by class (longitude × latitude, 2:1 equirectangular) ─────────

const TEX_W: Record<BodyKind, number> = {
  star: 1024,
  planet: 512,
  dwarf: 512,
  moon: 384,
  asteroid: 256,
  comet: 256,
  satellite: 128, // tiny man-made craft; sphere is sub-pixel
};

/** Per-body resolution bumps for the worlds players zoom into most closely. */
const TEX_W_OVERRIDE: Record<string, number> = {
  earth: 1024,
  jupiter: 1024,
  saturn: 1024,
};

/** Saturn's ring extent as multiples of the planet's EQUATORIAL radius: the C-ring
 *  inner edge (~1.24) and the A-ring outer edge (~2.27). bodyViews scales these by
 *  the equatorial radius, so the rendered disc lands on the real ring edges and the
 *  inner shepherd Pan falls inside the A ring. Exported so the renderer and its
 *  regression test share one definition. */
export const SATURN_RING_FRACTIONS = { inner: 1.24, outer: 2.27 };


// ── Public shape ─────────────────────────────────────────────────────────────

export interface BodyTextureSet {
  surface: THREE.Texture;
  bump?: THREE.Texture;
  bumpScale: number;
  roughness: number;
  metalness: number;
  /** Optional per-pixel roughness (Earth: glossy oceans for a sun-glint, matte land).
   *  Multiplies the scalar `roughness`, so set that to 1 when a map is supplied. */
  roughnessMap?: THREE.Texture;
  /** Optional semi-transparent atmosphere/cloud shell. */
  clouds?: THREE.Texture;
  cloudOpacity?: number;
  cloudColor?: number;
  cloudScale?: number; // shell radius as a multiple of the body radius
  /** Optional ring system (Saturn), radii as multiples of the body radius. */
  ring?: { texture: THREE.Texture; inner: number; outer: number };
  /** Optional atmospheric limb-scattering glow (a sun-lit Fresnel rim). */
  atmoGlow?: AtmoGlow;
  /** Axial tilt in radians (render-only, see OBLIQUITY_DEG). */
  obliquityRad: number;
}

/** Parameters for a body's atmospheric limb glow. `color` is the body's real
 *  observed sky/limb tint; `intensity` scales it (and may push the brightest arc
 *  over 1.0 so it blooms); `power` sets how tightly the glow hugs the limb (thick
 *  hazes spread, thin ones cling); `scale` is the shell radius as a multiple of
 *  the body radius. */
export interface AtmoGlow {
  color: number;
  intensity: number;
  power: number;
  scale: number;
}

/**
 * Atmospheric-glow tints, keyed to each world's *real* observed colour and gated
 * by the presence (and, via intensity, the thickness) of a real atmosphere:
 *   - Earth  — Rayleigh-scattered blue, the thin bright arc seen from orbit.
 *   - Venus  — a deep, bright sulphuric-acid haze, pale gold.
 *   - Mars   — a faint, dusty butterscotch-pink limb (the real Martian sky tint).
 *   - Titan  — a thick orange organic-haze shell (Huygens/Cassini colours).
 *   - Pluto  — the surprising blue haze layers New Horizons photographed.
 * `power` is lower (broader glow) for the thick hazes, higher (tighter) for thin
 * atmospheres, tracking how far up the visible scattering actually extends.
 */
const ATMO_GLOW: Record<string, AtmoGlow> = {
  earth: { color: 0x5aa0ff, intensity: 1.5, power: 3.2, scale: 1.03 },
  venus: { color: 0xf3e2ac, intensity: 1.7, power: 2.4, scale: 1.05 },
  mars: { color: 0xe7a886, intensity: 0.65, power: 4.3, scale: 1.02 },
  titan: { color: 0xe79a3c, intensity: 1.45, power: 2.6, scale: 1.05 },
  pluto: { color: 0x9bbbe6, intensity: 0.5, power: 4.5, scale: 1.03 },
};

// ── Painters ─────────────────────────────────────────────────────────────────

/**
 * The Sun's photosphere. Convective granulation is painted as a cellular (Worley)
 * field — bright polygonal granule interiors divided by the darker intergranular
 * lanes — over a coarser mesogranular layer and a slow supergranular brightness
 * mottle. Then real solar activity is stamped on top: sunspot groups (a very dark
 * umbra inside a lighter, radially filamented penumbra) at the active mid-latitudes,
 * ringed by bright faculae (the hot magnetic plage). All emissive (the material is
 * unlit) so it reads as a light source, and pulled toward the body's warm colour so
 * it stays solar rather than bleached.
 */
function paintStar(def: BodyDef, w: number, h: number, fbm: ReturnType<typeof makeFbm>, rng: () => number, maxAniso: number): THREE.Texture {
  const { painted } = makeCanvas(w, h);
  const cell = makeCellular(rng);
  const base = hexToRgb(def.color);
  const lane = shade(def.color, -0.20, 0.06); // cooler, redder intergranular lanes
  const gran = shade(def.color, 0.08, -0.02); // granule body
  const hot = shade(def.color, 0.30, -0.12);  // bright granule centres (toward white)
  const tmp: RGB = [0, 0, 0];

  // Fine granules over a coarser mesogranular field; cell counts scale with the
  // texture width and halve in latitude so the cells stay round on the 2:1 map.
  const fineX = Math.max(48, Math.round(w / 8));
  const fineY = Math.max(24, Math.round(fineX / 2));
  const mesoX = Math.max(16, Math.round(fineX / 3));
  const mesoY = Math.max(8, Math.round(mesoX / 2));

  for (let y = 0; y < h; y++) {
    const v = y / h;
    const latAbs = Math.abs(v - 0.5) * 2; // 0 at the equator → 1 at a pole
    // Equirectangular maps pinch all longitudes together at the poles, which smears
    // the granulation into radial streaks there. Taper the high-frequency granule
    // contrast toward the poles so the pinch reads as a smooth cap, not a swirl.
    const polar = clamp01((latAbs - 0.80) / 0.20);
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const f = cell(u, v, fineX, fineY);
      const laneF = clamp01((f.f2 - f.f1) / 0.22); // 0 in a lane → 1 in the granule interior
      const centF = clamp01(1 - f.f1 * 1.35);      // brightest toward the granule centre
      const m = cell(u + 3.3, v + 1.7, mesoX, mesoY);
      const laneM = clamp01((m.f2 - m.f1) / 0.24);
      const superg = fbm(u + 5.2, v + 2.7, 3, 4);   // slow supergranular brightness
      let g = 0.28 + 0.40 * laneF + 0.20 * centF + 0.14 * laneM;
      g = clamp01(g * (0.82 + 0.34 * superg));
      if (polar > 0) g = g + (0.5 + 0.22 * superg - g) * polar; // smooth the polar cap
      if (g < 0.5) lerpRgb(lane, gran, g / 0.5, tmp);
      else lerpRgb(gran, hot, (g - 0.5) / 0.5, tmp);
      lerpRgb(base, tmp, 0.82, tmp); // keep it solar, not bleached
      setPx(painted.data, (y * w + x) * 4, tmp[0], tmp[1], tmp[2]);
    }
  }

  // Sunspot groups + faculae, stamped on the canvas over the granulation.
  paintSunspots(painted, w, h, def.color, rng);
  return toTexture(painted, maxAniso, true, true);
}

/** Stamp a soft radial-gradient disc, wrapping across the u=0/1 seam when it
 *  straddles (shared by the Sun's faculae). */
function stampSoftDisc(ctx: CanvasRenderingContext2D, w: number, x: number, y: number, r: number, color: RGB, alpha: number): void {
  const xs = (x < r || x > w - r) ? [x, x < r ? x + w : x - w] : [x];
  for (const cx of xs) {
    const g = ctx.createRadialGradient(cx, y, 0, cx, y, r);
    g.addColorStop(0, rgbaStr(color, alpha));
    g.addColorStop(1, rgbaStr(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, y, r, 0, Math.PI * 2); ctx.fill();
  }
}

/**
 * Stamp a handful of sunspot groups at the active mid-latitudes — the ±5–35° bands
 * where the real Sun's magnetic flux erupts. Each group is a cluster of spots (a
 * dark umbra inside a lighter, radially filamented penumbra) surrounded by bright
 * faculae, the hot magnetic network that frames every active region. Deterministic
 * from the seeded PRNG; an impression of solar activity, not a dated observation.
 * Draws directly on the canvas and leaves the pixels there (build with onCanvas).
 */
function paintSunspots(surf: Painted, w: number, h: number, color: number, rng: () => number): void {
  const ctx = surf.canvas.getContext("2d")!;
  ctx.putImageData(surf.data, 0, 0);
  const umbra = shade(color, -0.72, 0.06);
  const penumbra = shade(color, -0.36, 0.02);
  const filament = shade(color, -0.24, 0.0);
  const facula = shade(color, 0.36, -0.10);
  const degPx = DEG_TO_PX(w);

  const groups = 5 + Math.floor(rng() * 4); // 5–8 active regions
  for (let gi = 0; gi < groups; gi++) {
    const sign = rng() < 0.5 ? -1 : 1;
    const lat = sign * (6 + rng() * 28);      // active latitudes ±6–34°
    const lon = rng() * 360 - 180;
    const spots = 2 + Math.floor(rng() * 4);  // 2–5 spots per group
    const spread = 6 + rng() * 12;            // angular size the group spans (deg)

    // Faculae field first (under the spots): a bright stipple around the region.
    for (let k = 0; k < 30; k++) {
      const fl = lon + (rng() - 0.5) * spread * 2.4;
      const fb = lat + (rng() - 0.5) * spread * 1.6;
      const [fx, fy] = lonLatToPx(fl, fb, w, h);
      stampSoftDisc(ctx, w, fx, fy, (0.4 + rng() * 1.1) * degPx, facula, 0.12 + rng() * 0.16);
    }

    for (let si = 0; si < spots; si++) {
      const sl = lon + (rng() - 0.5) * spread;
      const sb = lat + (rng() - 0.5) * spread * 0.7;
      const [sx, sy] = lonLatToPx(sl, sb, w, h);
      // The leading spot of a group is the largest; the rest are smaller followers.
      const rp = (si === 0 ? 3.0 + rng() * 3.0 : 1.4 + rng() * 2.6) * degPx; // penumbra radius
      const ru = rp * (0.42 + rng() * 0.20);    // umbra radius
      const xs = (sx < rp || sx > w - rp) ? [sx, sx < rp ? sx + w : sx - w] : [sx];
      for (const cx of xs) {
        // Penumbra disc.
        const pg = ctx.createRadialGradient(cx, sy, ru * 0.6, cx, sy, rp);
        pg.addColorStop(0, rgbaStr(penumbra, 0.92));
        pg.addColorStop(0.7, rgbaStr(penumbra, 0.78));
        pg.addColorStop(1, rgbaStr(penumbra, 0));
        ctx.fillStyle = pg;
        ctx.beginPath(); ctx.arc(cx, sy, rp, 0, Math.PI * 2); ctx.fill();
        // Radial penumbral filaments.
        ctx.strokeStyle = rgbaStr(filament, 0.5);
        ctx.lineWidth = Math.max(0.6, degPx * 0.4);
        const fils = 16 + Math.floor(rng() * 12);
        for (let fi = 0; fi < fils; fi++) {
          const a = (fi / fils) * Math.PI * 2 + rng() * 0.3;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * ru * 0.9, sy + Math.sin(a) * ru * 0.9);
          ctx.lineTo(cx + Math.cos(a) * rp * 0.98, sy + Math.sin(a) * rp * 0.98);
          ctx.stroke();
        }
        // Dark umbra core.
        const ug = ctx.createRadialGradient(cx, sy, 0, cx, sy, ru);
        ug.addColorStop(0, rgbaStr(umbra, 0.96));
        ug.addColorStop(0.75, rgbaStr(umbra, 0.9));
        ug.addColorStop(1, rgbaStr(umbra, 0));
        ctx.fillStyle = ug;
        ctx.beginPath(); ctx.arc(cx, sy, ru, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
}

/** Gas/ice giants: real belt/zone structure, zonal turbulence, shear-line
 *  filaments and signature storms (Jupiter's Great Red Spot & ovals, Neptune's
 *  Great Dark Spot, Saturn's polar hexagon). The pixel maths live in gasGiant.ts
 *  — kept DOM-free so the renderer and the offline preview share one definition;
 *  here we just blit the painted RGBA buffer onto the canvas and upload it. */
function paintGasGiant(def: BodyDef, w: number, h: number, maxAniso: number): { surface: THREE.Texture } {
  const { painted } = makeCanvas(w, h);
  painted.data.data.set(paintGiant(def.id, w, h));
  return { surface: toTexture(painted, maxAniso, true) };
}

// ── Real surface features ──────────────────────────────────────────────────
//
// The Jupiter-spot idea, generalised: a body's recognisable geography is a small
// table of REAL features (selenographic/areographic coordinates from the IAU
// gazetteer), stamped over the procedural base. Same contract as the coastlines —
// real data, drawn procedurally, zero image files. Four primitives cover it:
//   ellipse    — a soft-edged oval (maria, albedo regions, volcanic paterae)
//   polyline   — a stroked path (Europa's lineae, Valles Marineris, ridges)
//   cap        — everything poleward of a latitude (Triton's pink south cap)
//   hemisphere — a longitudinal darkening (Iapetus' two-tone leading face)
// Coordinates are east-positive degrees, mapped equirectangularly the same way
// the textures are: u = (lon+180)/360, v = (90−lat)/180.

export type FeatureShape = "ellipse" | "polyline" | "cap" | "hemisphere" | "global";
export type FeatureTone =
  | "much_darker" | "darker" | "slightly_darker" | "neutral"
  | "slightly_brighter" | "brighter" | "much_brighter";

export interface SurfaceFeature {
  name?: string;
  kind: string;
  shape: FeatureShape;
  /** Centre (ellipse/cap edge anchor); east-positive lon [-180,180], lat [-90,90]. */
  lon?: number;
  lat?: number;
  /** Angular semi-axes in degrees (ellipse). */
  semiMajorDeg?: number;
  semiMinorDeg?: number;
  /** Long-axis tilt in degrees (ellipse), optional. */
  orientationDeg?: number;
  /** Flat [lon,lat,lon,lat,…] for shape="polyline". */
  polyline?: number[];
  /** Stroke width in degrees for shape="polyline". */
  strokeWidthDeg?: number;
  /** Latitude where a polar cap ends (shape="cap"); sign picks the pole. */
  capEdgeLatDeg?: number;
  /** Longitude the darkened hemisphere is centred on (shape="hemisphere"). */
  hemisphereCenterLonDeg?: number;
  /** Brightness relative to the body base colour. */
  tone: FeatureTone;
  /** Optional explicit sRGB hex when the feature has a distinct hue. */
  toneHex?: number;
  /** Edge softness 0..1 (0 = crisp, 1 = fully feathered). Default 0.45. */
  softness?: number;
  /** Coverage alpha 0..1. Default 0.8 — lets underlying relief read through. */
  alpha?: number;
}

/** Map a relative tone to an RGB, working from the body's reference land/surface
 *  colour. Explicit hex wins when the feature carries its own hue. */
function toneToRgb(base: RGB, tone: FeatureTone, hex?: number): RGB {
  if (hex !== undefined) return hexToRgb(hex);
  const scale = (k: number): RGB => [base[0] * k, base[1] * k, base[2] * k];
  const toWhite = (t: number): RGB => [
    base[0] + (1 - base[0]) * t, base[1] + (1 - base[1]) * t, base[2] + (1 - base[2]) * t,
  ];
  switch (tone) {
    case "much_darker": return scale(0.42);
    case "darker": return scale(0.60);
    case "slightly_darker": return scale(0.80);
    case "slightly_brighter": return toWhite(0.20);
    case "brighter": return toWhite(0.36);
    case "much_brighter": return toWhite(0.58);
    default: return [base[0], base[1], base[2]];
  }
}

function rgbaStr(c: RGB, a: number): string {
  return `rgba(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0},${a})`;
}

/** lon/lat (deg) → canvas pixel. Equal degrees-per-pixel on both axes (2:1 map). */
function lonLatToPx(lon: number, lat: number, w: number, h: number): [number, number] {
  return [((lon + 180) / 360) * w, ((90 - lat) / 180) * h];
}
const DEG_TO_PX = (w: number): number => w / 360; // degrees → pixels (both axes)

/** Stamp a soft elliptical feature, wrapping across the u=0/1 seam when it straddles. */
function stampEllipse(ctx: CanvasRenderingContext2D, w: number, h: number, f: SurfaceFeature, color: RGB): void {
  const [cx, cy] = lonLatToPx(f.lon ?? 0, f.lat ?? 0, w, h);
  const rx = (f.semiMajorDeg ?? 5) * DEG_TO_PX(w);
  const ry = (f.semiMinorDeg ?? f.semiMajorDeg ?? 5) * DEG_TO_PX(w);
  const alpha = f.alpha ?? 0.8;
  const core = clamp01(1 - (f.softness ?? 0.45));
  const xs = (cx < rx || cx > w - rx) ? [cx, cx < rx ? cx + w : cx - w] : [cx];
  for (const x of xs) {
    ctx.save();
    ctx.translate(x, cy);
    if (f.orientationDeg) ctx.rotate((f.orientationDeg * Math.PI) / 180);
    ctx.scale(rx, Math.max(ry, 0.0001));
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, rgbaStr(color, alpha));
    g.addColorStop(core, rgbaStr(color, alpha));
    g.addColorStop(1, rgbaStr(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** Stroke a lon/lat path. Segments that jump the antimeridian are lifted, not
 *  smeared horizontally across the whole map. */
function stampPolyline(ctx: CanvasRenderingContext2D, w: number, h: number, f: SurfaceFeature, color: RGB): void {
  const pts = f.polyline;
  if (!pts || pts.length < 4) return;
  ctx.save();
  ctx.strokeStyle = rgbaStr(color, f.alpha ?? 0.7);
  ctx.lineWidth = Math.max(1, (f.strokeWidthDeg ?? 1.2) * DEG_TO_PX(w));
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let started = false, prevX = 0;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i += 2) {
    const [x, y] = lonLatToPx(pts[i]!, pts[i + 1]!, w, h);
    if (started && Math.abs(x - prevX) > w / 2) { ctx.stroke(); ctx.beginPath(); started = false; }
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    prevX = x;
  }
  ctx.stroke();
  ctx.restore();
}

/** Fill a polar cap: full coverage poleward of capEdgeLat, feathered only in a
 *  narrow band at the edge (so the cap actually reads, not just a thin rim). */
function stampCap(ctx: CanvasRenderingContext2D, w: number, h: number, f: SurfaceFeature, color: RGB): void {
  const edge = f.capEdgeLatDeg ?? (f.lat ?? 70);
  const yEdge = ((90 - edge) / 180) * h;
  const north = edge > 0;
  const band = Math.max(6, 0.06 * h); // feather band near the edge only
  const a = f.alpha ?? 0.85;
  // Transparent exactly at the edge, ramping to full alpha within `band` toward
  // the pole; the gradient clamps to full beyond that, so the rest of the cap is
  // solid.
  const g = north
    ? ctx.createLinearGradient(0, yEdge, 0, yEdge - band)
    : ctx.createLinearGradient(0, yEdge, 0, yEdge + band);
  g.addColorStop(0, rgbaStr(color, 0));
  g.addColorStop(1, rgbaStr(color, a));
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, north ? 0 : yEdge, w, north ? yEdge : (h - yEdge));
  ctx.restore();
}

/** A faint procedural web of reddish hairline cracks for Europa, drawn under the
 *  named lineae to sell the "cracked ice" look the dozen catalogued bands can't
 *  carry alone. Deterministic from the body's seeded PRNG; clearly an impression,
 *  not catalogued geography. */
function paintEuropaWeb(p: Painted, w: number, h: number, rng: () => number): void {
  const ctx = p.canvas.getContext("2d")!;
  ctx.save();
  ctx.lineCap = "round";
  for (let i = 0; i < 52; i++) {
    const lon0 = rng() * 360 - 180;
    const lat0 = rng() * 150 - 75;
    const ang = rng() * Math.PI * 2;
    const len = 8 + rng() * 42; // degrees
    const curve = (rng() - 0.5) * len * 0.25;
    ctx.strokeStyle = `rgba(150,105,80,${(0.08 + rng() * 0.12).toFixed(3)})`;
    ctx.lineWidth = 0.6 + rng() * 0.8;
    ctx.beginPath();
    let prevX: number | null = null;
    const segs = 6;
    for (let s = 0; s <= segs; s++) {
      const fr = s / segs;
      const lon = lon0 + Math.cos(ang) * len * fr;
      const lat = lat0 + Math.sin(ang) * len * fr + Math.sin(fr * Math.PI) * curve;
      const [x, y] = lonLatToPx(lon, lat, w, h);
      if (prevX !== null && Math.abs(x - prevX) > w / 2) { ctx.stroke(); ctx.beginPath(); prevX = null; }
      if (prevX === null) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      prevX = x;
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Tint the entire surface toward a colour (Europa's icy base over its tan
 *  default). Operates per-pixel on the supplied ImageData. */
function applyGlobal(img: ImageData, color: RGB, a: number): void {
  const d = img.data;
  const r = color[0] * 255, g = color[1] * 255, b = color[2] * 255;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = (d[i]! + (r - d[i]!) * a) | 0;
    d[i + 1] = (d[i + 1]! + (g - d[i + 1]!) * a) | 0;
    d[i + 2] = (d[i + 2]! + (b - d[i + 2]!) * a) | 0;
  }
}

/** Darken/recolour a whole hemisphere by a cosine falloff in longitude
 *  (Iapetus). Operates per-pixel on the supplied ImageData. */
function applyHemisphere(img: ImageData, w: number, h: number, f: SurfaceFeature, color: RGB): void {
  const c0 = ((f.hemisphereCenterLonDeg ?? f.lon ?? 0) + 180) / 360; // 0..1 centre in u
  const a = f.alpha ?? 0.9;
  const d = img.data;
  for (let x = 0; x < w; x++) {
    const u = x / w;
    let du = Math.abs(u - c0);
    if (du > 0.5) du = 1 - du; // wrap
    // Solid across the whole hemisphere (du up to ~0.19 ≈ 68°), then a quick fade
    // to nothing at the ±90° boundary meridians — so opposing hemispheres (Iapetus'
    // dark leading / bright trailing) hand off cleanly instead of bleeding.
    const wgt = clamp01((0.25 - du) / 0.06) * a;
    if (wgt <= 0) continue;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      d[i] = (d[i]! + (color[0] * 255 - d[i]!) * wgt) | 0;
      d[i + 1] = (d[i + 1]! + (color[1] * 255 - d[i + 1]!) * wgt) | 0;
      d[i + 2] = (d[i + 2]! + (color[2] * 255 - d[i + 2]!) * wgt) | 0;
    }
  }
}

/** Nudge the bump map for features with real relief: mountains rise, basins and
 *  canyons sink. Subtle — the relief should read, not cartoon. */
function stampFeatureBump(bctx: CanvasRenderingContext2D, w: number, h: number, f: SurfaceFeature): void {
  const raise = f.kind === "mountain";
  const sink = f.kind === "mare" || f.kind === "basin" || f.kind === "linea" || f.kind === "patera"
    || f.kind === "crater" || f.kind === "groove";
  if (!raise && !sink) return;
  const tone: RGB = raise ? [0.85, 0.85, 0.85] : [0.4, 0.4, 0.4];
  if (f.shape === "ellipse") stampEllipse(bctx, w, h, { ...f, alpha: 0.5, softness: 0.7 }, tone);
  else if (f.shape === "polyline") stampPolyline(bctx, w, h, { ...f, alpha: 0.5 }, tone);
}

/** Stamp a body's whole feature table over the (already-current) canvas. The
 *  caller must have flushed its pixels onto the canvas first; the final pixels
 *  are left on the canvas, so build the texture with onCanvas=true. */
function paintFeatures(
  surf: Painted, bump: Painted | null, w: number, h: number,
  features: readonly SurfaceFeature[], base: RGB,
): void {
  const ctx = surf.canvas.getContext("2d")!;
  const bctx = bump ? bump.canvas.getContext("2d")! : null;

  // Global tints and hemisphere recolours act on the base coat first (per-pixel),
  // under the stamps.
  const perPixel = features.filter((f) => f.shape === "global" || f.shape === "hemisphere");
  if (perPixel.length) {
    const img = ctx.getImageData(0, 0, w, h);
    for (const f of perPixel) {
      const color = toneToRgb(base, f.tone, f.toneHex);
      if (f.shape === "global") applyGlobal(img, color, f.alpha ?? 0.5);
      else applyHemisphere(img, w, h, f, color);
    }
    ctx.putImageData(img, 0, 0);
  }

  for (const f of features) {
    if (f.shape === "hemisphere" || f.shape === "global") continue;
    const color = toneToRgb(base, f.tone, f.toneHex);
    if (f.shape === "ellipse") stampEllipse(ctx, w, h, f, color);
    else if (f.shape === "polyline") stampPolyline(ctx, w, h, f, color);
    else if (f.shape === "cap") stampCap(ctx, w, h, f, color);
    if (bctx) stampFeatureBump(bctx, w, h, f);
  }
}

/** Rasterise the real coastline polygons (earthLand.ts) into a land-coverage
 *  field: 1 = land, 0 = sea, with anti-aliased shores (fractional coverage) the
 *  painter reads to find the waterline. Each landmass is filled with the even-odd
 *  rule so its interior seas/lakes punch back to ocean, and the whole set is drawn
 *  three times — at x−w, x and x+w — so masses crossing the ±180° antimeridian
 *  wrap seamlessly. Returns a Float32 coverage array of length w*h. */
function buildLandMask(w: number, h: number): Float32Array {
  const { ctx } = makeCanvas(w, h);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#fff";
  for (const dx of [-w, 0, w]) {
    for (const land of LAND_POLYS) {
      ctx.beginPath();
      for (const ring of land) {
        for (let i = 0; i < ring.length; i += 2) {
          const [px, py] = lonLatToPx(ring[i]!, ring[i + 1]!, w, h);
          if (i === 0) ctx.moveTo(px + dx, py); else ctx.lineTo(px + dx, py);
        }
        ctx.closePath();
      }
      ctx.fill("evenodd");
    }
  }
  const data = ctx.getImageData(0, 0, w, h).data;
  const mask = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = data[i * 4]! / 255;
  return mask;
}

/** Coast-proximity field: a separable box-blur of the land mask (wraps in longitude,
 *  clamps in latitude). An ocean pixel's value is the fraction of land within `radius`
 *  — high just off a coast, ~0 in the open ocean — which the Earth painter turns into
 *  a continental-shelf → abyssal-plain depth ramp. O(w·h), runs once at startup. */
function coastProximity(land: Float32Array, w: number, h: number, radius: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const norm = 1 / (2 * radius + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += land[row + (((k % w) + w) % w)]!;
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum * norm;
      const xout = ((x - radius) % w + w) % w, xin = ((x + radius + 1) % w + w) % w;
      sum += land[row + xin]! - land[row + xout]!;
    }
  }
  const cy = (k: number): number => (k < 0 ? 0 : k >= h ? h - 1 : k);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += tmp[cy(k) * w + x]!;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum * norm;
      sum += tmp[cy(y + radius + 1) * w + x]! - tmp[cy(y - radius) * w + x]!;
    }
  }
  return out;
}

/** Sample the land-coverage field, wrapping in longitude and clamping in latitude. */
function sampleMask(mask: Float32Array, w: number, h: number, u: number, v: number): number {
  let xi = Math.floor((((u % 1) + 1) % 1) * w);
  if (xi >= w) xi = w - 1;
  let yi = Math.floor(clamp01(v) * h);
  if (yi >= h) yi = h - 1;
  return mask[yi * w + xi]!;
}

/** Earth: a recognisable blue marble — real coastlines (earthLand.ts) rasterised
 *  into a land/sea mask, oceans graded by real bathymetry (turquoise shelves →
 *  abyssal navy from the coast-proximity field), land tinted by latitude biome and
 *  by real desert/forest/ice regions, and polar ice. Returns a bump map (land stands
 *  proud of the sea) and a roughness map (glossy oceans for a sun-glint, matte land). */
function paintEarth(w: number, h: number, fbm: ReturnType<typeof makeFbm>, maxAniso: number): { surface: THREE.Texture; bump: THREE.Texture; roughness: THREE.Texture } {
  const { painted } = makeCanvas(w, h);
  const { painted: bump } = makeCanvas(w, h);
  const { painted: rough } = makeCanvas(w, h);
  const land = buildLandMask(w, h);
  // Continental shelves span a few percent of the map; blur the mask by that to get
  // each ocean pixel's distance-from-coast, which drives the depth ramp.
  const prox = coastProximity(land, w, h, Math.max(2, Math.round(w * 0.045)));

  const shelf: RGB = hexToRgb(0x2b7ba0);  // shallow continental-shelf turquoise
  const basin: RGB = hexToRgb(0x18466f);  // mid-ocean
  const abyss: RGB = hexToRgb(0x0b2748);  // deep abyssal navy
  const desert: RGB = hexToRgb(0xbda478);
  const forest: RGB = hexToRgb(0x46663a);
  const tundra: RGB = hexToRgb(0x83836f);
  const rock: RGB = hexToRgb(0x8a7c68);   // barren highland rock/scree
  const snow: RGB = hexToRgb(0xeaeff4);   // alpine / polar snow on the peaks
  const ice: RGB = hexToRgb(0xdde7ee);
  const tmp: RGB = [0, 0, 0];

  // Ragged the 1:110m coastline: a little domain warp before sampling the mask
  // breaks up the simplification's straight segments into a natural shore.
  const COAST_WARP = 0.006;

  for (let y = 0; y < h; y++) {
    const v = y / h;
    const lat = Math.abs(v - 0.5) * 2; // 0 equator → 1 pole
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const wu = u + (fbm(u + 20.0, v + 20.0, 4, 6) - 0.5) * COAST_WARP;
      const wv = clamp01(v + (fbm(u + 30.0, v + 10.0, 4, 6) - 0.5) * COAST_WARP * 0.5);
      const cov = sampleMask(land, w, h, wu, wv);
      const i = (y * w + x) * 4;
      let roughV: number;
      if (cov < 0.5) {
        // Sea — depth from the coast-proximity field: shelf turquoise near land,
        // through the mid-ocean tone, to abyssal navy in the open ocean. A faint
        // tropical-bank brightening warms shallow water near the equator.
        const openness = clamp01(1 - prox[y * w + x]! * 2.2);
        if (openness < 0.5) lerpRgb(shelf, basin, openness * 2, tmp);
        else lerpRgb(basin, abyss, (openness - 0.5) * 2, tmp);
        if (lat < 0.35 && openness < 0.4) lerpRgb(tmp, hexToRgb(0x37a7bf), (0.4 - openness) * 0.6, tmp);
        setPx(painted.data, i, tmp[0], tmp[1], tmp[2]);
        setPx(bump.data, i, 0.35, 0.35, 0.35);
        roughV = 0.34 + (1 - openness) * 0.12; // deep water glossiest → shelves a touch rougher
      } else {
        // Land — a real elevation field (broad continental undulation + ridged
        // mountain belts + fine detail) drives BOTH the colour and a higher-contrast
        // relief map, so the surface reads as textured terrain instead of a flat
        // painted wash: lush green lowlands rise through barren highland rock to
        // alpine/polar snow on the peaks, and the ridges cut sharp normals the lit
        // globe shades like the cratered worlds.
        const cont = fbm(u + 9.0, v + 2.0, 5, 10);        // broad continental relief
        const rn = fbm(u + 50.0, v + 15.0, 5, 20);
        const ridge = 1 - Math.abs(rn * 2 - 1);           // sharp mountain ridges
        const detail = fbm(u + 70.0, v + 40.0, 4, 64);    // fine surface roughness
        const elev = clamp01(cont * 0.5 + ridge * ridge * 0.4 + detail * 0.1);

        const warm = clamp01(1 - lat * 1.3);
        lerpRgb(tundra, forest, warm, tmp);
        lerpRgb(tmp, desert, clamp01((warm - 0.5) * 1.6), tmp);
        lerpRgb(tmp, rock, clamp01((elev - 0.6) * 2.4), tmp);           // barren highlands
        const snowLine = 0.82 - lat * 0.30;                             // lower toward the poles
        if (elev > snowLine) lerpRgb(tmp, snow, clamp01((elev - snowLine) * 3.0), tmp);
        const k = 0.82 + detail * 0.26; // fine mottle
        tmp[0] = clamp01(tmp[0] * k);
        tmp[1] = clamp01(tmp[1] * k);
        tmp[2] = clamp01(tmp[2] * k);
        setPx(painted.data, i, tmp[0], tmp[1], tmp[2]);
        // Relief centred on the datum: valleys below, ridges above, plus fine detail
        // for sharper normals than the old low-amplitude single-octave field.
        const b = clamp01(0.5 + (elev - 0.45) * 0.85 + (detail - 0.5) * 0.22);
        setPx(bump.data, i, b, b, b);
        roughV = 0.9; // matte land
      }
      // Polar ice caps blended over everything near the poles.
      if (lat > 0.82) {
        const t = clamp01((lat - 0.82) / 0.18);
        const cur: RGB = [painted.data.data[i]! / 255, painted.data.data[i + 1]! / 255, painted.data.data[i + 2]! / 255];
        lerpRgb(cur, ice, t, tmp);
        setPx(painted.data, i, tmp[0], tmp[1], tmp[2]);
        const cb = bump.data.data[i]! / 255;
        const nb = cb + (0.7 - cb) * t;
        setPx(bump.data, i, nb, nb, nb);
        roughV = roughV + (0.6 - roughV) * t; // ice: matte-ish, between glossy sea and dry land
      }
      setPx(rough.data, i, roughV, roughV, roughV);
    }
  }

  // Real large-scale regions (deserts/forests/ice sheets/ranges) over the land.
  const features = BODY_FEATURES.earth;
  const onCanvas = !!features?.length;
  if (onCanvas) {
    painted.canvas.getContext("2d")!.putImageData(painted.data, 0, 0);
    bump.canvas.getContext("2d")!.putImageData(bump.data, 0, 0);
    paintFeatures(painted, bump, w, h, features!, hexToRgb(0x5b6b48));
  }
  return {
    surface: toTexture(painted, maxAniso, true, onCanvas),
    bump: toTexture(bump, maxAniso, false, onCanvas),
    roughness: toTexture(rough, maxAniso, false),
  };
}

/** Rocky / icy / small bodies: a regolith with a real impact population and a
 *  matching relief map, synthesised by the pure rockyBody module (multi-octave
 *  terrain + power-law craters with rims/floors/peaks/ejecta/rays), then the real
 *  named features (maria, albedo regions, lineae, polar caps) stamped over it. Mars
 *  gets its dusky mare field from the same pure base; the layered polar caps and
 *  volcanoes ride on top from the feature table. */
function paintRocky(def: BodyDef, w: number, h: number, rng: () => number, maxAniso: number): { surface: THREE.Texture; bump?: THREE.Texture } {
  const { painted } = makeCanvas(w, h);
  // Tiny bodies (asteroids/comets) never fill enough screen for a bump map's
  // relief to read — skip the extra canvas and GPU texture.
  const wantsBump = def.kind !== "asteroid" && def.kind !== "comet";
  const bump: Painted | null = wantsBump ? makeCanvas(w, h).painted : null;

  // Crater count trimmed for young resurfaced worlds (Io/Europa's volcanism & ice
  // erase impacts; Triton and Pluto's nitrogen plains are young too) and cloud-hidden
  // ones (Venus/Titan — the surface never shows, so spend almost nothing on it).
  // Everything else — Mercury, the Moon, Mars, the asteroids and outer moons — wears
  // its class default.
  let craterScale = 1;
  if (def.id === "io" || def.id === "europa") craterScale = 0.05;
  else if (def.id === "triton") craterScale = 0.3;
  else if (def.id === "pluto") craterScale = 0.15;
  else if (def.id === "venus" || def.id === "titan") craterScale = 0.12;

  const rocky = paintRockySurface({ id: def.id, color: def.color, kind: def.kind, w, h, craterScale });
  painted.data.data.set(rocky.surface);
  painted.canvas.getContext("2d")!.putImageData(painted.data, 0, 0);
  if (bump) {
    bump.data.data.set(rocky.bump);
    bump.canvas.getContext("2d")!.putImageData(bump.data, 0, 0);
  }

  // Real named features (maria, albedo regions, lineae, polar caps) stamped over
  // the crater base — semi-transparent, so the relief still reads through them.
  const features = BODY_FEATURES[def.id];
  if (features?.length) paintFeatures(painted, bump, w, h, features, hexToRgb(def.color));
  if (def.id === "europa") paintEuropaWeb(painted, w, h, rng);

  // Every path has drawn the final pixels straight onto the canvases, so build the
  // textures from them (no ImageData re-upload).
  return {
    surface: toTexture(painted, maxAniso, true, true),
    bump: bump ? toTexture(bump, maxAniso, false, true) : undefined,
  };
}

/** Broken-cloud / haze shell texture (white, with alpha from fractal noise).
 *  Opaqueness is decided by the caller from real surface pressure. */
function paintClouds(def: BodyDef, fbm: ReturnType<typeof makeFbm>, maxAniso: number): THREE.Texture {
  const w = 512, h = 256;
  const { painted } = makeCanvas(w, h);
  // Venus and Earth get their own structured cloud fields; Titan stays a near-opaque
  // organic-haze blanket and everything else (Mars) gets thin broken wisps.
  if (def.id === "venus") paintVenusClouds(painted, fbm, w, h);
  else if (def.id === "earth") paintEarthClouds(painted, fbm, w, h);
  else {
    const fullCover = def.id === "titan";
    const coverage = 0.45; // fraction of the noise field that stays clear (broken case)
    for (let y = 0; y < h; y++) {
      const v = y / h;
      for (let x = 0; x < w; x++) {
        const u = x / w;
        const c = fbm(u + 12.0, v + 7.0, 5, 6);
        const broken = clamp01((c - coverage) / (1 - coverage));
        const alpha = fullCover ? 0.82 + 0.18 * c : broken * broken;
        // Near-white clouds (held just below 1 so the lit limb doesn't blow out);
        // the shell material tints them with each body's haze colour.
        setPx(painted.data, (y * w + x) * 4, 0.94, 0.94, 0.94, (clamp01(alpha) * 255) | 0);
      }
    }
  }
  return toTexture(painted, maxAniso, true);
}

/** Venus: a near-opaque sulfuric-acid deck. In the visible it is almost featureless
 *  creamy gold, but it carries the UV super-rotation structure just discernibly — the
 *  dark sideways-"Y" wrapping the equator, mid-latitude streaks sheared by the 4-day
 *  winds, and brighter polar hoods ringed by a darker collar. Kept subtle (the darkest
 *  marking within ~15% of the base) so it reads as banded Venus, not a false-colour
 *  poster; the shell material tints the near-neutral values gold. */
function paintVenusClouds(p: Painted, fbm: ReturnType<typeof makeFbm>, w: number, h: number): void {
  const lonC = 0.18; // the Y's stem longitude (cosmetic — the deck super-rotates in-sim)
  for (let y = 0; y < h; y++) {
    const v = y / h;
    const lat0 = Math.abs(v - 0.5) * 2; // 0 equator → 1 pole
    for (let x = 0; x < w; x++) {
      const u = x / w;
      // Super-rotation shear: skew longitude by latitude (strongest at the equator)
      // so the streaks comb into long 4-day curves.
      const us = u + 0.35 * (1 - lat0) * (v - 0.5);
      const streak = fbm(us + 3.0, v * 0.35 + 1.0, 5, 10);
      // The dark sideways-Y: two arms fanning from the equator, low-frequency, softened.
      let dlon = us - lonC; dlon -= Math.round(dlon);
      const arm = Math.abs(v - 0.5) - 0.18 * Math.abs(dlon);
      let ymask = smoothstep(0.22, 0.0, arm) * smoothstep(0.5, 0.15, Math.abs(dlon));
      ymask *= 0.6 + 0.4 * fbm(u + 5.0, v + 5.0, 3, 3);
      // Bright polar hood with a slightly darker collar just equatorward of it.
      const hood = smoothstep(0.80, 0.95, lat0);
      const collar = smoothstep(0.62, 0.72, lat0) * (1 - smoothstep(0.78, 0.86, lat0));
      let val = 0.92 * (1 + 0.05 * smoothstep(0.55, 1.0, lat0));
      val += (streak - 0.5) * 0.08;
      val *= (1 - 0.15 * ymask) * (1 + 0.08 * hood) * (1 - 0.10 * collar);
      val = clamp01(val);
      setPx(p.data, (y * w + x) * 4, val * 0.98, val * 0.98, val * 0.98, ((0.9 + 0.1 * val) * 255) | 0);
    }
  }
}

/** Earth: structured broken cloud instead of uniform stipple — a bright equatorial
 *  ITCZ band, clear subtropical zones (so the Sahara/Australia read cloud-free), and
 *  stormy mid-latitude belts whose noise is curled by a low-frequency angle field into
 *  comma-shaped frontal systems. */
function paintEarthClouds(p: Painted, fbm: ReturnType<typeof makeFbm>, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    const v = y / h;
    const lat0 = Math.abs(v - 0.5) * 2;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      // Cyclonic swirl: displace the noise lookup along a slowly-varying angle field,
      // ramped up through the mid-latitudes, so cloud masses read as fronts not blobs.
      const ang = (fbm(u + 40.0, v + 40.0, 2, 3) - 0.5) * 6.283;
      const swirl = 0.06 * smoothstep(0.35, 0.72, lat0);
      const c = fbm(u + Math.cos(ang) * swirl + 12.0, v + Math.sin(ang) * swirl + 7.0, 5, 7);
      // Latitude coverage envelope: ITCZ + stormy mid-latitudes, dry subtropics.
      const itcz = Math.exp(-(((lat0 - 0.06) / 0.07) ** 2));
      const midlat = smoothstep(0.42, 0.72, lat0);
      const subtropClear = 1 - Math.exp(-(((lat0 - 0.28) / 0.10) ** 2));
      let cover = (0.5 * itcz + 0.75 * midlat) * (0.35 + 0.65 * subtropClear);
      cover = clamp01(cover + 0.15); // a little scattered fair-weather cloud everywhere
      const broken = clamp01((c - 0.45) / 0.55);
      const alpha = clamp01(cover * broken * broken * 1.3);
      setPx(p.data, (y * w + x) * 4, 0.95, 0.95, 0.95, (alpha * 255) | 0);
    }
  }
}

/** Saturn's ring texture: a 1-D radial profile sampled by the RingGeometry —
 *  real ring regions (C/B/Cassini/A with the Encke & Keeler gaps) plus fine
 *  ringlets, painted in gasGiant.ts and blitted here. */
function paintRing(maxAniso: number): THREE.Texture {
  const w = 1024, h = 8;
  const { painted } = makeCanvas(w, h);
  painted.data.data.set(paintGiantRing(w, h));
  return toTexture(painted, maxAniso, true);
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Build the full texture set for one body. Called once per body at startup.
 * `maxAniso` comes from the renderer's capabilities for crisp grazing angles.
 */
export function createBodyTextures(def: BodyDef, maxAniso: number): BodyTextureSet {
  const rng = mulberry32(hashStr(def.id));
  const fbm = makeFbm(rng);
  const w = TEX_W_OVERRIDE[def.id] ?? TEX_W[def.kind];
  const h = w / 2;
  // Obliquity now lives in the body data (core/constants), so the engine and the
  // renderer tilt the spin axis by the SAME angle — a landed pad co-rotates with the
  // visibly tilted globe instead of drifting across it.
  const obliquityRad = (def.obliquityDeg ?? 0) * (Math.PI / 180);

  // Surface + (where relevant) bump.
  let surface: THREE.Texture;
  let bump: THREE.Texture | undefined;
  let roughnessMap: THREE.Texture | undefined;
  let roughness = 0.92;
  const metalness = 0;

  const isGiant = def.kind === "planet" && !def.hasSurface; // gas giants have no surface
  if (def.kind === "star") {
    surface = paintStar(def, w, h, fbm, rng, maxAniso);
    roughness = 1;
  } else if (isGiant) {
    surface = paintGasGiant(def, w, h, maxAniso).surface;
    roughness = 1; // fluid, no specular highlight
  } else if (def.id === "earth") {
    const e = paintEarth(w, h, fbm, maxAniso);
    surface = e.surface;
    bump = e.bump;
    roughnessMap = e.roughness;
    roughness = 1; // the per-pixel map carries the real values (glossy sea, matte land)
  } else {
    const r = paintRocky(def, w, h, rng, maxAniso);
    surface = r.surface;
    bump = r.bump;
    // Icy bodies get a slight sheen; dusty rock stays matte. Includes the bright
    // icy ring-shepherds/inner moons added with the expanded set (Saturn's
    // co-orbitals, Neptune's & Uranus's inner regulars); dark captured irregulars
    // (Phoebe, the Jovian/Uranian irregulars) and the reddish TNOs stay matte.
    const icy = [
      "europa", "enceladus", "tethys", "dione", "rhea", "mimas", "charon", "triton", "eris", "haumea",
      "pan", "atlas", "prometheus", "pandora", "epimetheus", "janus",
      "puck", "portia", "cressida",
      "naiad", "thalassa", "despina", "galatea", "larissa", "proteus",
    ].includes(def.id);
    roughness = icy ? 0.5 : 0.95;
  }

  const set: BodyTextureSet = {
    surface,
    bump,
    // Earth's land carries finer, sharper relief than the cratered rocks, and its
    // ocean bump is flat, so it can take a stronger bump scale without over-embossing.
    bumpScale: bump ? (def.id === "earth" ? 0.03 : 0.02) : 0, // gas giants/star carry no bump map
    roughness,
    metalness,
    obliquityRad,
  };
  if (roughnessMap) set.roughnessMap = roughnessMap;

  // Atmosphere shell, opacity from real surface pressure (log-scaled).
  if (def.atmosphere) {
    const p = def.atmosphere.surfacePressure;
    // ~1 Pa → invisible, ~1e5 Pa (Earth) → broken, ~1e7 Pa (Venus) → opaque.
    let opacity = clamp01((Math.log10(Math.max(p, 1)) - 1.5) / 5.5);
    // Venus and Titan read as essentially opaque hazes — keep their shells dense
    // even though Titan's pressure alone lands in the "broken" band.
    if (def.id === "venus" || def.id === "titan") opacity = Math.max(opacity, 0.95);
    if (opacity > 0.02) {
      set.clouds = paintClouds(def, fbm, maxAniso);
      set.cloudOpacity = opacity;
      set.cloudColor =
        def.id === "venus" ? 0xe8d9a8 :
        def.id === "titan" ? 0xd9913f :
        def.id === "mars" ? 0xd8b89a : 0xffffff;
      set.cloudScale = 1.025;
    }
    // Sun-lit limb-scattering glow, where we have a real tint for the body.
    if (ATMO_GLOW[def.id]) set.atmoGlow = ATMO_GLOW[def.id];
  }

  // Saturn's rings (the one body where their absence reads as a bug).
  if (def.id === "saturn") {
    set.ring = { texture: paintRing(maxAniso), inner: SATURN_RING_FRACTIONS.inner, outer: SATURN_RING_FRACTIONS.outer };
  }

  return set;
}

/**
 * A structured corona sprite texture: a tight bright inner glow surrounded by a
 * long faint halo that is modulated by angular helmet-streamer lobes (a sum of
 * random harmonics), so the Sun's outer atmosphere radiates in uneven spokes rather
 * than as a flat disc. Luminance is baked into the alpha with white RGB, so the
 * sprite material multiplies in any HDR colour; the renderer layers two of these
 * (counter-rotating and breathing) into a living corona. Seeded for determinism.
 */
export function makeCoronaTexture(seed: number, maxAniso: number): THREE.Texture {
  const size = 512;
  const { painted } = makeCanvas(size, size);
  const rng = mulberry32(seed >>> 0);
  const K = 6;
  const amp: number[] = [], phase: number[] = [], freq: number[] = [];
  for (let k = 0; k < K; k++) {
    amp.push(0.4 + rng() * 0.8);
    phase.push(rng() * Math.PI * 2);
    freq.push(3 + Math.floor(rng() * 10));
  }
  const cx = size / 2, cy = size / 2, R = size / 2;
  const d = painted.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx, dy = y - cy;
      const r = Math.hypot(dx, dy) / R;
      let a = 0;
      if (r < 1) {
        const ang = Math.atan2(dy, dx);
        let s = 0;
        for (let k = 0; k < K; k++) s += amp[k]! * Math.sin(freq[k]! * ang + phase[k]!);
        const lobes = 0.5 + 0.5 * Math.tanh(s * 0.6);            // 0..1 streamer gate
        const core = Math.exp(-r * 3.4);                         // tight bright inner glow
        const tail = Math.exp(-r * 1.15) * (0.30 + 0.70 * lobes); // ray-modulated halo
        // The exponential tail is still ~0.1–0.35 at the texture boundary; clipping
        // it there left a hard-edged disk rim. Window the whole field smoothly to
        // zero across the outer half so the halo dissolves into space instead.
        const t = clamp01((r - 0.5) / 0.5);
        const edge = 1 - t * t * (3 - 2 * t);                    // smoothstep, inverted (1→0)
        a = clamp01((core * 0.85 + tail) * edge);
      }
      const i = (y * size + x) * 4;
      d.data[i] = 255; d.data[i + 1] = 255; d.data[i + 2] = 255;
      d.data[i + 3] = (a * 255) | 0;
    }
  }
  return toTexture(painted, maxAniso, true);
}

/** Soft radial glow texture for the Sun's corona sprite. */
export function makeGlowTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,244,214,0.9)");
  g.addColorStop(0.25, "rgba(255,228,160,0.55)");
  g.addColorStop(0.55, "rgba(255,200,110,0.22)");
  g.addColorStop(1, "rgba(255,180,90,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
