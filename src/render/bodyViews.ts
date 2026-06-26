/**
 * Visual representation of the natural bodies: a glowing marker that stays
 * visible at any zoom, a to-scale sphere that resolves as you close in, and an
 * orbit path. Everything is positioned each frame from the analytic ephemeris
 * through the floating origin, so the whole orrery stays numerically clean.
 */

import * as THREE from "three";
import { BODIES, BODY_BY_ID, type BodyDef, type BodyKind } from "../core/constants.ts";
import { bodyState, bodyElements } from "../core/ephemeris.ts";
import { orbitPath } from "../core/math/kepler.ts";
import { metersToUnits, SCENE_SCALE } from "./scale.ts";
import { type SceneManager } from "./SceneManager.ts";

const ORBIT_SEGMENTS = 256;

/** Constant screen-size for the always-visible body marker, by class. Explicit
 *  per-kind so a newly added BodyKind can't silently inherit a wrong size. */
const MARKER_SCALE: Record<BodyKind, number> = {
  star: 0.05,
  planet: 0.022,
  dwarf: 0.016,
  asteroid: 0.012,
  moon: 0.013,
  comet: 0.011,
};

function makeDotTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.95)");
  g.addColorStop(0.7, "rgba(255,255,255,0.25)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** How much larger/brighter a body's marker gets while it is the focus. */
const FOCUS_MARKER_GAIN = 1.6;

interface BodyVisual {
  def: BodyDef;
  marker: THREE.Sprite;
  sphere: THREE.Mesh;
  orbit?: THREE.LineLoop;
  orbitArray?: Float32Array;
  // Precomputed marker colours (avoid per-frame allocation in update()).
  baseColor: THREE.Color;
  focusColor: THREE.Color;
}

export class BodyViews {
  private dot = makeDotTexture();
  readonly visuals: BodyVisual[] = [];

  constructor(private sm: SceneManager) {
    for (const def of BODIES) this.build(def);
  }

  private build(def: BodyDef): void {
    const color = new THREE.Color(def.color);

    // Always-visible marker (constant screen size).
    const markerMat = new THREE.SpriteMaterial({
      map: this.dot,
      color,
      sizeAttenuation: false,
      depthWrite: false,
      transparent: true,
    });
    const marker = new THREE.Sprite(markerMat);
    marker.scale.setScalar(MARKER_SCALE[def.kind]);
    this.sm.scene.add(marker);

    // To-scale sphere (tiny at system zoom, resolves up close).
    const radius = metersToUnits(def.radius);
    const sphereGeo = new THREE.SphereGeometry(radius, 32, 24);
    const sphereMat =
      def.kind === "star"
        ? new THREE.MeshBasicMaterial({ color })
        : new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0.0 });
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    this.sm.scene.add(sphere);

    const baseColor = color.clone();
    const focusColor = color.clone().lerp(new THREE.Color(0xffffff), 0.5);
    const visual: BodyVisual = { def, marker, sphere, baseColor, focusColor };

    // Orbit path (non-root bodies).
    if (def.parent) {
      const arr = new Float32Array((ORBIT_SEGMENTS + 1) * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      const mat = new THREE.LineBasicMaterial({
        color: color.clone().multiplyScalar(0.6),
        transparent: true,
        opacity: 0.5,
      });
      const orbit = new THREE.LineLoop(geo, mat);
      orbit.frustumCulled = false;
      this.sm.scene.add(orbit);
      visual.orbit = orbit;
      visual.orbitArray = arr;
    }

    this.visuals.push(visual);
  }

  /** Reposition everything for sim time t. Origin must already be updated. */
  update(t: number): void {
    const tmp = new THREE.Vector3();
    for (const vis of this.visuals) {
      const { def } = vis;
      const state = bodyState(def, t);
      this.sm.toRender(state.r, tmp);
      vis.marker.position.copy(tmp);
      vis.sphere.position.copy(tmp);

      // Emphasise the focused body: a larger, brighter marker draws the eye.
      const focused = def.id === this.sm.focusId;
      vis.marker.scale.setScalar(MARKER_SCALE[def.kind] * (focused ? FOCUS_MARKER_GAIN : 1));
      (vis.marker.material as THREE.SpriteMaterial).color.copy(focused ? vis.focusColor : vis.baseColor);

      if (vis.orbit && vis.orbitArray && def.parent) {
        // Orbit path lives relative to the parent: position the loop at the
        // parent's render location and fill local vertices with the ellipse.
        const parent = BODY_BY_ID.get(def.parent)!;
        const parentState = bodyState(parent, t);
        this.sm.toRender(parentState.r, vis.orbit.position);

        const el = bodyElements(def, t);
        if (el) {
          const pts = orbitPath(el, ORBIT_SEGMENTS);
          const arr = vis.orbitArray;
          for (let k = 0; k < pts.length; k++) {
            arr[k * 3] = pts[k]!.x / SCENE_SCALE;
            arr[k * 3 + 1] = pts[k]!.y / SCENE_SCALE;
            arr[k * 3 + 2] = pts[k]!.z / SCENE_SCALE;
          }
          const attr = vis.orbit.geometry.getAttribute("position") as THREE.BufferAttribute;
          attr.needsUpdate = true;
        }
      }
    }
  }

  /** Screen-space anchors for HTML labels: NDC-projected positions per body. */
  labelAnchors(): { id: string; name: string; ndc: THREE.Vector3 }[] {
    const out: { id: string; name: string; ndc: THREE.Vector3 }[] = [];
    for (const vis of this.visuals) {
      const ndc = vis.marker.position.clone().project(this.sm.camera);
      out.push({ id: vis.def.id, name: vis.def.name, ndc });
    }
    return out;
  }
}
