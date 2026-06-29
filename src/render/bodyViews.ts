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
import { bodyState, bodyStateRelative, bodyElements } from "../core/ephemeris.ts";
import { orbitPath } from "../core/math/kepler.ts";
import { type Vec3 } from "../core/math/vec3.ts";
import { metersToUnits, SCENE_SCALE } from "./scale.ts";
import { type SceneManager } from "./SceneManager.ts";
import { type Visibility } from "./visibility.ts";
import { createBodyTextures, makeGlowTexture, type AtmoGlow, type BodyTextureSet } from "./bodyTextures.ts";

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

/**
 * The Sun's photosphere material. Starts from MeshBasicMaterial (unlit — the Sun
 * emits, it isn't lit) and patches the shader to add two real solar effects:
 *
 *  - **Limb darkening**: the disk is brightest at centre and dims toward the edge
 *    because near the limb we see higher, cooler layers of the photosphere. The
 *    classic visible-band law is I(μ)/I(0) ≈ 0.3 + 0.93μ − 0.23μ² (μ = cos of the
 *    angle between the line of sight and the local normal); we use a close fit.
 *  - **Limb reddening**: those cooler edge layers are also redder, so the rim
 *    shifts warm.
 *
 * Finally an HDR gain lifts the disk well above 1.0 so it reads as a genuine
 * light source and blooms through the post chain. onBeforeCompile means the
 * material keeps the logarithmic depth buffer and all other engine plumbing.
 */
function makeSunMaterial(map: THREE.Texture): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ map });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSunGain = { value: 3.6 };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSunN;\nvarying vec3 vSunV;")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\n  vSunN = normalize(normalMatrix * normal);\n  vSunV = -mvPosition.xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float uSunGain;\nvarying vec3 vSunN;\nvarying vec3 vSunV;",
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        float mu = clamp(dot(normalize(vSunN), normalize(vSunV)), 0.0, 1.0);
        float limb = 0.32 + 0.93 * mu - 0.25 * mu * mu;
        diffuseColor.rgb *= clamp(limb, 0.0, 1.2);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.12, 0.92, 0.70), (1.0 - mu) * 0.6);
        diffuseColor.rgb *= uSunGain;`,
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

interface BodyVisual {
  def: BodyDef;
  marker: THREE.Sprite;
  /** Oriented container at the body's position; holds sphere, clouds, ring. */
  node: THREE.Object3D;
  sphere: THREE.Mesh;
  clouds?: THREE.Mesh;
  /** Atmospheric limb-glow shell sun-direction uniform value: set per frame so the
   *  glowing arc tracks the terminator. */
  atmoSunDir?: THREE.Vector3;
  /** Ring-material sun-direction uniform value (Saturn): set per frame so the
   *  planet's shadow band falls across the rings from the true Sun. */
  ringSunDir?: THREE.Vector3;
  /** Angular speed of the texture spin (rad/s of sim time); 0 if non-rotating. */
  spinRate: number;
  cloudSpinRate: number;
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
      sphereMat = makeSunMaterial(tex.surface);
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

    // Atmospheric limb-scattering glow (Earth, Venus, Mars, Titan, Pluto).
    let atmoSunDir: THREE.Vector3 | undefined;
    if (tex.atmoGlow) {
      atmoSunDir = new THREE.Vector3(1, 0, 0);
      const atmoMat = makeAtmosphereMaterial(tex.atmoGlow, atmoSunDir);
      const shell = new THREE.Mesh(new THREE.SphereGeometry(radius * tex.atmoGlow.scale, segW, segH), atmoMat);
      node.add(shell);
    }

    // Ring system (Saturn): a flat annulus in the equatorial plane.
    const ringSunDir = tex.ring ? this.addRing(node, radius, tex) : undefined;

    // The Sun is a light source, not a lit ball — wrap the limb-darkened disk in
    // a layered corona: a tight, hot inner glow over a wide, faint outer halo.
    // Both size-attenuate (they grow as you approach) and carry HDR colour
    // (components > 1) so they bloom convincingly through the post chain.
    if (def.kind === "star") {
      const inner = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glow,
        color: new THREE.Color().setRGB(2.2, 1.85, 1.35), // HDR warm-white core
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      inner.scale.setScalar(radius * 6);
      node.add(inner);

      const outer = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glow,
        color: new THREE.Color().setRGB(1.0, 0.72, 0.42), // cooler extended corona
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      outer.scale.setScalar(radius * 18);
      node.add(outer);
    }

    const baseColor = color.clone();
    const focusColor = color.clone().lerp(new THREE.Color(0xffffff), 0.5);
    const spinRate = def.rotationPeriod ? (2 * Math.PI) / def.rotationPeriod : 0;
    const visual: BodyVisual = {
      def, marker, node, sphere, clouds, atmoSunDir, ringSunDir,
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
   *  uniform value so the caller can aim it at the true Sun every frame. */
  private addRing(node: THREE.Object3D, radius: number, tex: BodyTextureSet): THREE.Vector3 {
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
    const sunDir = new THREE.Vector3(1, 0, 0);
    const mat = new THREE.MeshBasicMaterial({
      map: ring.texture,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uSunDir = { value: sunDir };
      shader.uniforms.uPlanetR = { value: radius };
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
    for (const vis of this.visuals) {
      const { def } = vis;

      // Honour show/hide: a hidden body drops its marker, sphere and orbit.
      const shown = this.vis.bodyVisible(def.id, def.kind);
      vis.marker.visible = shown;
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

      // Axial rotation at the real sidereal rate (retrograde from a negative rate).
      if (vis.spinRate !== 0) {
        vis.sphere.rotation.y = t * vis.spinRate;
        if (vis.clouds) vis.clouds.rotation.y = t * vis.cloudSpinRate;
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
