/**
 * The nearby stars as a backdrop shell.
 *
 * Real interstellar distances (4–12 ly ≈ 1e17 m) are ~1e8 render units — far
 * outside the solar-system frustum. So the stars are drawn at a COMPRESSED radius
 * just beyond Neptune, in their TRUE direction from the Sun: a directionally
 * honest sky you can fly toward, not a to-scale void. The compression is a
 * documented rendering choice (the physics/estimates in the engine are exact); a
 * to-scale interstellar camera mode is a future refinement.
 */

import * as THREE from "three";
import { STARS, type StarDef } from "../core/stars.ts";
import { length } from "../core/math/vec3.ts";
import { type SceneManager } from "./SceneManager.ts";

/** Render-unit radius of a star's shell position from the Sun. Neptune sits at
 *  ~4488 units; the nearest stars start just beyond and spread by distance. */
const SHELL_BASE = 5200;
const SHELL_PER_LY = 320;
export function starShellRadius(distanceLy: number): number {
  return SHELL_BASE + distanceLy * SHELL_PER_LY;
}

/** Unit direction (Sun→star) in the shared ecliptic-J2000 frame. */
export function starDirection(star: StarDef): { x: number; y: number; z: number } {
  const r = length(star.pos);
  return { x: star.pos.x / r, y: star.pos.y / r, z: star.pos.z / r };
}

function makeStarTexture(): THREE.Texture {
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

/** Rough display colour from spectral class (OBAFGKM → blue…red). */
function spectralColor(sp: string): number {
  const c = sp.charAt(0).toUpperCase();
  switch (c) {
    case "O": case "B": return 0xaecbff;
    case "A": return 0xdce6ff;
    case "F": return 0xfff4e8;
    case "G": return 0xfff2c2;
    case "K": return 0xffd6a0;
    case "M": return 0xff9d6e;
    case "D": return 0xeaf2ff; // white dwarf
    default: return 0xdfe6ff; // brown dwarf / unknown
  }
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
  private enabled = true;

  constructor(private sm: SceneManager, uiRoot: HTMLElement) {
    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "star-label-layer";
    uiRoot.appendChild(this.labelLayer);
    for (const s of STARS) this.build(s);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  private build(def: StarDef): void {
    const mat = new THREE.SpriteMaterial({
      map: this.tex, color: spectralColor(def.spectralType),
      sizeAttenuation: false, depthWrite: false, transparent: true,
    });
    const marker = new THREE.Sprite(mat);
    // Brighter/bigger for luminous primaries; components share a position.
    marker.scale.setScalar(def.parentId ? 0.012 : 0.02);
    marker.frustumCulled = false;
    this.sm.scene.add(marker);

    const label = document.createElement("div");
    label.className = "star-label";
    label.textContent = def.name;
    this.labelLayer.appendChild(label);

    this.visuals.push({ def, marker, label });
  }

  /** Position the shell each frame. Stars are fixed in direction from the Sun, so
   *  anchor to the Sun's render position and add the compressed offset. */
  update(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const sun = new THREE.Vector3();
    this.sm.toRender({ x: 0, y: 0, z: 0 }, sun); // Sun is the root origin

    for (const vis of this.visuals) {
      if (!this.enabled) {
        vis.marker.visible = false;
        vis.label.style.display = "none";
        continue;
      }
      vis.marker.visible = true;
      const dir = starDirection(vis.def);
      const r = starShellRadius(vis.def.distanceLy);
      vis.marker.position.set(sun.x + dir.x * r, sun.y + dir.y * r, sun.z + dir.z * r);

      const ndc = vis.marker.position.clone().project(this.sm.camera);
      const visible = ndc.z < 1 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
      if (visible) {
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
