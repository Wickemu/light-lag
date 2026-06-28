/**
 * The distant-star backdrop, shared by the in-system sky and the interstellar map.
 *
 * Several hundred bright stars (>25 ly, down to mag ~4) would be hundreds of draw
 * calls as individual sprites, so the faint majority are drawn as ONE THREE.Points
 * cloud (a single draw call, per-point colour and size). Only the brightest handful
 * stay individual additive sprites so they bloom and can carry a name label.
 *
 * The whole thing is an UNZOOMABLE celestial sphere: every point/sprite sits at a
 * fixed radius along its true Sun→star direction, and the group is re-anchored to
 * the CAMERA each frame — so it never parallaxes or dollies (exactly like the
 * curated in-system sky in starViews). Directions are frozen at J2000: at >25 ly the
 * proper-motion drift is far below a pixel over the simulated span.
 */

import * as THREE from "three";
import { type BackdropStar } from "../core/stars.ts";
import { type SceneManager } from "./SceneManager.ts";
import { makeStarTexture, spectralTeff, blackbodyRGB, starSpriteStyle } from "./starViews.ts";

/** Brighter than this (apparent mag) → an individual additive sprite that blooms;
 *  fainter → a point in the fill cloud. */
const PROMOTE_MAG = 2.8;
/** Brighter than this → also gets a name label (keeps the labelled set to the few
 *  dozen genuinely famous stars rather than every bright point). */
const LABEL_MAG = 2.0;
/** Faint end of the fill band (= the catalogue magnitude limit). */
const FILL_FAINT = 4.0;
const FILL_MIN_PX = 1.3;
const FILL_MAX_PX = 3.4;

interface Promoted {
  dir: THREE.Vector3; // unit Sun→star direction (ecliptic-J2000)
  sprite: THREE.Sprite;
  label: HTMLElement | null;
}

const fillVertexShader = `
  attribute float size;
  attribute vec3 starColor;
  uniform float uPixelRatio;
  varying vec3 vColor;
  void main() {
    vColor = starColor;
    gl_PointSize = size * uPixelRatio;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const fillFragmentShader = `
  uniform sampler2D map;
  varying vec3 vColor;
  void main() {
    vec4 t = texture2D(map, gl_PointCoord);
    gl_FragColor = vec4(vColor, t.a);
  }
`;

export class SkyBackdrop {
  private tex = makeStarTexture();
  private group = new THREE.Group();
  private fillMat: THREE.ShaderMaterial;
  private promoted: Promoted[] = [];
  private labelLayer: HTMLElement;
  private tmp = new THREE.Vector3();

  constructor(
    private sm: SceneManager,
    uiRoot: HTMLElement,
    stars: BackdropStar[],
    private radius: number,
    labelClass: string,
  ) {
    this.group.frustumCulled = false;
    this.sm.scene.add(this.group);

    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "star-label-layer";
    uiRoot.appendChild(this.labelLayer);

    const dirOf = (s: BackdropStar): THREE.Vector3 => {
      const L = Math.hypot(s.pos.x, s.pos.y, s.pos.z) || 1;
      return new THREE.Vector3(s.pos.x / L, s.pos.y / L, s.pos.z / L);
    };

    // ── Fill cloud (one Points object) ──────────────────────────────────────
    const fill = stars.filter((s) => s.appMag > PROMOTE_MAG);
    const pos = new Float32Array(fill.length * 3);
    const col = new Float32Array(fill.length * 3);
    const siz = new Float32Array(fill.length);
    for (let i = 0; i < fill.length; i++) {
      const s = fill[i]!;
      const d = dirOf(s);
      pos[i * 3] = d.x * radius; pos[i * 3 + 1] = d.y * radius; pos[i * 3 + 2] = d.z * radius;
      // Brightness 0 (mag 4) → 1 (mag PROMOTE_MAG); intensity stays ≤ 1 so the fill
      // never crosses the bloom threshold — only the promoted sprites glow.
      const f = Math.min(1, Math.max(0, (FILL_FAINT - s.appMag) / (FILL_FAINT - PROMOTE_MAG)));
      const intensity = 0.45 + 0.55 * f;
      const c = blackbodyRGB(spectralTeff(s.spectralType));
      col[i * 3] = c.r * intensity; col[i * 3 + 1] = c.g * intensity; col[i * 3 + 2] = c.b * intensity;
      siz[i] = FILL_MIN_PX + f * (FILL_MAX_PX - FILL_MIN_PX);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("starColor", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("size", new THREE.BufferAttribute(siz, 1));
    this.fillMat = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.tex }, uPixelRatio: { value: 1 } },
      vertexShader: fillVertexShader,
      fragmentShader: fillFragmentShader,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, this.fillMat);
    points.frustumCulled = false;
    this.group.add(points);

    // ── Promoted bright stars (sprites + optional labels) ───────────────────
    for (const s of stars) {
      if (s.appMag > PROMOTE_MAG) continue;
      const d = dirOf(s);
      const { scale, gain } = starSpriteStyle(s.appMag);
      const c = blackbodyRGB(spectralTeff(s.spectralType));
      const mat = new THREE.SpriteMaterial({
        map: this.tex,
        color: new THREE.Color().setRGB(c.r * gain, c.g * gain, c.b * gain),
        sizeAttenuation: false, depthWrite: false, transparent: true,
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.setScalar(scale);
      sprite.position.set(d.x * radius, d.y * radius, d.z * radius);
      sprite.frustumCulled = false;
      this.group.add(sprite);

      let label: HTMLElement | null = null;
      if (s.appMag <= LABEL_MAG) {
        label = document.createElement("div");
        label.className = labelClass;
        label.textContent = s.name;
        this.labelLayer.appendChild(label);
      }
      this.promoted.push({ dir: d, sprite, label });
    }
  }

  /** Anchor the sphere to the camera and place the bright-star labels. One group
   *  transform does all the geometry; only the handful of labels do per-frame work. */
  update(starsOn: boolean, labelsOn: boolean): void {
    this.group.visible = starsOn;
    if (!starsOn) {
      for (const p of this.promoted) if (p.label) p.label.style.display = "none";
      return;
    }
    const cam = this.sm.camera.position;
    this.group.position.copy(cam);
    this.fillMat.uniforms.uPixelRatio!.value = this.sm.renderer.getPixelRatio();

    if (!labelsOn) {
      for (const p of this.promoted) if (p.label) p.label.style.display = "none";
      return;
    }
    const w = window.innerWidth, h = window.innerHeight;
    for (const p of this.promoted) {
      if (!p.label) continue;
      this.tmp.copy(p.dir).multiplyScalar(this.radius).add(cam).project(this.sm.camera);
      const on = this.tmp.z < 1 && Math.abs(this.tmp.x) <= 1 && Math.abs(this.tmp.y) <= 1;
      if (on) {
        p.label.style.display = "block";
        p.label.style.transform =
          `translate(${((this.tmp.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-this.tmp.y * 0.5 + 0.5) * h).toFixed(1)}px)`;
      } else {
        p.label.style.display = "none";
      }
    }
  }
}
