/**
 * Shared render-space primitives for the overlay views (trajectories, planned
 * routes, force vectors). Three.js lives here, never in `src/core`.
 *
 * Two recurring needs across the overlays:
 *   - polylines whose vertices are ABSOLUTE world metres that must pass through
 *     the floating origin (a transfer arc spans Earth's frame and the Sun's, so
 *     we cannot use the single-`.position` focus-relative trick the body/ship
 *     orbit loops rely on — each vertex is transformed individually);
 *   - arrows that stay a roughly constant fraction of the screen at any zoom.
 *
 * All helpers reuse caller-owned buffers/temps so the per-frame update loops do
 * not allocate. A small theme-aware palette keeps thin lines/arrows legible on
 * both the dark and the light background.
 */

import * as THREE from "three";
import { type Vec3 } from "@lightlag/engine/math/vec3";
import { metersToUnits, SCENE_SCALE } from "./scale.ts";
import { type SceneManager, type Theme } from "./SceneManager.ts";

/** A growable-capacity line whose drawn vertex count varies per frame. */
export class RenderPolyline {
  readonly object: THREE.Line;
  readonly positions: Float32Array;
  /** Per-vertex RGB buffer (only when `vertexColors` was requested). */
  readonly colors: Float32Array | null;
  private geo: THREE.BufferGeometry;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute | null;

  constructor(opts: {
    capacity: number; // max vertices
    color: number;
    opacity?: number;
    loop?: boolean;
    vertexColors?: boolean;
  }) {
    this.positions = new Float32Array(opts.capacity * 3);
    this.geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.geo.setAttribute("position", this.posAttr);

    const matOpts: THREE.LineBasicMaterialParameters = {
      transparent: true,
      opacity: opts.opacity ?? 0.8,
    };
    if (opts.vertexColors) {
      this.colors = new Float32Array(opts.capacity * 3);
      this.colAttr = new THREE.BufferAttribute(this.colors, 3);
      this.geo.setAttribute("color", this.colAttr);
      matOpts.vertexColors = true;
      // White base so the final colour IS the per-vertex colour (three multiplies).
      matOpts.color = 0xffffff;
    } else {
      this.colors = null;
      this.colAttr = null;
      matOpts.color = opts.color;
    }

    const mat = new THREE.LineBasicMaterial(matOpts);
    this.object = opts.loop ? new THREE.LineLoop(this.geo, mat) : new THREE.Line(this.geo, mat);
    this.object.frustumCulled = false; // the line can be large/offscreen-centred
    this.geo.setDrawRange(0, 0);
  }

  setCount(n: number): void {
    this.geo.setDrawRange(0, Math.max(0, n));
  }
  markPositionsDirty(): void {
    this.posAttr.needsUpdate = true;
  }
  markColorsDirty(): void {
    if (this.colAttr) this.colAttr.needsUpdate = true;
  }
  setColor(hex: number): void {
    (this.object.material as THREE.LineBasicMaterial).color.setHex(hex);
  }
  setOpacity(o: number): void {
    (this.object.material as THREE.LineBasicMaterial).opacity = o;
  }
  setVisible(on: boolean): void {
    this.object.visible = on;
  }
  dispose(): void {
    this.geo.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}

/**
 * Fill a polyline's position buffer from absolute WORLD points, transforming
 * each through the floating origin (f64 subtract, then /SCENE_SCALE). Returns the
 * number of vertices written and marks the draw range + buffer dirty.
 */
export function fillPolylineWorld(
  pl: RenderPolyline,
  pts: readonly Vec3[],
  sm: SceneManager,
  tmp: THREE.Vector3 = _fillTmp,
): number {
  const cap = pl.positions.length / 3;
  const n = Math.min(pts.length, cap);
  const arr = pl.positions;
  for (let k = 0; k < n; k++) {
    sm.toRender(pts[k]!, tmp);
    arr[k * 3] = tmp.x;
    arr[k * 3 + 1] = tmp.y;
    arr[k * 3 + 2] = tmp.z;
  }
  pl.setCount(n);
  pl.markPositionsDirty();
  return n;
}
const _fillTmp = new THREE.Vector3();

/**
 * Fill from points LOCAL to a single parent body: the parent's current world
 * position becomes the line's `.position` (via the floating origin) and the
 * vertices are the parent-relative offsets / SCENE_SCALE. This is the existing
 * orbit-loop idiom — use it for a path about one primary (a parking ellipse, a
 * heliocentric/approach arc) so the curve stays anchored at "now" and does not
 * smear as the primary drifts. Returns the vertex count.
 */
export function fillPolylineLocal(
  pl: RenderPolyline,
  pts: readonly Vec3[],
  parentWorld: Vec3,
  sm: SceneManager,
): number {
  sm.toRender(parentWorld, pl.object.position);
  const cap = pl.positions.length / 3;
  const n = Math.min(pts.length, cap);
  const arr = pl.positions;
  for (let k = 0; k < n; k++) {
    arr[k * 3] = pts[k]!.x / SCENE_SCALE;
    arr[k * 3 + 1] = pts[k]!.y / SCENE_SCALE;
    arr[k * 3 + 2] = pts[k]!.z / SCENE_SCALE;
  }
  pl.setCount(n);
  pl.markPositionsDirty();
  return n;
}

/** A reusable arrow (shaft + head) in render space, wrapping THREE.ArrowHelper. */
export class RenderArrow {
  readonly object: THREE.ArrowHelper;

  constructor(scene: THREE.Scene, color: number) {
    this.object = new THREE.ArrowHelper(_up, _zero, 1, color);
    this.object.visible = false;
    (this.object.line as THREE.Object3D).frustumCulled = false;
    (this.object.cone as THREE.Object3D).frustumCulled = false;
    scene.add(this.object);
  }

  /** Place at `at`, pointing along the UNIT vector `dir`, of length `lenUnits`. */
  set(at: THREE.Vector3, dir: THREE.Vector3, lenUnits: number, hex: number): void {
    if (lenUnits <= 0 || dir.lengthSq() === 0 || !isFinite(lenUnits)) {
      this.object.visible = false;
      return;
    }
    this.object.position.copy(at);
    this.object.setDirection(dir); // dir MUST be unit (ArrowHelper assumes it)
    this.object.setLength(lenUnits, lenUnits * 0.22, lenUnits * 0.12);
    this.object.setColor(hex);
    this.object.visible = true;
  }

  setOpacity(o: number): void {
    const lm = (this.object.line as THREE.Line).material as THREE.Material;
    const cm = (this.object.cone as THREE.Mesh).material as THREE.Material;
    lm.transparent = true;
    lm.opacity = o;
    cm.transparent = true;
    cm.opacity = o;
  }
  setVisible(on: boolean): void {
    this.object.visible = on;
  }
  dispose(): void {
    if (this.object.parent) this.object.parent.remove(this.object);
    this.object.dispose();
  }
}
const _up = new THREE.Vector3(0, 1, 0);
const _zero = new THREE.Vector3(0, 0, 0);

/**
 * A length in render units that is a fixed fraction of the camera's distance to
 * its focus — so an arrow/marker keeps a near-constant on-screen size at any
 * zoom. `cameraDistanceMeters()` undoes the scene scale, `metersToUnits` reapplies
 * it, leaving the camera→focus distance in render units times `frac`.
 */
export function screenLengthUnits(sm: SceneManager, frac = 0.12): number {
  return metersToUnits(sm.cameraDistanceMeters()) * frac;
}

// ── Theme-aware overlay palette ──────────────────────────────────────────────
export interface OverlayPalette {
  route: number; // committed planned-route lines
  preview: number; // transfer-planner ghost route
  gravity: number; // dominant gravity arrow
  momentum: number; // velocity / inertia arrow
  faintOpacity: number; // secondary (Sun) gravity arrow opacity
  tailFloor: number; // comet-tail brightness floor (0..1) at the far end
  redshift: number; // Doppler tint endpoint, receding (z > 0)
  blueshift: number; // Doppler tint endpoint, approaching (z < 0)
}
// Saturated enough to read on dark #05070d.
const DARK: OverlayPalette = {
  route: 0x9a7cff,
  preview: 0xbfefff,
  gravity: 0xff5d8f,
  momentum: 0x7cffb2,
  faintOpacity: 0.4,
  tailFloor: 0.12,
  redshift: 0xff4d4d,
  blueshift: 0x4d9bff,
};
// Darker hues + a higher tail floor so thin lines survive the light #dfe6ef bg.
const LIGHT: OverlayPalette = {
  route: 0x6a3cff,
  preview: 0x0a7bb0,
  gravity: 0xd81b60,
  momentum: 0x0f8a4d,
  faintOpacity: 0.55,
  tailFloor: 0.34,
  redshift: 0xd02020,
  blueshift: 0x1668d0,
};
export function overlayPalette(theme: Theme): OverlayPalette {
  return theme === "light" ? LIGHT : DARK;
}

// ── Relativistic Doppler tint ────────────────────────────────────────────────
// Map a redshift z (signed: z>0 receding ⇒ red, z<0 approaching ⇒ blue) onto a
// tint of a base marker colour. Log-compressed so planetary orbital Doppler
// (z ~ 1e-6) is invisible and a β≈0.95 torchship (z ≈ 5.25) reads fully. Pure
// and allocation-free given caller-owned scratch Colors.
const Z_MAX = 5; // z at which the tint saturates (β ≈ 0.95)
const Z_MIN = 1e-3; // below this the base colour is returned unchanged (dead-zone)
const LOG_DEN = Math.log10(1 + Z_MAX);

export function dopplerTint(
  baseHex: number,
  z: number,
  pal: OverlayPalette,
  scratch?: THREE.Color,
  endpointScratch?: THREE.Color,
): number {
  if (!Number.isFinite(z) || Math.abs(z) < Z_MIN) return baseHex;
  const mag = Math.min(Math.log10(1 + Math.abs(z)) / LOG_DEN, 1); // 0..1 strength
  const base = (scratch ?? new THREE.Color()).setHex(baseHex);
  const endpoint = (endpointScratch ?? new THREE.Color()).setHex(z > 0 ? pal.redshift : pal.blueshift);
  base.lerp(endpoint, mag); // hue slide toward red/blue, brightness preserved
  return base.getHex();
}
