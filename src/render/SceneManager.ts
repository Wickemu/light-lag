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
import { BokehPass } from "three/addons/postprocessing/BokehPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { type Vec3, vec3 } from "@lightlag/engine/math/vec3";
import { bodyPosition } from "@lightlag/engine/ephemeris";
import { BODY_BY_ID } from "@lightlag/engine/constants";
import { metersToUnits, worldToRender } from "./scale.ts";
import { smoothstep, easedFollowTarget } from "./overlayUtil.ts";

export type Theme = "dark" | "light";

/** Which map the renderer is showing. `system` is the in-system orrery (planets
 *  + a sky backdrop of the nearby stars); `interstellar` is the to-scale map of
 *  the nearby-star neighbourhood (Sol + the ~24 systems + ships in transit). */
export type ViewMode = "system" | "interstellar";

/** How far back a fly-to bows the camera mid-flight, as a fraction of the gap
 *  between the two bodies. The camera rises just enough that the journey reads as
 *  motion — NOT enough to frame both endpoints (that "zoom out to the whole
 *  system and back" is what feels jarring on a long hop). ~0.3 keeps a distant
 *  target's pull-back to roughly a third of the gap: the eye sees it lift, sweep
 *  over, and settle, with the fast part of the sweep crossing the (empty) middle.
 *  Only bites when the gap dwarfs the framing distances — short hops just dolly. */
const FLY_ARC_FRACTION = 0.3;

/** Camera-motion style for an in-system fly-to. This is the reversible switch for
 *  the "make the system-map fly-to feel like the interstellar map" experiment:
 *   - "glide": the interstellar method. Hold the user's current zoom/orbit offset
 *     and glide the look-at across to centre the new target — no reframing to a
 *     per-body inspection distance, no mid-flight arc. It is the gentle slide the
 *     interstellar follow (`followInterstellarEased`) uses, applied to bodies.
 *     Trade-off: a hop between wildly different scales (a moon close-up → the whole
 *     Sun) keeps the OLD zoom, so the target can land much larger/smaller than the
 *     arc mode would have framed it. That's the "not sure it'll translate" risk.
 *   - "arc": the original in-system motion — ease the seat distance to a sensible
 *     framing for the target and bow the camera out mid-flight (see FLY_ARC_FRACTION).
 *  Flip this one value to "arc" to restore the previous behaviour verbatim. */
type FlyToMotion = "glide" | "arc";
const FLY_TO_MOTION: FlyToMotion = "glide";

/** Duration (real seconds) of a "glide" fly-to. Matches the interstellar follow
 *  ease (INTERSTELLAR_FOLLOW_EASE_S) so the two maps read as the same move. Only
 *  consulted when FLY_TO_MOTION === "glide"; "arc" paces itself by zoom travel. */
const FLY_GLIDE_DURATION_S = 0.6;

/** Camera framing distance for a "zoom to group" as a multiple of the group's
 *  outermost member apoapsis. The vertical FOV is 50°, so an orbit of radius R is
 *  edge-to-edge at ~2.14·R; ~2.6 leaves a comfortable margin so the farthest,
 *  most eccentric members (e.g. Jupiter's Carme/Ananke) sit fully inside the view
 *  rather than grazing the frame. */
const GROUP_FRAME_FACTOR = 2.6;

/** Duration (real seconds) of the eased glide into a newly-acquired interstellar follow
 *  target. Short enough to feel responsive, long enough to read as a deliberate move into
 *  the focus rather than a snap — in the same 0.5–2 s band the in-system fly-to settles in. */
const INTERSTELLAR_FOLLOW_EASE_S = 0.6;

/** Reused scratch for the eased follow look-at, so the per-frame follow never allocates. */
const _easeScratch = new THREE.Vector3();

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

/** Graphics-quality presets, toggled from the help panel. The post chain (HDR +
 *  MSAA + UnrealBloom) is fill-rate bound, so its cost scales with the total
 *  drawing-buffer pixels. "performance" trades a little crispness for frame rate
 *  on integrated GPUs by pushing fewer pixels three ways:
 *   - pixelCap:    cap the device-pixel ratio (2 → 1.5 ⇒ ~0.56× the buffer area)
 *   - samples:     halve MSAA in the post target (4× → 2×)
 *   - bloomScale:  run the bloom blur pyramid at half resolution (¼ the blur cost)
 *  "quality" is the unchanged default — nothing is downgraded unless asked. */
const QUALITY = {
  quality: { pixelCap: 2, samples: 4, bloomScale: 1 },
  performance: { pixelCap: 1.5, samples: 2, bloomScale: 0.5 },
} as const;

/** Lens / "vanity" camera. The focal length is expressed against a fixed
 *  full-frame sensor height (24 mm), NOT the camera's aspect-dependent film
 *  gauge, so a chosen focal length frames the same way regardless of window
 *  shape — resizing never silently re-zooms the lens. A longer focal length is a
 *  narrower vertical FOV: fov = 2·atan(sensor / 2f). The default is whatever
 *  focal length reproduces the app's original 50° framing (~25.7 mm), so nothing
 *  changes until the user reaches for the lens. */
const LENS = {
  sensorMm: 24,
  minMm: 15, // ~77° — a wide establishing lens
  maxMm: 300, // ~4.6° — a compressed telephoto
  defaultFovDeg: 50,
} as const;

/** Depth-of-field ramp constant. The Bokeh aperture is set to `k / focus` each
 *  frame (see `updateDof`), which makes the blur depend on the *ratio* of a
 *  point's distance to the focus distance rather than its absolute distance — so
 *  a given DOF "amount" behaves the same whether you're framing the Sun at 500
 *  units or a moon at 0.02. With this k, an object at ~1.6× the focus distance is
 *  fully out of focus at amount = 1. */
const DOF_APERTURE_K = 0.033;
/** Max blur radius (fraction of the frame) at DOF amount = 1 — the size the
 *  farthest bokeh discs reach. Kept modest so a strong setting reads as a soft,
 *  photographic fall-off rather than a smear. */
const DOF_MAX_BLUR = 0.02;

/** World "up" for the render frame (ecliptic north). Roll rotates the camera's
 *  up hint around the view axis away from this; roll 0 restores it exactly. */
const WORLD_UP = new THREE.Vector3(0, 0, 1);
/** Reused scratch for the per-frame roll so it never allocates. */
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
/** Reused scratch for the per-frame DOF rack-focus point. */
const _dofPt = new THREE.Vector3();

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
  /** Depth-of-field (bokeh) pass, sitting between the scene render and bloom so
   *  out-of-focus highlights bloom into soft discs. Always in the chain but
   *  `enabled` only while the user turns DOF on (a disabled pass is skipped by the
   *  composer, so it costs nothing off). */
  private bokeh!: BokehPass;
  /** When false, the whole post chain is bypassed and the scene renders straight
   *  to the canvas (tone mapping still applied by the renderer) — much cheaper, a
   *  user toggle for frame rate. Bypassed only when DOF is also off; DOF needs the
   *  composer, so turning it on keeps the chain alive with bloom skipped. */
  private bloomOn = true;

  /** Lens/vanity state. `focalMm` drives the camera FOV (see `setFocalLength`);
   *  DOF is off by default with a mid aperture and focus locked on the subject.
   *  `dofFocusBias` shifts the focal plane in front of / behind the subject as a
   *  fraction of the subject distance (0 = on the subject, +0.5 = half again as
   *  far, −0.5 = halfway in). `rollAngle` banks the camera about its view axis. */
  private focalMm = SceneManager.fovToFocal(LENS.defaultFovDeg);
  private dofOn = false;
  private dofAmount = 0.5;
  private dofFocusBias = 0;
  /** A "rack focus" subject: a body id the DOF focal plane is pinned to, chosen by
   *  clicking a body while the lens panel is open — INDEPENDENT of the orbit target,
   *  so the camera never moves. `null` means focus on the orbit target (the focused
   *  body at the render origin), the default. Cleared on any real focus change. */
  private dofFocusId: string | null = null;
  private rollAngle = 0;
  /** Graphics-quality preset: false = quality (default), true = performance.
   *  Drives the device-pixel cap, MSAA sample count and bloom blur resolution. */
  private perfMode = false;

  /** Active map. The in-system views and the interstellar view each draw only in
   *  their own mode (they self-park in the other), and the frame loop updates the
   *  matching set. */
  viewMode: ViewMode = "system";

  /** In the interstellar view, the id of the ship the camera follows, or `null` for
   *  Sol at the origin (the default). The interstellar view owns the geometry — it
   *  pushes the followed ship's scaled position each frame via `followInterstellar`,
   *  so this stays just a selection, never a world reference. Separate from `focusId`
   *  because the interstellar view ignores the in-system floating origin. */
  private interstellarFocus: string | null = null;

  /** An in-progress eased transition INTO a newly-acquired interstellar follow target.
   *  While set, the camera glides its look-at from where it was toward the target over
   *  `duration` real seconds (smoothstep), preserving the user's zoom/orbit offset, then
   *  hands off to the steady-state 1:1 lock (`followInterstellar`). `lastFollowId` tracks
   *  which target the current ease belongs to, so a focus *change* restarts the glide while
   *  a continuous follow does not. Render-only; never touches sim state. */
  private interstellarFollow?: { startTarget: THREE.Vector3; elapsed: number; duration: number; lastMs?: number };
  private lastFollowId: string | null = null;

  /** Body the camera is centred on; its world position is the floating origin. */
  focusId = "sun";
  private focusPos: Vec3 = vec3(0, 0, 0);
  private focusFn: (t: number) => Vec3 = (t) => bodyPosition("sun", t);

  /** An in-progress fly-to. While set, the floating origin stays on the *old*
   *  focus and we pan/zoom the camera across to where the new target is, so the
   *  scene glides over instead of snapping. On arrival the origin is handed off
   *  to the new target (see `advanceFlight`). */
  private flight?: {
    fn: (t: number) => Vec3; // the new focus point (target of the flight)
    dist: number; // framing distance to settle at, in render units
    dir: THREE.Vector3; // unit target→camera offset direction, held constant
    startTarget: THREE.Vector3; // camera target at lift-off (old-origin render space)
    startDist: number; // camera distance from target at lift-off, in render units
    midDist: number; // arc apex distance (render units), fixed at lift-off; == startDist in glide mode (no arc)
    elapsed: number; // seconds since lift-off
    duration: number; // total flight time, seconds
  };
  /** Real-time clock (ms) of the previous flight step, for frame-rate-independent
   *  easing; undefined when no flight is running. */
  private flightLastMs?: number;
  /** Most recent sim time handed to `updateOrigin`; lets an interrupt (a user
   *  grab) re-home the origin at the correct instant. */
  private lastT = 0;
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
    this.applyPixelRatio();
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
    // Grabbing the view mid-flight hands control back to the user at once: keep
    // the camera where their pointer caught it, just re-home precision on the
    // target body. (OrbitControls 'start' fires on drag/zoom, not keyboard.)
    this.controls.addEventListener("start", () => this.cancelFlight());
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
    // Half-float so HDR (Sun > 1.0) survives into the bloom pass; MSAA so the
    // composer keeps the crisp geometry edges the bare renderer's antialias gave
    // (4× in quality, 2× in performance).
    const target = new THREE.WebGLRenderTarget(Math.max(size.x, 1), Math.max(size.y, 1), {
      type: THREE.HalfFloatType,
      samples: QUALITY[this.perfMode ? "performance" : "quality"].samples,
    });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Depth-of-field first, so the bloom that follows glows the already-defocused
    // image (out-of-focus highlights spread into bokeh discs). It renders its own
    // depth via MeshDepthMaterial, which packs the standard perspective NDC depth
    // independent of our logarithmic depth buffer — so the focus reconstruction is
    // correct despite the huge near/far span. `focus`/`aperture` are set per frame
    // from the subject distance in `updateDof`; it's skipped while `enabled` is off.
    this.bokeh = new BokehPass(this.scene, this.camera, { focus: 1, aperture: 0, maxblur: DOF_MAX_BLUR });
    this.bokeh.enabled = this.dofOn;
    this.composer.addPass(this.bokeh);
    const b = BLOOM[this._theme];
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), b.strength, b.radius, b.threshold);
    this.bloom.enabled = this.bloomOn;
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

  get bloomEnabled(): boolean {
    return this.bloomOn;
  }

  /** Enable/disable bloom. Off bypasses the entire post chain (no HDR target, no
   *  blur passes) for a large frame-rate win — UNLESS DOF is on, which needs the
   *  composer, in which case the chain stays live with the bloom pass skipped. The
   *  scene always keeps ACES tone mapping, the lit Sun, atmospheres, ring shadow
   *  and accurate stars — bloom off just loses the soft glow. */
  setBloomEnabled(on: boolean): void {
    this.bloomOn = on;
    if (this.bloom) this.bloom.enabled = on;
  }

  get performanceMode(): boolean {
    return this.perfMode;
  }

  /** Switch the graphics-quality preset. The MSAA sample count is baked into the
   *  post target at creation, so changing it means rebuilding the composer; the
   *  pixel-ratio cap and bloom scale are then re-applied by resize(). Cheap
   *  enough for a settings toggle (one target re-allocation), and a no-op when
   *  the mode is unchanged. */
  setPerformanceMode(on: boolean): void {
    if (on === this.perfMode && this.composer) return;
    this.perfMode = on;
    this.applyPixelRatio();
    this.rebuildComposer();
    this.resize();
  }

  /** Cap the device-pixel ratio per the active quality preset. */
  private applyPixelRatio(): void {
    const cap = QUALITY[this.perfMode ? "performance" : "quality"].pixelCap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, cap));
  }

  /** Tear down and rebuild the post chain (e.g. to change MSAA samples). */
  private rebuildComposer(): void {
    this.composer?.dispose();
    this.bloom?.dispose();
    this.bokeh?.dispose();
    this.setupComposer();
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

  /** Centre on an arbitrary moving world point (in metres), e.g. a ship. When a
   *  framing distance is given and we're in the in-system view, the camera flies
   *  there instead of snapping (see `startFlight`); otherwise the origin is
   *  re-homed instantly — the right behaviour for a continuous follow or the
   *  interstellar map, which frames itself. */
  setFocusTarget(id: string, fn: (t: number) => Vec3, frameDistanceUnits?: number): void {
    // A real focus change makes this body the subject, so any earlier rack-focus
    // (a DOF plane pinned to some other body) is stale — drop it so DOF tracks the
    // new focus again.
    this.dofFocusId = null;
    // A non-finite framing distance (e.g. a degenerate osculating apoapsis, a→∞) would seat the
    // camera at a NaN/Infinity position and black out the entire view — and, because the bad
    // value is sticky, no later focus/zoom would recover it. Never let one through: re-home the
    // origin to follow the target, but keep the current camera distance.
    if (frameDistanceUnits !== undefined && !Number.isFinite(frameDistanceUnits)) {
      frameDistanceUnits = undefined;
    }
    if (frameDistanceUnits !== undefined && this.viewMode === "system") {
      this.startFlight(id, fn, frameDistanceUnits);
      return;
    }
    this.flight = undefined;
    this.focusId = id;
    this.focusFn = fn;
    if (frameDistanceUnits !== undefined) this.placeCamera(frameDistanceUnits);
  }

  /** Centre on a body and pull the camera to a sensible distance for it: a wide
   *  system overview for the Sun, a close inspection pass for a planet or moon. */
  focusBody(id: string): void {
    const def = BODY_BY_ID.get(id);
    if (!def) return;
    this.setFocusTarget(id, (t) => bodyPosition(id, t), this.bodyFrameDistance(def));
  }

  /** The framing distance (render units) `focusBody` settles a body at: a fixed
   *  wide view for the Sun, else ~30 body radii for a close inspection pass. */
  private bodyFrameDistance(def: { kind: string; radius: number }): number {
    return def.kind === "star" ? 500 : Math.max(metersToUnits(def.radius) * 30, 0.02);
  }

  /** Centre on the body a group orbits (the Sun for a small-body region, a planet
   *  for its moon system) and pull the camera back far enough to frame the whole
   *  group within their orbits — `maxOrbitRadiusM` is the largest member apoapsis
   *  in metres. The orbit-fit distance is floored at the body's own close-up
   *  framing, so a tight system (Mars + Phobos/Deimos) never zooms IN past the
   *  plain body view. This is the FOCUS list's "zoom to the whole group" — wider
   *  than clicking the body itself, which frames only the body. */
  frameGroup(anchorId: string, maxOrbitRadiusM: number): void {
    const def = BODY_BY_ID.get(anchorId);
    if (!def) return;
    const orbitDist = metersToUnits(maxOrbitRadiusM) * GROUP_FRAME_FACTOR;
    const dist = Math.max(orbitDist, this.bodyFrameDistance(def));
    this.setFocusTarget(anchorId, (t) => bodyPosition(anchorId, t), dist);
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
    this.flight = undefined; // a mode switch reframes the camera outright
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

  /** Re-snap the camera to a sensible default for whichever view is active. In the
   *  interstellar view this also drops any ship-follow back to Sol (clearing the HUD
   *  selection), so `R` always means "frame the whole neighbourhood". */
  resetView(): void {
    this.resetRoll(); // level the horizon along with re-framing
    if (this.viewMode === "interstellar") this.setInterstellarFocus(null);
    else this.focusBody(this.focusId);
  }

  /** The id of the ship the interstellar camera is following, or `null` for Sol.
   *  Read by the interstellar view (to push the follow position) and the HUD (to
   *  light the active entry in its FOLLOW list). */
  get interstellarFocusId(): string | null {
    return this.interstellarFocus;
  }

  /** Choose what the interstellar camera follows: a ship id, or `null` to recentre
   *  on Sol. Just records the selection — the per-frame tracking is driven by the
   *  interstellar view through `followInterstellar` (it owns the scaled geometry).
   *  Clearing while the interstellar map is open reframes Sol at once; in the system
   *  view it only stores the choice, taking effect when the map is next opened. */
  setInterstellarFocus(id: string | null): void {
    this.interstellarFocus = id;
    // Clearing ends any in-progress glide and resets the acquisition tracker, so the next
    // pick (even the same target again) starts a fresh eased glide rather than snapping.
    if (id === null) {
      this.interstellarFollow = undefined;
      this.lastFollowId = null;
    }
    if (id === null && this.viewMode === "interstellar") this.frameInterstellar();
  }

  /** Per-frame interstellar follow: lock the camera onto a moving render-space point
   *  (the followed ship's scaled position). Shifting the look-at AND the camera by
   *  the same vector leaves the user's orbit offset and zoom untouched while keeping
   *  the ship centred — the same hand-off trick `advanceFlight`/`cancelFlight` use,
   *  and it keeps `|camera − target|` (so the min/max-distance clamp) invariant. The
   *  first follow frame recentres the ship to where Sol sat; later frames track it as
   *  it crawls outward and the starfield drifts past. Only meaningful in the
   *  interstellar view; a no-op-equivalent elsewhere since nothing calls it there. */
  followInterstellar(pos: THREE.Vector3): void {
    const delta = pos.clone().sub(this.controls.target);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
  }

  /** Eased interstellar follow — the gentle version of `followInterstellar`. The view
   *  calls this each frame with the followed target's live scaled position. On *acquiring*
   *  a follow (the focus id changed since last frame) it begins a smoothstep glide from the
   *  camera's current look-at toward the target over ~0.6 s; while gliding it eases the
   *  look-at (and shifts the camera by the same vector, so zoom/orbit offset stay exactly
   *  invariant — the `followInterstellar` shift-both trick) toward `lerp(start, pos, e)`,
   *  with `pos` sampled fresh so a moving ship is still tracked. Once the glide completes it
   *  falls through to the steady 1:1 lock, so a continuous follow is unchanged. Real
   *  wall-clock `dt` (like `advanceFlight`), so it is independent of time-warp and never
   *  feeds back into the sim. */
  followInterstellarEased(pos: THREE.Vector3): void {
    // A new/changed follow target: start a fresh glide from wherever the camera is now.
    if (this.interstellarFocus !== this.lastFollowId) {
      this.lastFollowId = this.interstellarFocus;
      this.interstellarFollow = {
        startTarget: this.controls.target.clone(),
        elapsed: 0,
        duration: INTERSTELLAR_FOLLOW_EASE_S,
        lastMs: undefined,
      };
    }

    const fl = this.interstellarFollow;
    if (!fl) {
      this.followInterstellar(pos); // steady-state lock (glide already finished)
      return;
    }

    const now = typeof performance !== "undefined" ? performance.now() : 0;
    const dt = fl.lastMs === undefined ? 0 : Math.max(0, (now - fl.lastMs) / 1000);
    fl.lastMs = now;
    fl.elapsed += dt;
    const p = fl.duration > 0 ? Math.min(1, fl.elapsed / fl.duration) : 1;

    // Ease the look-at toward the live target; shift the camera by the same delta so the
    // user's zoom and orbit offset (|camera − target|) are untouched, exactly as the 1:1
    // lock does — only the step size is eased rather than the full gap each frame.
    const desired = easedFollowTarget(fl.startTarget, pos, p, _easeScratch);
    const delta = desired.sub(this.controls.target);
    this.controls.target.add(delta);
    this.camera.position.add(delta);

    if (p >= 1) this.interstellarFollow = undefined; // hand off to the steady lock
  }

  /** Frame the interstellar map: Sol at the render origin, camera above and back
   *  along the ecliptic, the whole 12-ly neighbourhood in view. The in-system
   *  focus is left untouched — the interstellar view computes its own positions
   *  about Sol and never consults the floating origin. */
  private frameInterstellar(): void {
    this.flight = undefined;
    // A full reframe ends any eased follow and resets the acquisition tracker, so a target
    // picked after this (including the same one) glides in fresh from the Sol framing.
    this.interstellarFollow = undefined;
    this.lastFollowId = null;
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

  /** Begin a fly-to: the new focus is highlighted at once, but the floating
   *  origin stays on the current body so the camera can glide across to the
   *  target (panning the look-at point and easing the distance) before the
   *  origin is handed off. Re-selecting during a flight simply retargets it. */
  private startFlight(id: string, fn: (t: number) => Vec3, dist: number): void {
    // Discard any leftover OrbitControls momentum (a just-released drag/zoom keeps
    // damped velocity that `update()` would otherwise feed in for several frames),
    // so the flight begins from exactly the camera the user is looking at — not one
    // still drifting out from under them.
    this.stopControlsDrift();

    const offset = this.camera.position.clone().sub(this.controls.target);
    if (offset.lengthSq() === 0) offset.set(0, 0.5, 1);
    const startDist = Math.max(offset.length(), 1e-6);
    const dir = offset.normalize();
    this.focusId = id; // light up the selection immediately

    let midDist: number;
    let duration: number;
    if (FLY_TO_MOTION === "glide") {
      // Interstellar-style glide: the seat distance never changes, so there is no
      // arc to bow through and no zoom travel to pace by. Hold the current framing
      // (midDist = startDist ⇒ zero bow in advanceFlight) and pan the look-at across
      // for a fixed, deliberate beat matching the interstellar follow ease.
      midDist = startDist;
      duration = FLY_GLIDE_DURATION_S;
    } else {
      // The apex distance of the arc, fixed now so the zoom curve is stable even if
      // the target drifts mid-flight (the look-at still tracks it live). For a short
      // hop this is just the natural mid-dolly (geometric mean) and the arc is flat;
      // for a long hop it lifts to ~FLY_ARC_FRACTION of the gap — enough to read the
      // travel, far short of framing the whole span.
      const sep = this.toRender(fn(this.lastT)).distanceTo(this.controls.target);
      const geomMid = Math.sqrt(startDist * dist);
      midDist = Math.max(geomMid, sep * FLY_ARC_FRACTION);

      // Duration scales with the actual zoom travelled — out to the apex, then in to
      // the destination, in octaves — so a moon hop stays snappy while a cross-system
      // leg gets enough time to glide instead of being whipped across.
      const travel = Math.abs(Math.log2(midDist / startDist)) + Math.abs(Math.log2(dist / midDist));
      duration = Math.min(2.0, Math.max(0.5, 0.45 + 0.085 * travel));
    }

    this.flight = {
      fn,
      dist,
      dir,
      startTarget: this.controls.target.clone(),
      startDist,
      midDist,
      elapsed: 0,
      duration,
    };
    this.flightLastMs = undefined;
    // focusFn is deliberately left on the old body: it remains the render origin
    // until advanceFlight lands and swaps it.
  }

  /** Zero OrbitControls' damped residuals (orbit/zoom/pan momentum) so the next
   *  `update()` reproduces the current camera exactly instead of nudging it. Used
   *  when a fly-to takes over: the flight is the authority, and any leftover drift
   *  from a recent drag would otherwise show up as a small lurch on lift-off. */
  private stopControlsDrift(): void {
    const c = this.controls as unknown as {
      _sphericalDelta?: { set(x: number, y: number, z: number): void };
      _panOffset?: { set(x: number, y: number, z: number): void };
      _scale?: number;
    };
    c._sphericalDelta?.set(0, 0, 0);
    c._panOffset?.set(0, 0, 0);
    if (typeof c._scale === "number") c._scale = 1;
  }

  /** Advance the active fly-to by one frame. The look-at point and camera ease
   *  from lift-off toward the target (recomputed each frame, so a moving target
   *  is tracked); on arrival the origin is swapped to the target. Shifting both
   *  the origin and the camera by the same vector leaves the rendered image
   *  unchanged, so the hand-off is seamless — and precision re-centres on the
   *  new focus. */
  private advanceFlight(t: number): void {
    const f = this.flight!;
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    const dt = this.flightLastMs === undefined ? 0 : Math.max(0, (now - this.flightLastMs) / 1000);
    this.flightLastMs = now;
    f.elapsed += dt;
    const p = f.duration > 0 ? Math.min(1, f.elapsed / f.duration) : 1;
    const e = smoothstep(p); // ease in and out

    // Target's position in the *current* (old-origin) render space. Pan the look-at
    // straight across to it; the seat distance is what makes the motion read.
    const endTarget = this.toRender(f.fn(t));
    this.controls.target.copy(f.startTarget).lerp(endTarget, e);

    // Seat distance. In the interstellar-style glide it is held at the lift-off
    // value: the user's zoom/orbit offset is preserved and ONLY the look-at glides
    // across (camera and target shift by the same delta each frame — the exact trick
    // followInterstellarEased uses). The arc mode instead eases the distance to the
    // target's framing and bows out to the apex mid-flight.
    let dist: number;
    if (FLY_TO_MOTION === "glide") {
      dist = f.startDist;
    } else {
      // Geometric (log-space) interpolation of the seat distance: the old body
      // recedes and the new one swells at a *perceptually* even rate, since apparent
      // size goes as 1/distance. A linear dolly would shrink the body you left to a
      // dot within the first frames and rush the new one in only at the very end.
      const base = f.startDist * Math.pow(f.dist / f.startDist, e);
      // Bow the camera out to the apex distance mid-flight, then back in — a gentle
      // rise-and-settle that lets a long hop read as travel. sin() is zero at both
      // ends, so lift-off and arrival are untouched; the bow is the extra height of
      // the apex above the natural mid-dolly, and is ~0 when no pull-back is needed.
      const bow = Math.max(0, f.midDist - Math.sqrt(f.startDist * f.dist));
      dist = base + bow * Math.sin(Math.PI * e);
    }
    this.camera.position.copy(this.controls.target).addScaledVector(f.dir, dist);

    if (p >= 1) {
      this.focusFn = f.fn;
      this.focusPos = f.fn(t);
      this.controls.target.set(0, 0, 0);
      // Settle at the framing the motion aimed for: the preserved lift-off zoom for a
      // glide, the target's computed inspection distance for an arc.
      const settleDist = FLY_TO_MOTION === "glide" ? f.startDist : f.dist;
      this.camera.position.copy(f.dir).multiplyScalar(settleDist);
      this.flight = undefined;
      this.flightLastMs = undefined;
    }
  }

  /** Abort any fly-to, re-homing the floating origin on the target without
   *  moving the camera — precision follows the new focus while the user keeps
   *  the exact view they grabbed. */
  private cancelFlight(): void {
    const f = this.flight;
    if (!f) return;
    const shift = this.toRender(f.fn(this.lastT));
    this.controls.target.sub(shift);
    this.camera.position.sub(shift);
    this.focusFn = f.fn;
    this.focusPos = f.fn(this.lastT);
    this.flight = undefined;
    this.flightLastMs = undefined;
  }

  /** Recompute the floating origin for the current sim time. Call once per frame
   *  before positioning any body. */
  updateOrigin(t: number): void {
    this.lastT = t;
    this.focusPos = this.focusFn(t);
    // Drive any in-progress fly-to before the rest of the scene reads the camera;
    // it may hand the floating origin off to the flight's target (and recompute
    // focusPos), so it runs against the old origin set just above.
    if (this.flight) this.advanceFlight(t);
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
    // composer.setSize() resets every pass (incl. bloom) to the full buffer, so
    // re-apply the bloom blur scale *after* it. The blur pyramid is downsampled
    // anyway, so a half-res base is near-invisible but a quarter of the cost.
    const scale = QUALITY[this.perfMode ? "performance" : "quality"].bloomScale;
    this.bloom?.setSize(Math.max(1, Math.round(size.x * scale)), Math.max(1, Math.round(size.y * scale)));
  }

  render(): void {
    // Bank the camera about its view axis before OrbitControls issues its lookAt,
    // which reads camera.up — so the roll is baked into the very next frame.
    this.applyRoll();
    this.controls.update();
    if (this.dofOn) this.updateDof();
    // The composer is required for DOF; otherwise it's only worth its cost for
    // bloom. With neither, draw straight to the canvas (tone mapping still applied).
    if (this.bloomOn || this.dofOn) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  // ── Lens / vanity camera ──────────────────────────────────────────────────

  /** Vertical FOV (deg) for a focal length (mm) against the fixed sensor. */
  private static focalToFov(mm: number): number {
    return (2 * Math.atan(LENS.sensorMm / (2 * mm)) * 180) / Math.PI;
  }
  /** The inverse — the focal length (mm) that yields a given vertical FOV (deg). */
  private static fovToFocal(deg: number): number {
    return LENS.sensorMm / (2 * Math.tan((deg * Math.PI) / 360));
  }

  /** The lens focal length in mm (drives the field of view). */
  get focalLength(): number {
    return this.focalMm;
  }

  /** Set the lens focal length in mm, clamped to the usable range. Longer = more
   *  telephoto (narrower FOV, compressed depth); shorter = wider. Independent of
   *  the dolly zoom (camera distance), so it's a true lens change, not a move. */
  setFocalLength(mm: number): void {
    this.focalMm = Math.max(LENS.minMm, Math.min(LENS.maxMm, mm));
    this.camera.fov = SceneManager.focalToFov(this.focalMm);
    this.camera.updateProjectionMatrix();
  }

  /** The lens range (mm) and the default, for building the control. */
  get lensRange(): { min: number; max: number; def: number } {
    return { min: LENS.minMm, max: LENS.maxMm, def: SceneManager.fovToFocal(LENS.defaultFovDeg) };
  }

  // ── Roll (camera bank) ────────────────────────────────────────────────────

  /** Current roll angle in radians (0 = ecliptic-level horizon). */
  get roll(): number {
    return this.rollAngle;
  }

  /** Bank the camera by `delta` radians about its current view axis (Q/E). */
  rollBy(delta: number): void {
    this.rollAngle += delta;
  }

  /** Level the horizon again (roll → 0). */
  resetRoll(): void {
    this.rollAngle = 0;
  }

  /** Rotate the camera's up hint around the view direction by the roll angle, so
   *  OrbitControls' lookAt tilts the horizon while the orbit frame stays
   *  ecliptic-aligned (position/orbit are computed from the fixed z-up frame, only
   *  the view banks). At roll 0 this restores up to exact ecliptic north, so it's a
   *  harmless no-op then. Degenerate when the view looks straight up the z axis
   *  (up ∥ forward); the rotation simply does nothing there. */
  private applyRoll(): void {
    _fwd.copy(this.controls.target).sub(this.camera.position);
    if (_fwd.lengthSq() === 0) return;
    _fwd.normalize();
    _up.copy(WORLD_UP).applyAxisAngle(_fwd, this.rollAngle);
    this.camera.up.copy(_up);
  }

  // ── Depth of field ────────────────────────────────────────────────────────

  get dofEnabled(): boolean {
    return this.dofOn;
  }
  /** DOF blur amount (0 = none/pinhole, 1 = shallowest depth of field). */
  get dofBlur(): number {
    return this.dofAmount;
  }
  /** Focus-plane bias: 0 sits on the subject, + pushes it back, − pulls it in. */
  get dofFocus(): number {
    return this.dofFocusBias;
  }

  setDofEnabled(on: boolean): void {
    this.dofOn = on;
    if (this.bokeh) this.bokeh.enabled = on;
  }
  setDofBlur(amount: number): void {
    this.dofAmount = Math.max(0, Math.min(1, amount));
  }
  setDofFocus(bias: number): void {
    this.dofFocusBias = Math.max(-0.9, Math.min(3, bias));
  }

  /** The rack-focus subject id, or `null` when DOF focuses the orbit target. */
  get dofFocusTargetId(): string | null {
    return this.dofFocusId;
  }

  /** Pin the DOF focal plane to a body ("rack focus") without moving the camera —
   *  clicking a body in the lens panel racks focus onto it while the framing stays
   *  put. `null` restores focus to the orbit target. */
  setDofFocusTarget(id: string | null): void {
    this.dofFocusId = id;
  }

  /** Distance (render units) from the camera to whatever the DOF should focus on:
   *  a rack-focused body's live render position when one is pinned (in the system
   *  view), else the orbit target at the render origin. */
  private dofSubjectDistance(): number {
    if (this.viewMode === "system" && this.dofFocusId && BODY_BY_ID.has(this.dofFocusId)) {
      this.toRender(bodyPosition(this.dofFocusId, this.lastT), _dofPt);
      return this.camera.position.distanceTo(_dofPt);
    }
    return this.camera.position.distanceTo(this.controls.target);
  }

  /** Drive the Bokeh uniforms from the live subject distance. The focus plane sits
   *  on the DOF subject — the orbit target by default, or a rack-focused body — and
   *  is shifted by the user bias; the aperture is scaled by 1/focus so a given blur
   *  "amount" defocuses the background by the same *relative* depth at every scale
   *  (see DOF_APERTURE_K). Called each frame only while DOF is enabled. */
  private updateDof(): void {
    const camDist = Math.max(this.dofSubjectDistance(), 1e-6);
    const focus = Math.max(camDist * (1 + this.dofFocusBias), 1e-6);
    const u = this.bokeh.uniforms as {
      focus: { value: number };
      aperture: { value: number };
      maxblur: { value: number };
    };
    u.focus.value = focus;
    u.aperture.value = (this.dofAmount * DOF_APERTURE_K) / focus;
    u.maxblur.value = this.dofAmount * DOF_MAX_BLUR;
  }
}
