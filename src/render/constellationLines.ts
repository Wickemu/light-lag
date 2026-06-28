/**
 * Constellation stick-figures, drawn as a faint overlay on the unzoomable sky.
 *
 * The figures are a purely DIRECTIONAL sky phenomenon: each segment connects two
 * sky directions (precomputed in constellationLines.generated.ts), drawn at a fixed
 * radius and re-anchored to the camera every frame — so they sit registered with
 * the stars and never parallax. The whole set is one THREE.LineSegments (a single
 * draw call). Shared by the in-system sky and the interstellar map (each at its own
 * shell radius); gated by the "constellations" visibility layer (default off).
 */

import * as THREE from "three";
import { CONSTELLATION_LINES } from "../core/constellationLines.generated.ts";
import { type SceneManager } from "./SceneManager.ts";

// Faint sky lines; the light theme needs more contrast on its pale background.
const THEME = {
  dark: { color: 0x4a5a82, opacity: 0.3 },
  light: { color: 0x39507a, opacity: 0.42 },
};

export class ConstellationLines {
  private group = new THREE.Group();
  private mat: THREE.LineBasicMaterial;
  private lastTheme: string | null = null;

  constructor(private sm: SceneManager, radius: number) {
    this.group.frustumCulled = false;
    this.sm.scene.add(this.group);

    let segCount = 0;
    for (const fig of CONSTELLATION_LINES)
      for (const poly of fig.polylines) segCount += poly.length / 3 - 1;

    const arr = new Float32Array(segCount * 6);
    let o = 0;
    for (const fig of CONSTELLATION_LINES) {
      for (const poly of fig.polylines) {
        const n = poly.length / 3;
        for (let i = 0; i < n - 1; i++) {
          const a = i * 3, b = (i + 1) * 3;
          arr[o++] = poly[a]! * radius; arr[o++] = poly[a + 1]! * radius; arr[o++] = poly[a + 2]! * radius;
          arr[o++] = poly[b]! * radius; arr[o++] = poly[b + 1]! * radius; arr[o++] = poly[b + 2]! * radius;
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    this.mat = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false, depthTest: true });
    const seg = new THREE.LineSegments(geo, this.mat);
    seg.frustumCulled = false;
    this.group.add(seg);
  }

  /** Anchor to the camera (so the figures never parallax) and refresh the theme tint. */
  update(on: boolean): void {
    this.group.visible = on;
    if (!on) return;
    this.group.position.copy(this.sm.camera.position);
    const theme = this.sm.theme;
    if (theme !== this.lastTheme) {
      this.lastTheme = theme;
      const t = theme === "light" ? THEME.light : THEME.dark;
      this.mat.color.setHex(t.color);
      this.mat.opacity = t.opacity;
    }
  }
}
