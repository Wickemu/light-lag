/**
 * Visual representation of the natural bodies: a glowing marker that stays
 * visible at any zoom, a to-scale sphere that resolves as you close in, and an
 * orbit path. Everything is positioned each frame from the analytic ephemeris
 * through the floating origin, so the whole orrery stays numerically clean.
 *
 * Each sphere wears a procedural texture (see bodyTextures.ts) and lives inside
 * an oriented node: the node tilts the body's pole (ecliptic north, plus a
 * cosmetic obliquity for the few that read wrong flat) and the sphere spins
 * inside it at the body's REAL sidereal rate — so the texture is alive and a
 * retrograde world visibly turns the other way. Atmosphere shells and Saturn's
 * rings ride in the same node.
 */

import * as THREE from "three";
import { BODIES, BODY_BY_ID, type BodyDef, type BodyKind } from "../core/constants.ts";
import { bodyState, bodyElements } from "../core/ephemeris.ts";
import { orbitPath } from "../core/math/kepler.ts";
import { metersToUnits, SCENE_SCALE } from "./scale.ts";
import { type SceneManager } from "./SceneManager.ts";
import { type Visibility } from "./visibility.ts";
import { createBodyTextures, makeGlowTexture, type BodyTextureSet } from "./bodyTextures.ts";

// Sampled in eccentric anomaly and phased to the body (see kepler.orbitPath), so
// the loop already passes dead through the marker; the segment budget only sets
// how smooth the arc reads between vertices when zoomed in.
const ORBIT_SEGMENTS = 384;

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

/** Sphere tessellation by class: smoother silhouettes for the bodies you study
 *  up close, cheaper meshes for the swarm of tiny moons and rocks. */
const SPHERE_SEGMENTS: Record<BodyKind, [number, number]> = {
  star: [48, 32],
  planet: [48, 32],
  dwarf: [40, 28],
  moon: [32, 24],
  asteroid: [24, 18],
  comet: [24, 18],
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
  /** Oriented container at the body's position; holds sphere, clouds, ring. */
  node: THREE.Object3D;
  sphere: THREE.Mesh;
  clouds?: THREE.Mesh;
  /** Angular speed of the texture spin (rad/s of sim time); 0 if non-rotating. */
  spinRate: number;
  cloudSpinRate: number;
  orbit?: THREE.LineLoop;
  orbitArray?: Float32Array;
  // Precomputed marker colours (avoid per-frame allocation in update()).
  baseColor: THREE.Color;
  focusColor: THREE.Color;
}

export class BodyViews {
  private dot = makeDotTexture();
  private glow = makeGlowTexture();
  readonly visuals: BodyVisual[] = [];

  constructor(private sm: SceneManager, private vis: Visibility) {
    for (const def of BODIES) this.build(def);
  }

  private build(def: BodyDef): void {
    const color = new THREE.Color(def.color);
    const maxAniso = this.sm.renderer.capabilities.getMaxAnisotropy();
    const tex = createBodyTextures(def, maxAniso);

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

    // Oriented node: pole along ecliptic +Z, tilted by the body's obliquity.
    // The local +Y of a child becomes the spin axis (rotating +Y→+Z is +90° about X).
    const node = new THREE.Object3D();
    node.rotation.x = Math.PI / 2 + tex.obliquityRad;
    this.sm.scene.add(node);

    // To-scale sphere (tiny at system zoom, resolves up close).
    const radius = metersToUnits(def.radius);
    const [segW, segH] = SPHERE_SEGMENTS[def.kind];
    const sphereGeo = new THREE.SphereGeometry(radius, segW, segH);
    let sphereMat: THREE.Material;
    if (def.kind === "star") {
      sphereMat = new THREE.MeshBasicMaterial({ map: tex.surface });
    } else {
      const params: THREE.MeshStandardMaterialParameters = {
        map: tex.surface,
        roughness: tex.roughness,
        metalness: tex.metalness,
      };
      // Only attach a bump map where we painted one — passing undefined trips a
      // THREE.Material warning (gas giants and the like have no relief map).
      if (tex.bump) {
        params.bumpMap = tex.bump;
        params.bumpScale = tex.bumpScale;
      }
      sphereMat = new THREE.MeshStandardMaterial(params);
    }
    const sphere = new THREE.Mesh(sphereGeo, sphereMat);
    node.add(sphere);

    // Atmosphere / cloud shell (lit, semi-transparent, just above the surface).
    let clouds: THREE.Mesh | undefined;
    if (tex.clouds) {
      const cloudGeo = new THREE.SphereGeometry(radius * (tex.cloudScale ?? 1.02), segW, segH);
      const cloudMat = new THREE.MeshStandardMaterial({
        map: tex.clouds,
        color: new THREE.Color(tex.cloudColor ?? 0xffffff),
        transparent: true,
        opacity: tex.cloudOpacity ?? 0.6,
        depthWrite: false,
        roughness: 1,
        metalness: 0,
      });
      clouds = new THREE.Mesh(cloudGeo, cloudMat);
      node.add(clouds);
    }

    // Ring system (Saturn): a flat annulus in the equatorial plane.
    if (tex.ring) this.addRing(node, radius, tex);

    // The Sun is a light source, not a lit ball — give it a soft corona that
    // grows as you approach (sprite size-attenuates with distance).
    if (def.kind === "star") {
      const coronaMat = new THREE.SpriteMaterial({
        map: this.glow,
        color: 0xfff0cf,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const corona = new THREE.Sprite(coronaMat);
      corona.scale.setScalar(radius * 7);
      node.add(corona);
    }

    const baseColor = color.clone();
    const focusColor = color.clone().lerp(new THREE.Color(0xffffff), 0.5);
    const spinRate = def.rotationPeriod ? (2 * Math.PI) / def.rotationPeriod : 0;
    const visual: BodyVisual = {
      def, marker, node, sphere, clouds,
      spinRate,
      cloudSpinRate: spinRate * 0.92, // a touch of cloud drift relative to the surface
      baseColor, focusColor,
    };

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

  /** Build the ring annulus and remap its UVs so the radial texture strip runs
   *  inner→outer (RingGeometry's default UVs are a bounding-box square, not radial). */
  private addRing(node: THREE.Object3D, radius: number, tex: BodyTextureSet): void {
    const ring = tex.ring!;
    const inner = radius * ring.inner;
    const outer = radius * ring.outer;
    const geo = new THREE.RingGeometry(inner, outer, 128, 1);
    const pos = geo.getAttribute("position");
    const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      uv.setXY(i, (r - inner) / (outer - inner), 0.5);
    }
    uv.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({
      map: ring.texture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    // RingGeometry lies in the XY plane; rotate into the equatorial (local XZ) plane.
    mesh.rotation.x = -Math.PI / 2;
    node.add(mesh);
  }

  /** Reposition everything for sim time t. Origin must already be updated. */
  update(t: number): void {
    const tmp = new THREE.Vector3();
    const orbitsOn = this.vis.layer("orbits");
    for (const vis of this.visuals) {
      const { def } = vis;

      // Honour show/hide: a hidden body drops its marker, sphere and orbit.
      const shown = this.vis.bodyVisible(def.id, def.kind);
      vis.marker.visible = shown;
      vis.node.visible = shown;
      if (vis.orbit) vis.orbit.visible = shown && orbitsOn;
      if (!shown) continue;

      const state = bodyState(def, t);
      this.sm.toRender(state.r, tmp);
      vis.marker.position.copy(tmp);
      vis.node.position.copy(tmp);

      // Axial rotation at the real sidereal rate (retrograde from a negative rate).
      if (vis.spinRate !== 0) {
        vis.sphere.rotation.y = t * vis.spinRate;
        if (vis.clouds) vis.clouds.rotation.y = t * vis.cloudSpinRate;
      }

      // Emphasise the focused body: a larger, brighter marker draws the eye.
      const focused = def.id === this.sm.focusId;
      vis.marker.scale.setScalar(MARKER_SCALE[def.kind] * (focused ? FOCUS_MARKER_GAIN : 1));
      (vis.marker.material as THREE.SpriteMaterial).color.copy(focused ? vis.focusColor : vis.baseColor);

      if (orbitsOn && vis.orbit && vis.orbitArray && def.parent) {
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
