/**
 * The scene-space accent colour — the one cross-cutting accent the 3D overlays
 * paint with (a ship's coasting marker, its forecast comet-tail, an outbound
 * command packet). It mirrors the HUD's `--accent` so a colour-theme switch
 * reads as one coherent change across the canvas and the chrome, but it carries
 * its own *brighter* hex per palette: these lines sit additively over deep space
 * and want a more luminous variant than the flatter HUD swatch.
 *
 * Kept as a tiny shared singleton (not threaded through SceneManager) because the
 * views that read it run every frame — `shipViews`/`trajectoryViews` pick up a
 * new accent on the very next frame, so a palette switch retints instantly with
 * no wiring. `commsViews` reads it when a packet spawns, so it propagates as the
 * short-lived packets cycle. The default matches the legacy cyan, so nothing
 * changes until a palette is actually chosen.
 */

import * as THREE from "three";

const DEFAULT_SCENE_ACCENT = 0x6fe0ff;

const _color = new THREE.Color(DEFAULT_SCENE_ACCENT);
let _hex = DEFAULT_SCENE_ACCENT;

/** Set the scene accent (a 0xRRGGBB hex). Called by the theme picker / bootstrap. */
export function setSceneAccent(hex: number): void {
  _hex = hex;
  _color.setHex(hex);
}

/** The shared accent Color instance — read-only; never mutate it directly. Used
 *  by per-vertex tail colouring so a live palette switch retints next frame. */
export function accentColor(): THREE.Color {
  return _color;
}

/** The scene accent as a hex number — for `material.color.setHex(accentHex())`. */
export function accentHex(): number {
  return _hex;
}
