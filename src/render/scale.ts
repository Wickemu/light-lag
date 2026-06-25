/**
 * The bridge between f64 SI metres (the sim) and float32 render units (WebGL).
 *
 * WebGL math is single-precision (~7 significant digits), but the Solar System
 * spans ~4.5e12 m to Neptune. Two things keep that from turning into jitter:
 *
 *   1. A scene scale: 1 render unit = SCENE_SCALE metres, so Neptune sits at a
 *      few thousand units, comfortably inside float32's exact-integer range.
 *   2. A floating origin: positions are expressed relative to a focus point and
 *      that subtraction is done in f64 BEFORE the result is handed to Three.js,
 *      so precision is highest exactly where the camera is looking.
 *
 * The renderer never sees a raw 1e12 number.
 */

import * as THREE from "three";
import { type Vec3 } from "../core/math/vec3.ts";

/** Metres per render unit. 1 unit = 1,000,000 km. At this scale 1 AU ≈ 149.6
 *  units and Neptune ≈ 4488 units — all well within float32's safe range. */
export const SCENE_SCALE = 1e9;

/** Convert an SI length (m) to render units. Use for radii, distances. */
export function metersToUnits(m: number): number {
  return m / SCENE_SCALE;
}

/**
 * Convert a world position (m, f64) to a render-space vector, relative to the
 * floating origin. The subtraction happens in f64 here; only the small result
 * crosses into float32.
 */
export function worldToRender(world: Vec3, origin: Vec3, out?: THREE.Vector3): THREE.Vector3 {
  const v = out ?? new THREE.Vector3();
  v.set(
    (world.x - origin.x) / SCENE_SCALE,
    (world.y - origin.y) / SCENE_SCALE,
    (world.z - origin.z) / SCENE_SCALE,
  );
  return v;
}
