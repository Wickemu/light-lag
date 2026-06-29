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


// ── Public shape ─────────────────────────────────────────────────────────────

export interface BodyTextureSet {
  surface: THREE.Texture;
  bump?: THREE.Texture;
  bumpScale: number;
  roughness: number;
  metalness: number;
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

/** The Sun: convective granulation + bright limb-darkened poles, all emissive
 *  (the material is unlit), so it reads as a light source, not a lit ball. */
function paintStar(def: BodyDef, w: number, h: number, fbm: ReturnType<typeof makeFbm>, maxAniso: number): THREE.Texture {
  const { painted } = makeCanvas(w, h);
  const base = hexToRgb(def.color);
  const hot = shade(def.color, 0.22, -0.1); // brighter granule centres
  const cool = shade(def.color, -0.12, 0.05); // intergranular lanes
  const tmp: RGB = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    const v = y / h;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      // Two scales: fine granules over a slow brightness mottle.
      const fine = fbm(u, v, 5, 24);
      const slow = fbm(u + 3.1, v + 1.7, 3, 6);
      const g = clamp01(fine * 0.7 + slow * 0.5);
      lerpRgb(cool, hot, g, tmp);
      // Pull the whole disc toward the base hue so it stays solar, not bleached.
      lerpRgb(base, tmp, 0.7, tmp);
      setPx(painted.data, (y * w + x) * 4, tmp[0], tmp[1], tmp[2]);
    }
  }
  return toTexture(painted, maxAniso, true);
}

/** Gas/ice giants: latitudinal bands warped by turbulence, plus a signature
 *  storm oval for Jupiter (Great Red Spot) and Neptune (Great Dark Spot). */
function paintGasGiant(def: BodyDef, w: number, h: number, fbm: ReturnType<typeof makeFbm>, maxAniso: number): { surface: THREE.Texture } {
  const { painted } = makeCanvas(w, h);

  // A small palette spun off the body colour: alternating light/dark zones.
  const zoneLight = shade(def.color, 0.10, -0.05);
  const zoneDark = shade(def.color, -0.12, 0.05);
  const beltAccent = shade(def.color, -0.04, 0.12, 0.01);

  // Band count rises with how striped the real planet reads.
  const bands = def.id === "jupiter" ? 18 : def.id === "saturn" ? 14 : 9;
  const warp = def.id === "uranus" ? 0.15 : 0.6; // Uranus is famously bland
  const tmp: RGB = [0, 0, 0];
  const tmp2: RGB = [0, 0, 0];

  for (let y = 0; y < h; y++) {
    const v = y / h;
    const lat = v * Math.PI; // 0..π pole to pole
    for (let x = 0; x < w; x++) {
      const u = x / w;
      // Domain-warp the band coordinate so zones wobble and curl like real flow.
      const turb = (fbm(u, v, 4, 8) - 0.5) * warp;
      const band = Math.sin((lat * bands) + turb * 6);
      const t = clamp01(band * 0.5 + 0.5);
      lerpRgb(zoneDark, zoneLight, t, tmp);
      // Thin accent belts at the zone boundaries.
      const edge = 1 - Math.min(1, Math.abs(band) * 3);
      lerpRgb(tmp, beltAccent, edge * 0.5, tmp);
      // Fine longitudinal streaks.
      const streak = (fbm(u * 1.0, v + 5.0, 3, 40) - 0.5) * 0.12;
      tmp2[0] = clamp01(tmp[0] + streak);
      tmp2[1] = clamp01(tmp[1] + streak);
      tmp2[2] = clamp01(tmp[2] + streak);
      setPx(painted.data, (y * w + x) * 4, tmp2[0], tmp2[1], tmp2[2]);
    }
  }

  // Stamp a storm oval (drawn in canvas space after the per-pixel pass).
  const ctx = painted.canvas.getContext("2d")!;
  ctx.putImageData(painted.data, 0, 0);
  const stamp = (cx: number, cy: number, rx: number, ry: number, color: string, alpha: number) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(cx, cy);
    ctx.scale(rx, ry);
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  };
  if (def.id === "jupiter") {
    stamp(w * 0.62, h * 0.62, w * 0.05, h * 0.035, "rgba(170,70,40,0.85)", 1);
    stamp(w * 0.62, h * 0.62, w * 0.035, h * 0.024, "rgba(120,45,30,0.6)", 1);
  } else if (def.id === "neptune") {
    // Great Dark Spot — southern hemisphere (canvas row > h/2), like the real one.
    stamp(w * 0.4, h * 0.6, w * 0.045, h * 0.03, "rgba(20,30,70,0.7)", 1);
  }

  const tex = new THREE.CanvasTexture(painted.canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = maxAniso;
  tex.needsUpdate = true;
  return { surface: tex };
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
  const sink = f.kind === "mare" || f.kind === "basin" || f.kind === "linea" || f.kind === "patera";
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

/** Sample the land-coverage field, wrapping in longitude and clamping in latitude. */
function sampleMask(mask: Float32Array, w: number, h: number, u: number, v: number): number {
  let xi = Math.floor((((u % 1) + 1) % 1) * w);
  if (xi >= w) xi = w - 1;
  let yi = Math.floor(clamp01(v) * h);
  if (yi >= h) yi = h - 1;
  return mask[yi * w + xi]!;
}

/** Earth: a recognisable blue marble — real coastlines (earthLand.ts) rasterised
 *  into a land/sea mask, oceans shaded by depth, land tinted by latitude biome and
 *  by real desert/forest/ice regions, and polar ice. Returns a bump map too (land
 *  stands proud of the sea). */
function paintEarth(w: number, h: number, fbm: ReturnType<typeof makeFbm>, maxAniso: number): { surface: THREE.Texture; bump: THREE.Texture } {
  const { painted } = makeCanvas(w, h);
  const { painted: bump } = makeCanvas(w, h);
  const land = buildLandMask(w, h);

  const ocean: RGB = hexToRgb(0x16335f);
  const oceanShallow: RGB = hexToRgb(0x2e6b8f);
  const desert: RGB = hexToRgb(0xbda478);
  const forest: RGB = hexToRgb(0x46663a);
  const tundra: RGB = hexToRgb(0x83836f);
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
      if (cov < 0.5) {
        // Sea — shallow where the coverage rises toward the waterline.
        const shallow = clamp01(cov * 2);
        lerpRgb(ocean, oceanShallow, shallow * shallow, tmp);
        setPx(painted.data, i, tmp[0], tmp[1], tmp[2]);
        setPx(bump.data, i, 0.35, 0.35, 0.35);
      } else {
        // Land — biome by latitude, with a little noise breakup.
        const warm = clamp01(1 - lat * 1.3);
        lerpRgb(tundra, forest, warm, tmp);
        lerpRgb(tmp, desert, clamp01((warm - 0.5) * 1.6), tmp);
        const rough = fbm(u + 9.0, v + 2.0, 4, 24);
        const k = 0.8 + rough * 0.22; // ≤ ~1.0, avoids clipping
        tmp[0] = clamp01(tmp[0] * k);
        tmp[1] = clamp01(tmp[1] * k);
        tmp[2] = clamp01(tmp[2] * k);
        setPx(painted.data, i, tmp[0], tmp[1], tmp[2]);
        const relief = fbm(u + 9.0, v + 2.0, 5, 18);
        const b = clamp01(0.5 + relief * 0.4);
        setPx(bump.data, i, b, b, b);
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
      }
    }
  }

  // Real large-scale regions (deserts/forests/ice sheets/ranges) over the land.
  const features = BODY_FEATURES.earth;
  if (features?.length) {
    painted.canvas.getContext("2d")!.putImageData(painted.data, 0, 0);
    bump.canvas.getContext("2d")!.putImageData(bump.data, 0, 0);
    paintFeatures(painted, bump, w, h, features, hexToRgb(0x5b6b48));
    return {
      surface: toTexture(painted, maxAniso, true, true),
      bump: toTexture(bump, maxAniso, false, true),
    };
  }
  return {
    surface: toTexture(painted, maxAniso, true),
    bump: toTexture(bump, maxAniso, false),
  };
}

/** Rocky / icy / small bodies: a noisy regolith tinted by the body colour, with
 *  optional impact craters and a matching bump map. Mars gets albedo maria and
 *  polar caps layered on top of the same base. */
function paintRocky(def: BodyDef, w: number, h: number, rng: () => number, fbm: ReturnType<typeof makeFbm>, maxAniso: number): { surface: THREE.Texture; bump?: THREE.Texture } {
  const { painted } = makeCanvas(w, h);
  // Tiny bodies (asteroids/comets) never fill enough screen for a bump map's
  // relief to read — skip it to save a canvas and a GPU texture.
  const wantsBump = def.kind !== "asteroid" && def.kind !== "comet";
  const bump: Painted | null = wantsBump ? makeCanvas(w, h).painted : null;

  const base = hexToRgb(def.color);
  const light = shade(def.color, 0.10);
  const dark = shade(def.color, -0.14);
  const tmp: RGB = [0, 0, 0];

  const isMars = def.id === "mars";
  const mare = isMars ? hexToRgb(0x7a2f1a) : dark;

  for (let y = 0; y < h; y++) {
    const v = y / h;
    const lat = Math.abs(v - 0.5) * 2;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const n = fbm(u, v, 5, isMars ? 6 : 8);
      lerpRgb(dark, light, n, tmp);
      lerpRgb(base, tmp, 0.6, tmp);
      if (isMars) {
        // Dark basaltic regions where a second low-frequency field is low.
        const region = fbm(u + 4.0, v + 4.0, 3, 4);
        lerpRgb(tmp, mare, clamp01((0.45 - region) * 1.8), tmp);
      }
      const i = (y * w + x) * 4;
      // Mars polar caps.
      if (isMars && lat > 0.86) {
        const t = clamp01((lat - 0.86) / 0.14);
        lerpRgb(tmp, hexToRgb(0xeef2f5), t, tmp);
      }
      setPx(painted.data, i, tmp[0], tmp[1], tmp[2]);
      if (bump) {
        const b = clamp01(0.5 + (n - 0.5) * 0.9);
        setPx(bump.data, i, b, b, b);
      }
    }
  }

  // Impact craters: airless bodies are heavily cratered; bodies with thick air
  // (Venus, Titan) are not — but those are hidden by their cloud shell anyway.
  const craterDensity: Record<BodyKind, number> = {
    star: 0, planet: 18, dwarf: 40, moon: 55, asteroid: 70, comet: 30, satellite: 0,
  };
  let nCraters = craterDensity[def.kind];
  if (def.atmosphere) nCraters = Math.round(nCraters * 0.2);
  if (def.id === "earth") nCraters = 0;
  // Young, resurfaced worlds wear far fewer impact scars than their class default:
  // Io's volcanism and Europa's ice erase them almost entirely; Triton is young too.
  if (def.id === "io" || def.id === "europa") nCraters = Math.round(nCraters * 0.06);
  else if (def.id === "triton") nCraters = Math.round(nCraters * 0.3);
  paintCraters(painted, bump, w, h, nCraters, rng);

  // Real named features (maria, albedo regions, lineae, polar caps) stamped over
  // the cratered base — semi-transparent, so the relief still reads through them.
  const features = BODY_FEATURES[def.id];
  if (features?.length) paintFeatures(painted, bump, w, h, features, hexToRgb(def.color));
  if (def.id === "europa") paintEuropaWeb(painted, w, h, rng);

  // paintCraters / paintFeatures have drawn the final pixels directly onto the
  // canvases, so build the textures straight from them (no ImageData re-upload).
  return {
    surface: toTexture(painted, maxAniso, true, true),
    bump: bump ? toTexture(bump, maxAniso, false, true) : undefined,
  };
}

/** Stamp N craters into colour + (optional) bump: a darker floor, a bright raised
 *  rim. Draws directly onto the canvases and leaves the result there. */
function paintCraters(surf: Painted, bump: Painted | null, w: number, h: number, n: number, rng: () => number): void {
  const sctx = surf.canvas.getContext("2d")!;
  const bctx = bump ? bump.canvas.getContext("2d")! : null;
  sctx.putImageData(surf.data, 0, 0);
  if (bump && bctx) bctx.putImageData(bump.data, 0, 0);

  const floorStops = (g: CanvasGradient): CanvasGradient => {
    g.addColorStop(0, "rgba(0,0,0,0.28)");
    g.addColorStop(0.7, "rgba(0,0,0,0.12)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    return g;
  };
  const rimStops = (g: CanvasGradient): CanvasGradient => {
    g.addColorStop(0, "rgba(40,40,40,0.7)");
    g.addColorStop(0.78, "rgba(40,40,40,0.2)");
    g.addColorStop(0.92, "rgba(235,235,235,0.7)");
    g.addColorStop(1, "rgba(128,128,128,0)");
    return g;
  };
  const disc = (ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: CanvasGradient): void => {
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  };

  for (let k = 0; k < n; k++) {
    const cx = rng() * w;
    // Bias toward the equator a touch so poles aren't over-stippled at the pinch.
    const cy = (0.15 + rng() * 0.7) * h;
    const r = (0.01 + rng() * 0.04) * w;

    // Each gradient is positioned, so stamp at cx and (if it straddles the u=0
    // seam) at the wrapped copy too.
    const xs = (cx < r || cx > w - r) ? [cx, cx < r ? cx + w : cx - w] : [cx];
    for (const x of xs) {
      disc(sctx, x, cy, r, floorStops(sctx.createRadialGradient(x, cy, 0, x, cy, r)));
      if (bctx) disc(bctx, x, cy, r, rimStops(bctx.createRadialGradient(x, cy, 0, x, cy, r)));
    }
  }
}

/** Broken-cloud / haze shell texture (white, with alpha from fractal noise).
 *  Opaqueness is decided by the caller from real surface pressure. */
function paintClouds(def: BodyDef, fbm: ReturnType<typeof makeFbm>, maxAniso: number): THREE.Texture {
  const w = 512, h = 256;
  const { painted } = makeCanvas(w, h);
  // Venus/Titan are wrapped in an unbroken haze that hides the surface; Earth gets
  // broken clouds; Mars only wisps. For the full-cover bodies the alpha must stay
  // high everywhere (the squared broken-cloud mapping would leave gaps).
  const fullCover = def.id === "venus" || def.id === "titan";
  const coverage = 0.45; // fraction of the noise field that stays clear (broken case)
  for (let y = 0; y < h; y++) {
    const v = y / h;
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const c = fbm(u + 12.0, v + 7.0, 5, 6);
      // Full cover: a near-opaque blanket (0.82–1.0) with faint structure.
      // Broken: only the upper tail of the noise shows cloud, squared for crisp gaps.
      const broken = clamp01((c - coverage) / (1 - coverage));
      const alpha = fullCover ? 0.82 + 0.18 * c : broken * broken;
      const i = (y * w + x) * 4;
      // Near-white clouds (held just below 1 so the lit limb doesn't blow out);
      // the shell material tints them with each body's haze colour.
      setPx(painted.data, i, 0.94, 0.94, 0.94, (clamp01(alpha) * 255) | 0);
    }
  }
  return toTexture(painted, maxAniso, true);
}

/** Saturn-style ring texture: a 1-D radial profile of concentric bands with a
 *  Cassini-like gap, written into a wide strip the RingGeometry samples radially. */
function paintRing(fbm: ReturnType<typeof makeFbm>, maxAniso: number): THREE.Texture {
  const w = 1024, h = 8;
  const { painted } = makeCanvas(w, h);
  for (let x = 0; x < w; x++) {
    const r = x / w; // 0 inner → 1 outer
    // Banded density with a Cassini-like gap. With the chosen inner/outer radii
    // (1.24–2.27 R) the real Cassini Division falls at ~0.7 of the span.
    let dens = 0.45 + 0.4 * Math.sin(r * 60) * 0.5 + fbm(r, 0.5, 4, 24) * 0.5;
    dens = clamp01(dens);
    if (r > 0.68 && r < 0.74) dens *= 0.1; // Cassini-like division
    // Soft edges: both the inner and outer rims fade to fully transparent.
    if (r < 0.06) dens *= clamp01(r / 0.06);
    else if (r > 0.94) dens *= clamp01((1 - r) / 0.06);
    const shadeFactor = 0.78 + 0.22 * Math.sin(r * 140);
    const tone = clamp01(0.7 * shadeFactor);
    const a = (clamp01(dens) * 235) | 0;
    for (let y = 0; y < h; y++) {
      setPx(painted.data, (y * w + x) * 4, tone, tone * 0.92, tone * 0.72, a);
    }
  }
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
  let roughness = 0.92;
  const metalness = 0;

  const isGiant = def.kind === "planet" && !def.hasSurface; // gas giants have no surface
  if (def.kind === "star") {
    surface = paintStar(def, w, h, fbm, maxAniso);
    roughness = 1;
  } else if (isGiant) {
    surface = paintGasGiant(def, w, h, fbm, maxAniso).surface;
    roughness = 1; // fluid, no specular highlight
  } else if (def.id === "earth") {
    const e = paintEarth(w, h, fbm, maxAniso);
    surface = e.surface;
    bump = e.bump;
    roughness = 0.7;
  } else {
    const r = paintRocky(def, w, h, rng, fbm, maxAniso);
    surface = r.surface;
    bump = r.bump;
    // Icy bodies get a slight sheen; dusty rock stays matte.
    const icy = ["europa", "enceladus", "tethys", "dione", "rhea", "mimas", "charon", "triton", "eris", "haumea"].includes(def.id);
    roughness = icy ? 0.5 : 0.95;
  }

  const set: BodyTextureSet = {
    surface,
    bump,
    bumpScale: bump ? 0.015 : 0, // gas giants/star carry no bump map
    roughness,
    metalness,
    obliquityRad,
  };

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
    set.ring = { texture: paintRing(fbm, maxAniso), inner: 1.24, outer: 2.27 };
  }

  return set;
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
