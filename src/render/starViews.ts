/**
 * The nearby stars as a celestial-sphere backdrop (in-system view).
 *
 * Real interstellar distances (4–12 ly ≈ 1e17 m) are ~1e8 render units — far
 * outside the solar-system frustum. Rather than compress them onto a finite
 * shell just past Neptune (which made them look impossibly close and parallax
 * against the planets), the in-system view paints each star on an UNZOOMABLE
 * SKY: a fixed huge render distance from the CAMERA in its true Sun→star
 * direction. Anchoring to the camera (not the Sun) means you can never dolly
 * closer and the sky never parallaxes against the orrery — it reads as the
 * background it physically is. Depth-tested but not depth-writing, so the
 * planets (always nearer) occlude it. To actually travel between stars, switch
 * to the to-scale interstellar view (`InterstellarView`), where the same
 * systems sit at real relative distances and ships in transit move along them.
 */

import * as THREE from "three";
import { STARS, BACKDROP_STARS, type StarDef, starPosition } from "../core/stars.ts";
import { length } from "../core/math/vec3.ts";
import { type SceneManager } from "./SceneManager.ts";
import { type Visibility } from "./visibility.ts";
import { SkyBackdrop } from "./skyBackdrop.ts";
import { ConstellationLines } from "./constellationLines.ts";

/** Render-unit distance of the sky sprites from the camera. Far enough that the
 *  whole orrery (Neptune ≈ 4488 units, camera pull-out ≤ 5e6) always sits in
 *  front and occludes it, yet well inside the camera's far plane (1e9). At this
 *  distance float32 angular jitter is sub-pixel. */
export const SKY_RADIUS = 2e7;

/** Legacy compressed-shell radius from the Sun, retained for the interstellar
 *  in-transit streak in `shipViews` until that moves to the interstellar view.
 *  Neptune sits at ~4488 units; the nearest stars start just beyond. */
const SHELL_BASE = 5200;
const SHELL_PER_LY = 320;
export function starShellRadius(distanceLy: number): number {
  return SHELL_BASE + distanceLy * SHELL_PER_LY;
}

/** Unit direction (Sun→star) in the shared ecliptic-J2000 frame at time t (s since
 *  J2000); default J2000. Tracks the star's proper-motion drift. */
export function starDirection(star: StarDef, t = 0): { x: number; y: number; z: number } {
  const p = starPosition(star, t);
  const r = length(p);
  return { x: p.x / r, y: p.y / r, z: p.z / r };
}

export function makeStarTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.3, "rgba(255,255,255,0.85)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Effective temperature (K) from a spectral type string (e.g. "G2V", "M5.5Ve",
 * "A1V", "DA2"). Read the leading class letter and its numeric subclass and
 * interpolate within the class's main-sequence temperature range (subclass 0 =
 * the hot end, 9 = the cool end). White dwarfs (class D) encode temperature as
 * Teff ≈ 50400/n after the composition letters. A documented approximation —
 * luminosity class is ignored — but far closer to real stellar colour than a
 * seven-bucket switch.
 */
export function spectralTeff(sp: string): number {
  const s = sp.toUpperCase();
  // White dwarf: "D" + composition letters, then a temperature index n.
  if (s.startsWith("D")) {
    const m = s.match(/(\d+(?:\.\d+)?)/);
    const n = m ? parseFloat(m[1]!) : 5;
    return n > 0 ? Math.min(80000, Math.max(4000, 50400 / n)) : 10000;
  }
  // [hot end, cool end] in K for each main-sequence class.
  const RANGES: Record<string, [number, number]> = {
    O: [50000, 30000], B: [30000, 10000], A: [10000, 7500], F: [7500, 6000],
    G: [6000, 5200], K: [5200, 3700], M: [3700, 2400], L: [2400, 1300],
    T: [1300, 600], Y: [600, 400],
  };
  const cls = s.charAt(0);
  const range = RANGES[cls];
  if (!range) return 5800; // unknown → sun-like
  const sub = s.match(/^[A-Z]+(\d(?:\.\d)?)/);
  const f = sub ? Math.min(9, parseFloat(sub[1]!)) / 9 : 0.5;
  return range[0] + (range[1] - range[0]) * f;
}

/** Blackbody colour (linear-ish sRGB, 0..1) for a temperature in kelvin, via the
 *  widely used piecewise approximation. Hot stars read blue-white, the Sun warm
 *  white, cool dwarfs orange-red — the real colour of a thermal emitter. */
export function blackbodyRGB(kelvin: number): { r: number; g: number; b: number } {
  const t = Math.min(40000, Math.max(1000, kelvin)) / 100;
  const cl = (x: number): number => Math.min(255, Math.max(0, x)) / 255;
  let r: number, g: number, b: number;
  r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661
              : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  return { r: cl(r), g: cl(g), b: cl(b) };
}

/** Display colour (hex) from spectral type, via Teff → blackbody. Kept for the
 *  interstellar map; the in-system sky uses the float RGB directly for HDR. */
export function spectralColor(sp: string): number {
  const { r, g, b } = blackbodyRGB(spectralTeff(sp));
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

/** Apparent (bolometric) magnitude from luminosity (L☉) and distance (ly). The
 *  Sun's M_bol ≈ 4.74 sets the zero point; 1 pc = 3.2616 ly. Bolometric (not
 *  visual) — a documented approximation that slightly over-brightens the very
 *  red dwarfs, but gives correct relative ordering across the catalogue. */
export function apparentMagnitude(luminositySun: number, distanceLy: number): number {
  const dPc = Math.max(distanceLy, 1e-3) / 3.2616;
  const absMag = 4.74 - 2.5 * Math.log10(Math.max(luminositySun, 1e-9));
  return absMag + 5 * Math.log10(dPc) - 5;
}

/** A star's apparent magnitude for sizing: the real catalogued value when present
 *  (the bright backdrop stars carry it), else the derived bolometric estimate. */
export function starApparentMag(def: { appMag?: number; luminosity?: number; distanceLy: number }): number {
  return def.appMag ?? apparentMagnitude(def.luminosity ?? 1e-9, def.distanceLy);
}

/** Sprite scale + HDR colour gain from apparent magnitude — shared by the curated
 *  in-system stars and the promoted bright backdrop stars so they read as one sky.
 *  Brighter (more negative m) → bigger and pushed over 1.0 to bloom. */
export function starSpriteStyle(m: number): { scale: number; gain: number } {
  const M_BRIGHT = -2, M_FAINT = 8;
  const f = Math.min(1, Math.max(0, (M_FAINT - m) / (M_FAINT - M_BRIGHT)));
  const SMIN = 0.007, SMAX = 0.03;
  return { scale: SMIN + f * (SMAX - SMIN), gain: 0.6 + f * 1.7 };
}

interface StarVisual {
  def: StarDef;
  marker: THREE.Sprite;
  label: HTMLElement;
}

export class StarViews {
  private tex = makeStarTexture();
  private visuals: StarVisual[] = [];
  private labelLayer: HTMLElement;
  private backdrop: SkyBackdrop;
  private constellations: ConstellationLines;

  constructor(private sm: SceneManager, uiRoot: HTMLElement, private vis: Visibility) {
    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "star-label-layer";
    uiRoot.appendChild(this.labelLayer);
    for (const s of STARS) this.build(s);
    // The distant bright stars (Betelgeuse, Rigel, the constellation-filling stars)
    // sit on the same unzoomable sky shell as the curated nearby stars.
    this.backdrop = new SkyBackdrop(this.sm, uiRoot, BACKDROP_STARS, SKY_RADIUS, "star-label backdrop");
    this.constellations = new ConstellationLines(this.sm, SKY_RADIUS);
  }

  private build(def: StarDef): void {
    // Size and brightness from the star's real apparent magnitude: brighter
    // (more negative m) → a bigger, hotter sprite. Magnitude is already a log of
    // flux, so we map it linearly between a bright and a faint reference and floor
    // it so even the faint red/brown dwarfs stay visible as navigation targets.
    const { scale: baseScale, gain } = starSpriteStyle(starApparentMag(def));
    const scale = baseScale * (def.parentId ? 0.82 : 1);
    // HDR colour: the blackbody tint lifted by an intensity that rises with
    // brightness, so the luminous primaries (Sirius, α Cen) push over 1.0 and
    // bloom while the dwarfs stay dim.
    const c = blackbodyRGB(spectralTeff(def.spectralType));
    const mat = new THREE.SpriteMaterial({
      map: this.tex,
      color: new THREE.Color().setRGB(c.r * gain, c.g * gain, c.b * gain),
      sizeAttenuation: false, depthWrite: false, transparent: true,
      blending: THREE.AdditiveBlending,
    });
    const marker = new THREE.Sprite(mat);
    marker.scale.setScalar(scale);
    marker.frustumCulled = false;
    this.sm.scene.add(marker);

    const label = document.createElement("div");
    label.className = "star-label";
    label.textContent = def.name;
    this.labelLayer.appendChild(label);

    this.visuals.push({ def, marker, label });
  }

  /** Park every sprite + label (called when the sky is hidden or the view mode
   *  isn't the in-system orrery). */
  private hideAll(): void {
    for (const vis of this.visuals) {
      vis.marker.visible = false;
      vis.label.style.display = "none";
    }
  }

  /** Position the sky each frame. Stars are fixed in direction from the Sun, so
   *  anchor each sprite to the CAMERA and push it out along that direction by a
   *  fixed huge radius — an unzoomable celestial sphere that never parallaxes
   *  against the planets. */
  update(t = 0): void {
    // The interstellar view owns the stars at that scale; the in-system sky is
    // only for the orrery mode.
    const isSystem = this.sm.viewMode === "system";
    // Constellation figures have their own toggle, independent of the star layer.
    this.constellations.update(isSystem && this.vis.layer("constellations"));
    if (!isSystem || !this.vis.layer("stars")) {
      this.hideAll();
      this.backdrop.update(false, false);
      return;
    }

    const w = window.innerWidth;
    const h = window.innerHeight;
    const cam = this.sm.camera.position; // render space, relative to the focus
    const labelsOn = this.vis.layer("starLabels");
    this.backdrop.update(true, labelsOn);

    for (const vis of this.visuals) {
      vis.marker.visible = true;
      const dir = starDirection(vis.def, t);
      vis.marker.position.set(
        cam.x + dir.x * SKY_RADIUS,
        cam.y + dir.y * SKY_RADIUS,
        cam.z + dir.z * SKY_RADIUS,
      );

      // Components of a multiple system (parentId set) sit on top of their
      // primary on the sky, so their labels would just pile up — draw the
      // sprite but suppress the duplicate text.
      const ndc = vis.marker.position.clone().project(this.sm.camera);
      const onScreen = ndc.z < 1 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
      if (labelsOn && onScreen && !vis.def.parentId) {
        vis.label.style.display = "block";
        const x = (ndc.x * 0.5 + 0.5) * w;
        const y = (-ndc.y * 0.5 + 0.5) * h;
        vis.label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      } else {
        vis.label.style.display = "none";
      }
    }
  }
}
