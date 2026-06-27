/**
 * Owns the Three.js scene, camera, renderer, and the floating origin.
 *
 * The renderer is a strictly read-only view of the sim: it asks the ephemeris
 * where bodies are at the current time and draws them. It never advances state.
 *
 * Floating origin: every frame we pick a focus point in world metres (the
 * focused body's position) and render everything relative to it. The camera
 * orbits the render-space origin (0,0,0), which therefore always coincides with
 * the focused body — switching focus just re-centres the universe on something
 * new.
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { type Vec3, vec3 } from "../core/math/vec3.ts";
import { bodyPosition } from "../core/ephemeris.ts";
import { BODY_BY_ID } from "../core/constants.ts";
import { metersToUnits, worldToRender } from "./scale.ts";

export type Theme = "dark" | "light";

/** Which map the renderer is showing. `system` is the in-system orrery (planets
 *  + a sky backdrop of the nearby stars); `interstellar` is the to-scale map of
 *  the nearby-star neighbourhood (Sol + the ~24 systems + ships in transit). */
export type ViewMode = "system" | "interstellar";

const BG: Record<Theme, number> = {
  dark: 0x05070d,
  light: 0xdfe6ef,
};

/** Bloom tuning per theme. Bloom runs in linear-HDR space *before* tone mapping,
 *  so the threshold is a linear luminance: only values brighter than it glow.
 *  - Dark (the "in space" mode): the Sun (HDR-emissive) blooms hard and bright
 *    sunlit limbs catch a touch of glow — the way a camera/eye responds.
 *  - Light (the "daylight blueprint" mode): the pale sky background sits at ~0.78
 *    linear, so we lift the threshold above it and soften the strength — only the
 *    Sun itself blooms, never the backdrop. */
const BLOOM: Record<Theme, { strength: number; radius: number; threshold: number }> = {
  dark: { strength: 0.72, radius: 0.55, threshold: 0.85 },
  light: { strength: 0.35, radius: 0.4, threshold: 1.05 },
};

export class SceneManager {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  /** Post-processing chain: scene → bloom → tone-map/output. The whole renderer
   *  is HDR (half-float) and linear until the final OutputPass, so the Sun can be
   *  genuinely brighter than white and bloom the way a real camera responds. */
  private composer!: EffectComposer;
  private bloom!: UnrealBloomPass;

  /** Active map. The in-system views and the interstellar view each draw only in
   *  their own mode (they self-park in the other), and the frame loop updates the
   *  matching set. */
  viewMode: ViewMode = "system";

  /** Body the camera is centred on; its world position is the floating origin. */
  focusId = "sun";
  private focusPos: Vec3 = vec3(0, 0, 0);
  private focusFn: (t: number) => Vec3 = (t) => bodyPosition("sun", t);
  private _theme: Theme = "dark";
  private sunLight!: THREE.PointLight;

  /** The active theme — overlay views read this to pick a legible palette. */
  get theme(): Theme {
    return this._theme;
  }

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // The single most important flag for a solar-system-scale scene: lets the
      // depth buffer span from a planet's surface to Neptune without z-fighting.
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Filmic response curve: the scene is lit in linear HDR (the Sun is far
    // brighter than white), and ACES rolls that enormous dynamic range down to
    // the display the way a real camera does — bright sunlit limbs stay detailed
    // instead of clipping to flat white, dark night sides keep their shape.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.camera = new THREE.PerspectiveCamera(50, 1, 1e-5, 1e9);
    // Start looking at the inner system from above the ecliptic.
    this.camera.position.set(0, 220, 420);
    this.camera.up.set(0, 0, 1); // ecliptic z is "up" in our world frame

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0, 0); // always the focused body
    this.controls.minDistance = 1e-3;
    this.controls.maxDistance = 5e6;
    this.controls.zoomSpeed = 1.2;

    this.addLighting();
    this.setupComposer();
    this.setTheme(this._theme);
    this.resize();

    // Size from the canvas's own layout, not just window events: this fixes the
    // 0×0 drawing buffer you get if the first resize() runs before layout, and
    // tracks container changes the window 'resize' event would miss.
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => this.resize()).observe(canvas);
    }
  }

  private addLighting(): void {
    // The Sun is the only real light source. `decay: 0` keeps its irradiance
    // constant across the system — a deliberate visibility choice, since true
    // 1/r² falloff would blow out Mercury and leave Neptune black in the same
    // frame (the sim itself still models real solar flux as 1/r²). Its render
    // position tracks the real Sun through the floating origin (updateOrigin), so
    // every body's terminator faces the actual Sun, not the camera.
    this.sunLight = new THREE.PointLight(0xfff4ea, 4.0, 0, 0);
    this.scene.add(this.sunLight);
    // A whisper of cool fill so night sides keep their silhouette instead of
    // crushing to unreadable black — the only concession to readability. Real
    // space is near-black on the night side; this is starlight/zodiacal-light
    // dim, an order of magnitude below the old value so terminators read sharply.
    this.scene.add(new THREE.AmbientLight(0x1a2438, 0.12));
  }

  /** Build the HDR post chain: render the linear scene into a multisampled
   *  half-float target, add bloom, then tone-map + encode to the canvas. */
  private setupComposer(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    // Half-float so HDR (Sun > 1.0) survives into the bloom pass; 4× MSAA so the
    // composer keeps the crisp geometry edges the bare renderer's antialias gave.
    const target = new THREE.WebGLRenderTarget(Math.max(size.x, 1), Math.max(size.y, 1), {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const b = BLOOM[this._theme];
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), b.strength, b.radius, b.threshold);
    this.composer.addPass(this.bloom);
    // OutputPass applies the renderer's tone mapping + sRGB encoding as the final
    // step, so bloom mixes in linear light before the curve is applied.
    this.composer.addPass(new OutputPass());
  }

  /** The Sun's current render-space position (metres mapped through the floating
   *  origin). Body atmosphere/ring shaders read this to light their limbs and
   *  cast the planet's shadow with the true Sun direction. */
  get sunRenderPosition(): THREE.Vector3 {
    return this.sunLight.position;
  }

  setTheme(theme: Theme): void {
    this._theme = theme;
    this.scene.background = new THREE.Color(BG[theme]);
    // Retune bloom for the new backdrop so the pale light-mode sky never glows.
    if (this.bloom) {
      const b = BLOOM[theme];
      this.bloom.strength = b.strength;
      this.bloom.radius = b.radius;
      this.bloom.threshold = b.threshold;
    }
  }

  /** Centre on an arbitrary moving world point (in metres), e.g. a ship. */
  setFocusTarget(id: string, fn: (t: number) => Vec3, frameDistanceUnits?: number): void {
    this.focusId = id;
    this.focusFn = fn;
    if (frameDistanceUnits !== undefined) this.placeCamera(frameDistanceUnits);
  }

  /** Centre on a body and pull the camera to a sensible distance for it: a wide
   *  system overview for the Sun, a close inspection pass for a planet or moon. */
  focusBody(id: string): void {
    const def = BODY_BY_ID.get(id);
    if (!def) return;
    const dist = def.kind === "star" ? 500 : Math.max(metersToUnits(def.radius) * 30, 0.02);
    this.setFocusTarget(id, (t) => bodyPosition(id, t), dist);
  }

  /** The exact in-system camera saved on entering the interstellar map, restored
   *  on return — a faithful round-trip regardless of what the focus is (a ship as
   *  readily as a body). */
  private savedSystem?: {
    camPos: THREE.Vector3;
    camTarget: THREE.Vector3;
    camUp: THREE.Vector3;
    min: number;
    max: number;
  };

  /** Switch maps. The two views never share a frame, so this just reframes the
   *  one camera: the interstellar view orbits Sol at its own scale and distance
   *  limits; returning restores the exact in-system camera. The views themselves
   *  park in the other mode (they read `viewMode` each frame). */
  setViewMode(mode: ViewMode): void {
    if (mode === this.viewMode) return;
    this.viewMode = mode;
    if (mode === "interstellar") {
      this.savedSystem = {
        camPos: this.camera.position.clone(),
        camTarget: this.controls.target.clone(),
        camUp: this.camera.up.clone(),
        min: this.controls.minDistance,
        max: this.controls.maxDistance,
      };
      this.frameInterstellar();
    } else {
      const s = this.savedSystem;
      this.controls.minDistance = s?.min ?? 1e-3;
      this.controls.maxDistance = s?.max ?? 5e6;
      if (s) {
        // Restore the camera verbatim. The in-system focus was never changed
        // (the interstellar view ignores the floating origin), so the focused
        // body/ship is still centred at the render origin = controls.target —
        // including any focus chosen from a planner while the map was open.
        this.camera.up.copy(s.camUp);
        this.controls.target.copy(s.camTarget);
        this.camera.position.copy(s.camPos);
      } else {
        this.focusBody("sun");
      }
      this.controls.update();
    }
  }

  /** Re-snap the camera to a sensible default for whichever view is active. */
  resetView(): void {
    if (this.viewMode === "interstellar") this.frameInterstellar();
    else this.focusBody(this.focusId);
  }

  /** Frame the interstellar map: Sol at the render origin, camera above and back
   *  along the ecliptic, the whole 12-ly neighbourhood in view. The in-system
   *  focus is left untouched — the interstellar view computes its own positions
   *  about Sol and never consults the floating origin. */
  private frameInterstellar(): void {
    this.controls.minDistance = 5;
    this.controls.maxDistance = 5000;
    this.controls.target.set(0, 0, 0);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(0, 360, 760);
    this.controls.update();
  }

  /** Reposition the camera at a distance from the focus, keeping its direction. */
  private placeCamera(dist: number): void {
    const dir = this.camera.position.clone().sub(this.controls.target);
    if (dir.lengthSq() === 0) dir.set(0, 0.5, 1);
    dir.normalize().multiplyScalar(dist);
    this.camera.position.copy(this.controls.target).add(dir);
    this.controls.update();
  }

  /** Recompute the floating origin for the current sim time. Call once per frame
   *  before positioning any body. */
  updateOrigin(t: number): void {
    this.focusPos = this.focusFn(t);
    // Keep the Sun's light at the real Sun, expressed through the floating origin.
    this.sunLight.position.copy(this.toRender(bodyPosition("sun", t)));
  }

  get origin(): Vec3 {
    return this.focusPos;
  }

  /** World metres -> render-space vector relative to the current focus. */
  toRender(worldPos: Vec3, out?: THREE.Vector3): THREE.Vector3 {
    return worldToRender(worldPos, this.focusPos, out);
  }

  /** Approximate camera distance from focus, in metres (for LOD / UI). */
  cameraDistanceMeters(): number {
    return this.camera.position.distanceTo(this.controls.target) * (1 / metersToUnits(1));
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Keep the post chain matched to the (device-pixel) drawing buffer.
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composer?.setSize(size.x, size.y);
    this.bloom?.setSize(size.x, size.y);
  }

  render(): void {
    this.controls.update();
    this.composer.render();
  }
}
