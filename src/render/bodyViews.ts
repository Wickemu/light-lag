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
import { BODIES, BODY_BY_ID, type BodyDef, type BodyKind } from "@lightlag/engine/constants";
import { bodyState, bodyStateRelative, bodyElements } from "@lightlag/engine/ephemeris";
import { orbitPath, period, type State } from "@lightlag/engine/math/kepler";
import { poleToEcliptic } from "@lightlag/engine/orbit";
import { type Vec3 } from "@lightlag/engine/math/vec3";
import { metersToUnits, SCENE_SCALE } from "./scale.ts";
import { type SceneManager } from "./SceneManager.ts";
import { type Visibility } from "./visibility.ts";
import { createBodyTextures, makeGlowTexture, makeCoronaTexture, type AtmoGlow, type BodyTextureSet } from "./bodyTextures.ts";

// Sampled in eccentric anomaly and phased to the body (see kepler.orbitPath), so
// the loop already passes dead through the marker; the segment budget only sets
// how smooth the arc reads between vertices when zoomed in.
const ORBIT_SEGMENTS = 384;

/** Local +Y is a sphere's texture pole; the node rotates it onto the spin axis. */
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Clamp to the unit interval (corona distance-fade, etc.). */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** A body's spin axis as a unit vector in the ecliptic/render frame. Uses the real
 *  IAU pole (poleToEcliptic) when the body carries one — so the globe, rings and
 *  atmosphere lie in the plane its equatorial moons orbit in — and otherwise falls
 *  back to the canonical obliquity tilt (azimuth-free, in the Y–Z plane). That
 *  fallback reproduces the historic `rotation.x = π/2 + obliquity` look exactly for
 *  every poleless body, and matches the engine's spinPole, so a landed pad still
 *  co-rotates with its globe. */
function eclipticSpinAxis(def: BodyDef): THREE.Vector3 {
  if (def.poleRaDeg !== undefined && def.poleDecDeg !== undefined) {
    const p = poleToEcliptic(def.poleRaDeg, def.poleDecDeg);
    return new THREE.Vector3(p.x, p.y, p.z);
  }
  const obl = (def.obliquityDeg ?? 0) * (Math.PI / 180);
  return new THREE.Vector3(0, -Math.sin(obl), Math.cos(obl));
}

/** Constant screen-size for the always-visible body marker, by class. Explicit
 *  per-kind so a newly added BodyKind can't silently inherit a wrong size. */
const MARKER_SCALE: Record<BodyKind, number> = {
  star: 0.05,
  planet: 0.022,
  dwarf: 0.016,
  asteroid: 0.012,
  moon: 0.013,
  comet: 0.011,
  satellite: 0.009, // man-made craft: the smallest marker
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
  satellite: [16, 12], // sub-pixel anyway — the marker carries it
};

/** Cheap hash-based 3D value noise, shared by the photosphere and chromosphere
 *  shaders to drive their live convective shimmer. Defined once as a GLSL snippet
 *  spliced into each patched material. */
const SUN_NOISE_GLSL = `
float sunHash(vec3 p){ p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float sunNoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(sunHash(i + vec3(0,0,0)), sunHash(i + vec3(1,0,0)), f.x),
                 mix(sunHash(i + vec3(0,1,0)), sunHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(sunHash(i + vec3(0,0,1)), sunHash(i + vec3(1,0,1)), f.x),
                 mix(sunHash(i + vec3(0,1,1)), sunHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;

/** The animated uniforms the Sun's materials share: an HDR gain and a wall-clock
 *  time the renderer advances each frame so the surface visibly convects. */
interface SunUniforms {
  uSunGain: { value: number };
  uTime: { value: number };
}

/**
 * The Sun's photosphere material. Starts from MeshBasicMaterial (unlit — the Sun
 * emits, it isn't lit) and patches the shader to add four real solar effects:
 *
 *  - **Live convection**: a slow-evolving 3D noise field sampled at the surface
 *    direction boils the granulation brightness over time, so the disk shimmers the
 *    way real granules churn instead of sitting as a frozen texture.
 *  - **Limb darkening**: the disk is brightest at centre and dims toward the edge
 *    because near the limb we see higher, cooler layers of the photosphere. The
 *    classic visible-band law is I(μ)/I(0) ≈ 0.3 + 0.93μ − 0.23μ² (μ = cos of the
 *    angle between the line of sight and the local normal); we use a close fit.
 *  - **Limb reddening**: those cooler edge layers are also redder, so the rim
 *    shifts warm, deepening to a faint red chromospheric edge right at the limb.
 *
 * An HDR gain lifts the disk well above 1.0 so it reads as a genuine light source
 * and blooms through the post chain. onBeforeCompile keeps the logarithmic depth
 * buffer and all other engine plumbing. Returns the shared uniforms so the render
 * loop can advance uTime.
 */
function makeSunMaterial(map: THREE.Texture): { material: THREE.MeshBasicMaterial; uniforms: SunUniforms } {
  const uniforms: SunUniforms = { uSunGain: { value: 3.5 }, uTime: { value: 0 } };
  const mat = new THREE.MeshBasicMaterial({ map });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunGain = uniforms.uSunGain;
    shader.uniforms.uTime = uniforms.uTime;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSunN;\nvarying vec3 vSunV;\nvarying vec3 vSunP;")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\n  vSunN = normalize(normalMatrix * normal);\n  vSunV = -mvPosition.xyz;\n  vSunP = normalize(position);",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>\nuniform float uSunGain;\nuniform float uTime;\nvarying vec3 vSunN;\nvarying vec3 vSunV;\nvarying vec3 vSunP;${SUN_NOISE_GLSL}`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        // Live convection: a slow field boils the granulation, a finer one flickers it.
        float boil = sunNoise(vSunP * 7.0 + vec3(0.0, 0.0, uTime * 0.05));
        float fine = sunNoise(vSunP * 19.0 - vec3(uTime * 0.08, 0.0, 0.0));
        diffuseColor.rgb *= 0.84 + 0.22 * boil + 0.10 * fine;
        // Limb darkening + reddening, deepening to a red chromospheric edge.
        float mu = clamp(dot(normalize(vSunN), normalize(vSunV)), 0.0, 1.0);
        float limb = 0.34 + 0.95 * mu - 0.28 * mu * mu;
        diffuseColor.rgb *= clamp(limb, 0.0, 1.2);
        float edge = 1.0 - mu;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.16, 0.86, 0.60), edge * 0.6);
        diffuseColor.rgb += vec3(0.42, 0.11, 0.03) * pow(edge, 4.0);
        diffuseColor.rgb *= uSunGain;`,
      );
  };
  return { material: mat, uniforms };
}

/**
 * The Sun's chromosphere: a thin additive shell just above the photosphere that
 * lights only at the limb (a Fresnel `(1 − N·V)^p` rim), glowing the deep red-orange
 * of Hα emission. A noise term textures the rim into flickering spicules — the
 * jets of plasma that fringe the real solar edge. HDR-tinted so it blooms. Shares
 * the photosphere's uTime so the two animate on one clock.
 */
function makeChromosphereMaterial(uTime: { value: number }): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vChN;\nvarying vec3 vChW;\nvarying vec3 vChP;")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\n  vChN = normalize(mat3(modelMatrix) * normal);\n  vChW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vChP = normalize(position);",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>\nuniform float uTime;\nvarying vec3 vChN;\nvarying vec3 vChW;\nvarying vec3 vChP;${SUN_NOISE_GLSL}`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        vec3 chN = normalize(vChN);
        vec3 chV = normalize(cameraPosition - vChW);
        float rim = pow(1.0 - clamp(dot(chN, chV), 0.0, 1.0), 2.4);
        float spic = 0.55 + 0.7 * sunNoise(vChP * 26.0 + vec3(uTime * 0.15, 0.0, uTime * 0.05));
        diffuseColor = vec4(vec3(1.7, 0.52, 0.24) * spic, rim);`,
      );
  };
  return mat;
}

/**
 * A body's atmospheric limb glow: a thin shell just above the surface that scatters
 * sunlight at the limb. The brightness is the product of two real effects —
 *
 *  - a **Fresnel/limb term** `(1 − N·V)^power`, bright where we look through the
 *    most air (the grazing edge of the disk), faint looking straight down; and
 *  - a **day-side term** `smoothstep(N·sunDir)`, so the arc glows on the sunlit
 *    hemisphere and fades through the terminator to nothing on the night side —
 *    exactly how Earth's blue arc only hangs over the daylit limb.
 *
 * Built as a patched MeshBasicMaterial (not a raw ShaderMaterial) so it inherits
 * the engine's colour-space, tone-mapping AND log-depth handling automatically —
 * which means it renders correctly both through the HDR post chain *and* on the
 * cheaper direct-to-canvas path used when bloom is switched off. `uColor` folds
 * in intensity and may exceed 1.0 so the brightest arc blooms. The caller passes
 * in the sun-direction vector so it can aim it at the true Sun each frame.
 */
function makeAtmosphereMaterial(glow: AtmoGlow, sunDir: THREE.Vector3): THREE.MeshBasicMaterial {
  const c = new THREE.Color(glow.color);
  const mat = new THREE.MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uColor = { value: new THREE.Vector3(c.r * glow.intensity, c.g * glow.intensity, c.b * glow.intensity) };
    shader.uniforms.uSunDir = { value: sunDir };
    shader.uniforms.uPower = { value: glow.power };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vAtmoN;\nvarying vec3 vAtmoW;")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\n  vAtmoN = normalize(mat3(modelMatrix) * normal);\n  vAtmoW = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform vec3 uColor;\nuniform vec3 uSunDir;\nuniform float uPower;\nvarying vec3 vAtmoN;\nvarying vec3 vAtmoW;",
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        vec3 atmoN = normalize(vAtmoN);
        vec3 atmoV = normalize(cameraPosition - vAtmoW);
        float rim = pow(1.0 - clamp(dot(atmoN, atmoV), 0.0, 1.0), uPower);
        float sun = smoothstep(-0.25, 0.35, dot(atmoN, uSunDir));
        diffuseColor = vec4(uColor, rim * sun);`,
      );
  };
  return mat;
}

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

/** One additive corona sprite and how the render loop animates it: a slow screen
 *  rotation (streamers turning) and a gentle breathing scale, so the layered corona
 *  never sits still, plus its base opacity (the distance fade multiplies it). */
interface CoronaLayer {
  sprite: THREE.Sprite;
  baseScale: number;
  baseOpacity: number;
  spin: number;    // screen-space rotation rate (rad/s)
  breathe: number; // fractional scale-oscillation amplitude
  phase: number;
}

/** The Sun's animation state: the photosphere/chromosphere uniforms (uTime), the
 *  corona layers, and the body radius (render units) the distance fade keys off.
 *  Advanced together each frame by a wall clock. */
interface SunAnim {
  uniforms: SunUniforms;
  corona: CoronaLayer[];
  radius: number;
}

interface BodyVisual {
  def: BodyDef;
  marker: THREE.Sprite;
  /** Oriented container at the body's position; holds sphere, clouds, ring. */
  node: THREE.Object3D;
  sphere: THREE.Mesh;
  clouds?: THREE.Mesh;
  /** Set only for the Sun: photosphere/chromosphere uniforms + animated corona. */
  sunAnim?: SunAnim;
  /** Atmospheric limb-glow shell sun-direction uniform value: set per frame so the
   *  glowing arc tracks the terminator. */
  atmoSunDir?: THREE.Vector3;
  /** Ring-material sun-direction uniform value (Saturn): set per frame so the
   *  planet's shadow band falls across the rings from the true Sun. */
  ringSunDir?: THREE.Vector3;
  /** Angular speed of the texture spin (rad/s of sim time); 0 if non-rotating.
   *  Ignored when `lock` is set — a synchronous body is oriented by its partner. */
  spinRate: number;
  cloudSpinRate: number;
  /** Set for a tidally locked body (synchronous moon, or a binary primary): the
   *  satellite whose orbit sets the plane, and which way to face. */
  lock?: { satId: string; sign: number };
  orbit?: THREE.LineLoop;
  orbitArray?: Float32Array;
  /** Set on both members of a barycentric binary (Earth–Moon, Pluto–Charon). */
  binary?: BinaryInfo;
  /** The primary's small loop about an EXTERNAL barycentre (Pluto only). */
  baryOrbit?: THREE.LineLoop;
  baryOrbitArray?: Float32Array;
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

    // Oriented node: the body's local +Y (its texture pole) is aimed along the real
    // spin axis in the ecliptic/render frame, so the globe — and the rings and
    // atmosphere riding in this node — share the plane the body's equatorial moons
    // orbit in. (Tilting by obliquity about a fixed axis, as before, kept the tilt
    // magnitude but lost the pole's azimuth, which left Saturn's rings crossed
    // against its own moons.) A tidally locked body's node is re-aimed each frame in
    // update(), so this only sets the at-rest orientation of the free-spinning ones.
    const node = new THREE.Object3D();
    node.quaternion.setFromUnitVectors(Y_AXIS, eclipticSpinAxis(def));
    this.sm.scene.add(node);

    // To-scale sphere (tiny at system zoom, resolves up close).
    const radius = metersToUnits(def.radius);
    const [segW, segH] = SPHERE_SEGMENTS[def.kind];
    const sphereGeo = new THREE.SphereGeometry(radius, segW, segH);
    let sphereMat: THREE.Material;
    let sunUniforms: SunUniforms | undefined;
    if (def.kind === "star") {
      const sun = makeSunMaterial(tex.surface);
      sphereMat = sun.material;
      sunUniforms = sun.uniforms;
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
      // Per-pixel roughness (Earth's glossy oceans / matte land): the map multiplies
      // the scalar roughness, which the caller sets to 1 so the map carries it whole.
      if (tex.roughnessMap) params.roughnessMap = tex.roughnessMap;
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

    // Atmospheric limb-scattering glow (Earth, Venus, Mars, Titan, Pluto).
    let atmoSunDir: THREE.Vector3 | undefined;
    if (tex.atmoGlow) {
      atmoSunDir = new THREE.Vector3(1, 0, 0);
      const atmoMat = makeAtmosphereMaterial(tex.atmoGlow, atmoSunDir);
      const shell = new THREE.Mesh(new THREE.SphereGeometry(radius * tex.atmoGlow.scale, segW, segH), atmoMat);
      node.add(shell);
    }

    // Ring system (Saturn): a flat annulus in the equatorial plane. Ring radii are
    // conventionally quoted as multiples of the EQUATORIAL radius (the ring.inner/
    // .outer fractions are the C-ring inner and A-ring outer edges in those units),
    // so scale them by the equatorial radius — not the smaller mean `radius`, which
    // shrank the disc ~3.5% and left Pan (which orbits inside the A ring) outside it.
    const ringRadius = metersToUnits(def.equatorialRadius ?? def.radius);
    const ringSunDir = tex.ring ? this.addRing(node, ringRadius, tex) : undefined;

    // The Sun is a light source, not a lit ball. A thin chromosphere shell fringes
    // the disk in Hα red, then a layered corona wraps it: a tight hot core glow over
    // two wide, streamer-textured halos. The halos carry HDR colour (components > 1)
    // so they bloom, and are animated in update() — breathing and slowly counter-
    // rotating for a living corona. Crucially the whole corona FADES with camera
    // distance (see update): from afar the Sun is a bloomed star wrapped in its
    // corona; up close the corona pulls back so the granulation, sunspots and red
    // chromospheric limb are the show — instead of the wide additive sprites
    // engulfing the camera and washing the frame white.
    let sunAnim: SunAnim | undefined;
    if (def.kind === "star" && sunUniforms) {
      const chromo = new THREE.Mesh(
        new THREE.SphereGeometry(radius * 1.02, segW, segH),
        makeChromosphereMaterial(sunUniforms.uTime),
      );
      node.add(chromo);

      // Seed the streamer texture from the id so a future second star differs.
      let seed = 0x9e3779b9;
      for (let i = 0; i < def.id.length; i++) seed = (Math.imul(seed ^ def.id.charCodeAt(i), 0x01000193)) >>> 0;
      const coronaTex = makeCoronaTexture(seed, this.sm.renderer.capabilities.getMaxAnisotropy());
      const corona: CoronaLayer[] = [];

      const inner = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glow,
        color: new THREE.Color().setRGB(2.5, 2.0, 1.45), // HDR warm-white core
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      inner.scale.setScalar(radius * 3.2);
      node.add(inner);
      corona.push({ sprite: inner, baseScale: radius * 3.2, baseOpacity: 1, spin: 0, breathe: 0.02, phase: 1.7 });

      const mid = new THREE.Sprite(new THREE.SpriteMaterial({
        map: coronaTex,
        color: new THREE.Color().setRGB(1.8, 1.3, 0.8),
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      mid.scale.setScalar(radius * 8);
      node.add(mid);
      corona.push({ sprite: mid, baseScale: radius * 8, baseOpacity: 1, spin: 0.012, breathe: 0.05, phase: 0 });

      const outer = new THREE.Sprite(new THREE.SpriteMaterial({
        map: coronaTex,
        color: new THREE.Color().setRGB(1.05, 0.66, 0.36), // cooler extended corona
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      outer.scale.setScalar(radius * 18);
      (outer.material as THREE.SpriteMaterial).rotation = Math.PI * 0.4; // offset so the spokes don't overlap
      node.add(outer);
      corona.push({ sprite: outer, baseScale: radius * 18, baseOpacity: 0.9, spin: -0.007, breathe: 0.035, phase: Math.PI * 0.4 });

      sunAnim = { uniforms: sunUniforms, corona, radius };
    }

    const baseColor = color.clone();
    const focusColor = color.clone().lerp(new THREE.Color(0xffffff), 0.5);
    // The Sun carries no rotationPeriod in the body data; give it the ~25.38-day
    // Carrington sidereal rotation so its granulation and spots visibly turn under
    // time-warp (the noise field is locked to the surface, so it co-rotates).
    const spinRate = def.rotationPeriod ? (2 * Math.PI) / def.rotationPeriod
      : def.kind === "star" ? (2 * Math.PI) / (25.38 * 86400) : 0;
    const visual: BodyVisual = {
      def, marker, node, sphere, clouds, atmoSunDir, ringSunDir, sunAnim,
      spinRate,
      cloudSpinRate: spinRate * 0.92, // a touch of cloud drift relative to the surface
      lock: tidalLock(def) ?? undefined,
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

    // Barycentric binary: tag both members, and for a system whose barycentre sits
    // OUTSIDE the primary (Pluto–Charon) give the primary a second small loop about
    // that external point. The satellite's existing loop is re-homed onto the
    // barycentre in update(); the primary keeps its heliocentric loop (the
    // barycentre's smooth path) and gains this wobble loop. Earth–Moon's barycentre
    // is inside Earth, so it is not flagged external and renders as a plain moon.
    const bin = binaryInfo(def);
    if (bin) visual.binary = bin;
    if (bin && bin.external && bin.primary.id === def.id) {
      const arr = new Float32Array((ORBIT_SEGMENTS + 1) * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
      const mat = new THREE.LineBasicMaterial({
        color: color.clone().multiplyScalar(0.6),
        transparent: true,
        opacity: 0.5,
      });
      const baryOrbit = new THREE.LineLoop(geo, mat);
      baryOrbit.frustumCulled = false;
      this.sm.scene.add(baryOrbit);
      visual.baryOrbit = baryOrbit;
      visual.baryOrbitArray = arr;
    }

    this.visuals.push(visual);
  }

  /** Build the ring annulus and remap its UVs so the radial texture strip runs
   *  inner→outer (RingGeometry's default UVs are a bounding-box square, not radial).
   *  The material is patched to cast the planet's shadow across the rings: a
   *  fragment is darkened when it sits on the anti-sun side of the globe and
   *  within the globe's radius of the sun-line — the cylindrical shadow that
   *  paints the famous dark band over Saturn's rings. Returns the sun-direction
   *  uniform value so the caller can aim it at the true Sun every frame.
   *  `eqRadius` is the planet's EQUATORIAL radius (render units) — ring radii are
   *  quoted against it by convention, and it also sets the shadow band's width. */
  private addRing(node: THREE.Object3D, eqRadius: number, tex: BodyTextureSet): THREE.Vector3 {
    const ring = tex.ring!;
    const inner = eqRadius * ring.inner;
    const outer = eqRadius * ring.outer;
    const geo = new THREE.RingGeometry(inner, outer, 128, 1);
    const pos = geo.getAttribute("position");
    const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i));
      uv.setXY(i, (r - inner) / (outer - inner), 0.5);
    }
    uv.needsUpdate = true;
    const sunDir = new THREE.Vector3(1, 0, 0);
    const mat = new THREE.MeshBasicMaterial({
      map: ring.texture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSunDir = { value: sunDir };
      shader.uniforms.uPlanetR = { value: eqRadius };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vRingW;\nvarying vec3 vRingC;")
        .replace(
          "#include <project_vertex>",
          "#include <project_vertex>\n  vRingW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vRingC = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nuniform vec3 uSunDir;\nuniform float uPlanetR;\nvarying vec3 vRingW;\nvarying vec3 vRingC;",
        )
        .replace(
          "#include <map_fragment>",
          `#include <map_fragment>
          vec3 dRing = vRingW - vRingC;
          float sProj = dot(dRing, uSunDir);
          if (sProj < 0.0) {
            float perp = length(dRing - sProj * uSunDir);
            float lit = smoothstep(uPlanetR * 0.97, uPlanetR * 1.12, perp);
            diffuseColor.rgb *= mix(0.16, 1.0, lit);
          }`,
        );
    };
    const mesh = new THREE.Mesh(geo, mat);
    // RingGeometry lies in the XY plane; rotate into the equatorial (local XZ) plane.
    mesh.rotation.x = -Math.PI / 2;
    node.add(mesh);
    return sunDir;
  }

  /** Park every body's marker, sphere and orbit (interstellar view is active). */
  private hideAll(): void {
    for (const vis of this.visuals) {
      vis.marker.visible = false;
      vis.node.visible = false;
      if (vis.orbit) vis.orbit.visible = false;
      if (vis.baryOrbit) vis.baryOrbit.visible = false;
    }
  }

  /** Reposition everything for sim time t. Origin must already be updated. */
  update(t: number): void {
    // The orrery only exists in the in-system view; the interstellar map draws
    // its own (Sol collapses to a point there).
    if (this.sm.viewMode !== "system") {
      this.hideAll();
      return;
    }
    const tmp = new THREE.Vector3();
    const orbitsOn = this.vis.layer("orbits");
    // The always-visible marker is the soft "glow" halo that keeps a body legible
    // from a distance; turning the Glow layer off leaves only the raw sphere. A
    // shown body still runs the position update below, which labels and
    // click-picking read — so only the drawn sprite goes away, the body stays
    // selectable. (Glow gates just the sprite; a hidden body is skipped entirely,
    // exactly as before.)
    const glowOn = this.vis.layer("glow");
    for (const vis of this.visuals) {
      const { def } = vis;

      // Honour show/hide: a hidden body drops its marker, sphere and orbit.
      const shown = this.vis.bodyVisible(def.id);
      vis.marker.visible = shown && glowOn;
      vis.node.visible = shown;
      if (vis.orbit) vis.orbit.visible = shown && orbitsOn;
      if (vis.baryOrbit) vis.baryOrbit.visible = shown && orbitsOn;
      if (!shown) continue;

      const state = bodyState(def, t);
      this.sm.toRender(state.r, tmp);
      vis.marker.position.copy(tmp);
      vis.node.position.copy(tmp);

      // Direction from this body to the true Sun (render space). Drives both the
      // atmosphere's day-side arc and Saturn's ring-shadow band, so each tracks
      // the terminator as the body and Sun move.
      if (vis.atmoSunDir || vis.ringSunDir) {
        const sun = this.sm.sunRenderPosition;
        const sx = sun.x - tmp.x, sy = sun.y - tmp.y, sz = sun.z - tmp.z;
        const inv = 1 / (Math.hypot(sx, sy, sz) || 1);
        if (vis.atmoSunDir) vis.atmoSunDir.set(sx * inv, sy * inv, sz * inv);
        if (vis.ringSunDir) vis.ringSunDir.set(sx * inv, sy * inv, sz * inv);
      }

      // Axial rotation. A tidally locked body (every synchronous moon, plus Pluto
      // and Charon) is oriented by its partner: the node's pole sits on the mutual
      // orbit normal and a fixed meridian faces the partner, so the pair turn in
      // lockstep and keep face — Charon hangs motionless over one Pluto hemisphere.
      // Everything else free-spins about its tilted pole at the real sidereal rate
      // (retrograde from a negative rate).
      if (vis.lock) {
        tidalLockOrientation(bodyStateRelative(BODY_BY_ID.get(vis.lock.satId)!, t), vis.lock.sign, vis.node.quaternion);
      } else if (vis.spinRate !== 0) {
        vis.sphere.rotation.y = t * vis.spinRate;
        if (vis.clouds) vis.clouds.rotation.y = t * vis.cloudSpinRate;
      }

      // The Sun lives on a wall clock (not sim time), so its surface convects and
      // its corona breathes/turns smoothly regardless of time-warp or pause. The
      // corona also fades with camera distance: engulfing additive halos would wash
      // the frame white up close, so within a few solar radii they retreat and the
      // textured photosphere + red chromospheric limb take over; from afar they
      // return in full and bloom the Sun into a proper star.
      if (vis.sunAnim) {
        const wall = (typeof performance !== "undefined" ? performance.now() : 0) * 0.001;
        vis.sunAnim.uniforms.uTime.value = wall;
        const R = vis.sunAnim.radius;
        const camDist = this.sm.camera.position.distanceTo(tmp);
        // 0 within ~4R (surface inspection) → 1 beyond ~26R (full corona).
        const fade = clamp01((camDist - 4 * R) / (22 * R));
        // Exposure like a real camera: up close, drop the HDR gain to just under the
        // bloom threshold so the granulation, sunspots and red limb read with contrast
        // (as in real solar imagery) instead of the disk blooming into flat white; from
        // afar restore the high gain that blooms it into a star.
        vis.sunAnim.uniforms.uSunGain.value = 1.0 + (3.6 - 1.0) * fade;
        const breath = Math.sin(wall * 0.3);
        for (const layer of vis.sunAnim.corona) {
          const m = layer.sprite.material as THREE.SpriteMaterial;
          m.rotation = layer.phase + wall * layer.spin;
          m.opacity = layer.baseOpacity * fade;
          layer.sprite.visible = fade > 0.001;
          layer.sprite.scale.setScalar(layer.baseScale * (1 + layer.breathe * breath));
        }
      }

      // Emphasise the focused body: a larger, brighter marker draws the eye.
      const focused = def.id === this.sm.focusId;
      vis.marker.scale.setScalar(MARKER_SCALE[def.kind] * (focused ? FOCUS_MARKER_GAIN : 1));
      (vis.marker.material as THREE.SpriteMaterial).color.copy(focused ? vis.focusColor : vis.baseColor);

      const bin = vis.binary;
      if (orbitsOn && vis.orbit && vis.orbitArray && def.parent) {
        // The loop sits at the render origin; each vertex is folded through the
        // floating origin in f64 (fillOrbitLoopWorld) rather than the cheaper
        // "loop .position = parent, vertices = parent-relative" trick — see that
        // helper for why the trick makes the line jitter.
        vis.orbit.position.set(0, 0, 0);
        const el = bodyElements(def, t);
        if (el) {
          const pts = orbitPath(el, ORBIT_SEGMENTS);
          if (bin && bin.external && def.id === bin.sat.id) {
            // Binary satellite (Charon): its orbit is about the system BARYCENTRE,
            // not the wobbling primary's centre. Re-home the loop there and scale
            // the parent-centre ellipse by (1−f) so it passes through the satellite.
            fillOrbitLoopWorld(vis.orbitArray, pts, systemBary(bin, t), this.sm.origin, 1 - bin.f);
          } else if (def.orbitsBarycenter) {
            // Small moon of a binary (Pluto's Styx/Nix/Kerberos/Hydra): its loop is
            // the conic about the system barycentre, so anchor it there — the same
            // point Pluto and Charon circle — not on Pluto's offset centre.
            const pbin = binaryInfo(BODY_BY_ID.get(def.parent)!);
            const anchor = pbin ? systemBary(pbin, t) : bodyState(BODY_BY_ID.get(def.parent)!, t).r;
            fillOrbitLoopWorld(vis.orbitArray, pts, anchor, this.sm.origin);
          } else {
            const parentState = bodyState(BODY_BY_ID.get(def.parent)!, t);
            fillOrbitLoopWorld(vis.orbitArray, pts, parentState.r, this.sm.origin);
          }
          (vis.orbit.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
        }
      }

      // Binary primary (Pluto): the small loop it traces about the EXTERNAL
      // barycentre — Charon's ellipse scaled by −f (opposite side, mass-ratio
      // smaller). Drawn alongside the heliocentric loop so the marker's offset from
      // that line reads as Pluto genuinely orbiting a point outside itself.
      if (orbitsOn && vis.baryOrbit && vis.baryOrbitArray && bin && def.id === bin.primary.id) {
        vis.baryOrbit.position.set(0, 0, 0);
        const satEl = bodyElements(bin.sat, t);
        if (satEl) {
          const pts = orbitPath(satEl, ORBIT_SEGMENTS);
          fillOrbitLoopWorld(vis.baryOrbitArray, pts, systemBary(bin, t), this.sm.origin, -bin.f);
          (vis.baryOrbit.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
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

/**
 * Write an orbit loop's float32 vertex buffer as ABSOLUTE render-space points:
 * each ellipse sample (`pts`, parent-relative metres) is shifted by the parent's
 * world position and the floating origin and divided by SCENE_SCALE — the whole
 * subtraction done in f64, exactly as SceneManager.toRender does for the marker,
 * before the result narrows to float32. The loop's own `.position` therefore stays
 * at the origin.
 *
 * Why not the cheaper idiom (loop `.position` = parent's render position, vertices
 * = parent-relative offsets / SCENE_SCALE)? That leaves the float32 cancellation to
 * the GPU: when the camera sits on a body far from its parent — Pluto at ~39 AU is
 * ~5900 render units from the Sun, likewise the asteroid belt and a comet near
 * aphelion — the loop's object offset and its local vertices are each thousands of
 * units, and the fused modelView matrix (uploaded as float32) must add them to land
 * the near side of the ellipse back at the origin. Float32's ~7 significant figures
 * leave a hundreds-of-km residual there, and since the body and camera move every
 * frame that residual changes every frame: the orbit line visibly wobbles across
 * the marker. The error grows with distance-from-parent and shrinks against a large
 * body's disk — which is why Pluto is glaring, Ceres/Vesta/Halley clear, Jupiter
 * faint, and the inner planets clean. Folding the origin in here keeps the on-body
 * vertex coincident with the marker to f64 precision; only the far side (off-camera,
 * sub-pixel) is left at float32. Same per-vertex transform fillPolylineWorld uses.
 */
export function fillOrbitLoopWorld(
  arr: Float32Array,
  pts: readonly Vec3[],
  anchor: Vec3,
  origin: Vec3,
  scale = 1,
): void {
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k]!;
    arr[k * 3] = (anchor.x + scale * p.x - origin.x) / SCENE_SCALE;
    arr[k * 3 + 1] = (anchor.y + scale * p.y - origin.y) / SCENE_SCALE;
    arr[k * 3 + 2] = (anchor.z + scale * p.z - origin.z) / SCENE_SCALE;
  }
}

/** Primary/satellite roles of a barycentric binary, with the satellite mass
 *  fraction and whether the barycentre clears the primary's surface. */
interface BinaryInfo {
  primary: BodyDef;
  sat: BodyDef;
  /** f = μ_sat/(μ_primary+μ_sat): the primary orbits the barycentre at f·a, the
   *  satellite at (1−f)·a, 180° apart (a = their centre-to-centre separation). */
  f: number;
  /** True when the barycentre lies above the primary's surface — a visible binary
   *  (Pluto–Charon). Earth–Moon's barycentre is inside Earth, so it stays false. */
  external: boolean;
}

/** Classify `body` as the primary or satellite of a barycentric binary (Earth–Moon,
 *  Pluto–Charon), or null for an ordinary body. Drives the barycentre-relative
 *  orbit loops in update(). */
function binaryInfo(body: BodyDef): BinaryInfo | null {
  let primary: BodyDef | undefined;
  let sat: BodyDef | undefined;
  if (body.barycenterChild) {
    primary = body;
    sat = BODY_BY_ID.get(body.barycenterChild);
  } else if (body.parent) {
    const p = BODY_BY_ID.get(body.parent);
    if (p?.barycenterChild === body.id) { primary = p; sat = body; }
  }
  if (!primary || !sat || !sat.moon) return null;
  const f = sat.mu / (primary.mu + sat.mu);
  return { primary, sat, f, external: f * sat.moon.a > primary.radius };
}

/** World position of a binary's barycentre at time t: the primary's true centre
 *  plus f·(satellite relative to the primary's centre). */
function systemBary(bin: BinaryInfo, t: number): Vec3 {
  const p = bodyState(bin.primary, t).r;
  const s = bodyStateRelative(bin.sat, t).r; // satellite relative to the primary's centre
  return { x: p.x + bin.f * s.x, y: p.y + bin.f * s.y, z: p.z + bin.f * s.z };
}

/** Which co-orbiting body a synchronous rotator keeps its face toward. A tidally
 *  locked body's sidereal day equals the mutual orbital period, so we detect the
 *  lock by matching the two. `satId` is the satellite whose relative orbit defines
 *  the plane; `sign` is +1 when this body is the primary (Pluto faces Charon) and
 *  −1 when it is the satellite (a moon faces its parent). Returns null for a
 *  free-spinning body (Earth, the Sun, the planets, asteroids, comets). */
function tidalLock(body: BodyDef): { satId: string; sign: number } | null {
  if (!body.rotationPeriod) return null;
  const isSync = (sat: BodyDef | undefined, primaryMu: number): boolean => {
    if (!sat?.moon) return false;
    const T = period(sat.moon.a, primaryMu + sat.mu); // mutual orbital period
    return Math.abs(Math.abs(body.rotationPeriod!) - T) < 0.02 * T; // within 2 %
  };
  // Binary primary locked to its co-orbiting satellite (Pluto ↔ Charon).
  if (body.barycenterChild && isSync(BODY_BY_ID.get(body.barycenterChild), body.mu)) {
    return { satId: body.barycenterChild, sign: 1 };
  }
  // Synchronous moon locked to its parent (Moon, the Galilean & Saturnian moons, …).
  if (body.moon && body.parent) {
    const parent = BODY_BY_ID.get(body.parent);
    if (parent && isSync(body, parent.mu)) return { satId: body.id, sign: -1 };
  }
  return null;
}

// Allocation-free scratch for the per-frame tidal-lock orientation.
const _tlR = new THREE.Vector3(), _tlV = new THREE.Vector3(), _tlN = new THREE.Vector3();
const _tlX = new THREE.Vector3(), _tlZ = new THREE.Vector3(), _tlM = new THREE.Matrix4();

/** Orientation of a tidally locked body: pole (local +Y) along the mutual orbit
 *  normal r×v, prime meridian (local +X) facing the partner. `rel` is the
 *  satellite's state relative to the primary; `sign` selects which way to face
 *  (+1 primary→satellite, −1 satellite→primary). Because r×v is conserved in
 *  two-body motion, the same surface point faces the partner at every t — the
 *  defining property of a 1:1 spin–orbit lock. Writes and returns `out`. */
export function tidalLockOrientation(rel: State, sign: number, out: THREE.Quaternion): THREE.Quaternion {
  _tlR.set(rel.r.x, rel.r.y, rel.r.z);
  _tlV.set(rel.v.x, rel.v.y, rel.v.z);
  _tlN.crossVectors(_tlR, _tlV).normalize();              // orbit normal → spin axis
  _tlX.copy(_tlR).multiplyScalar(sign);                   // toward the partner
  _tlX.addScaledVector(_tlN, -_tlX.dot(_tlN)).normalize(); // drop any out-of-plane component
  _tlZ.crossVectors(_tlX, _tlN);                          // right-handed third axis
  _tlM.makeBasis(_tlX, _tlN, _tlZ);
  return out.setFromRotationMatrix(_tlM);
}
