/**
 * Orbit-line precision regression — the "spazzy orbit line" fix.
 *
 * A body's orbit loop must pass dead through its marker and hold still there as
 * the clock runs. The danger is float32: if the loop is drawn with its `.position`
 * at the parent's render location and parent-relative vertices (the old idiom),
 * the GPU has to add two thousands-of-units float32 quantities to land the near
 * side of the ellipse back on the body — and the cancellation residual (hundreds
 * of km for a distant body) changes every frame, so the line wobbles. Pluto, the
 * asteroid belt and a comet near aphelion show it; the inner planets do not.
 *
 * fillOrbitLoopWorld folds the floating origin into every vertex in f64 before it
 * narrows to float32, killing the cancellation. These tests model what the GPU
 * actually does (fuse modelView in f64 → upload as a float32 matrix → multiply the
 * float32 vertex) and assert the new path lands on the marker and stays put, while
 * the old idiom drifts and jitters.
 */

import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { fillOrbitLoopWorld } from "./bodyViews.ts";
import { SCENE_SCALE } from "./scale.ts";
import { BODY_BY_ID } from "../core/constants.ts";
import { bodyState, bodyStateRelative, bodyElements } from "../core/ephemeris.ts";
import { orbitPath } from "../core/math/kepler.ts";
import { type Vec3 } from "../core/math/vec3.ts";

const f = Math.fround;
const KM = (units: number) => units * SCENE_SCALE / 1000;

/** Round all 16 matrix elements to float32 — models the GLSL uniform upload. */
function toF32Matrix(m: THREE.Matrix4): THREE.Matrix4 {
  const out = m.clone();
  for (let i = 0; i < 16; i++) out.elements[i] = f(out.elements[i]!);
  return out;
}
/** mat4 · (x,y,z,1) carried out entirely in float32 — models the vertex shader. */
function applyF32(m: THREE.Matrix4, x: number, y: number, z: number): THREE.Vector3 {
  const e = m.elements;
  return new THREE.Vector3(
    f(f(f(f(e[0]! * x) + f(e[4]! * y)) + f(e[8]! * z)) + e[12]!),
    f(f(f(f(e[1]! * x) + f(e[5]! * y)) + f(e[9]! * z)) + e[13]!),
    f(f(f(f(e[2]! * x) + f(e[6]! * y)) + f(e[10]! * z)) + e[14]!),
  );
}

/** A camera parked a few body-radii back from the render origin, looking at it. */
function closeUpView(radiusM: number): THREE.Matrix4 {
  const r = radiusM / SCENE_SCALE;
  const cam = new THREE.PerspectiveCamera(50, 1.6, 1e-7, 1e7);
  cam.position.set(r * 4, r * 2, r * 6);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  return cam.matrixWorldInverse;
}

/** Where the marker (a sprite at toRender(body) = ~origin) renders, in view space. */
function markerView(view: THREE.Matrix4, body: Vec3, origin: Vec3): THREE.Vector3 {
  const obj = new THREE.Object3D();
  obj.position.set(f((body.x - origin.x) / SCENE_SCALE), f((body.y - origin.y) / SCENE_SCALE), f((body.z - origin.z) / SCENE_SCALE));
  obj.updateMatrixWorld();
  return applyF32(toF32Matrix(new THREE.Matrix4().multiplyMatrices(view, obj.matrixWorld)), 0, 0, 0);
}

/** On-body orbit vertex under the NEW idiom (real fillOrbitLoopWorld), in view space. */
function newVertexView(view: THREE.Matrix4, parent: Vec3, pts: Vec3[], origin: Vec3): THREE.Vector3 {
  const arr = new Float32Array(pts.length * 3);
  fillOrbitLoopWorld(arr, pts, parent, origin); // loop .position stays at the origin
  const obj = new THREE.Object3D();
  obj.updateMatrixWorld();
  const mv = toF32Matrix(new THREE.Matrix4().multiplyMatrices(view, obj.matrixWorld));
  return applyF32(mv, arr[0]!, arr[1]!, arr[2]!); // vertex 0 is phased onto the body
}

/** On-body orbit vertex under the OLD idiom (loop .position = parent), in view space. */
function oldVertexView(view: THREE.Matrix4, parent: Vec3, pts: Vec3[], origin: Vec3): THREE.Vector3 {
  const obj = new THREE.Object3D();
  obj.position.set(f((parent.x - origin.x) / SCENE_SCALE), f((parent.y - origin.y) / SCENE_SCALE), f((parent.z - origin.z) / SCENE_SCALE));
  obj.updateMatrixWorld();
  const mv = toF32Matrix(new THREE.Matrix4().multiplyMatrices(view, obj.matrixWorld));
  const p0 = pts[0]!;
  return applyF32(mv, f(p0.x / SCENE_SCALE), f(p0.y / SCENE_SCALE), f(p0.z / SCENE_SCALE));
}

// Sun-parented bodies the user saw wobble. Pluto is also a barycentric binary, so
// its heliocentric loop is drawn about the Pluto–Charon BARYCENTRE, not Pluto's
// marker — hence we test each loop against its own f64 target (parent + near vertex),
// which is the marker for an ordinary body and the barycentre for Pluto.
const REPORTED = ["pluto", "ceres", "vesta", "halley", "jupiter"] as const;
const T0 = 123_456_789; // arbitrary epoch (s past J2000)

/** The f64-exact world point the loop's phased near vertex (index 0) represents:
 *  the anchor plus that vertex. For an ordinary body this is the body's centre; for
 *  a binary primary (Pluto) it is the system barycentre the loop is drawn about. */
function loopNearPoint(parent: Vec3, pts: Vec3[]): Vec3 {
  const p0 = pts[0]!;
  return { x: parent.x + p0.x, y: parent.y + p0.y, z: parent.z + p0.z };
}

describe("orbit loop float32 precision (spazzy-line fix)", () => {
  it("renders the near vertex at its exact ellipse point to sub-metre precision", () => {
    for (const id of REPORTED) {
      const body = BODY_BY_ID.get(id)!;
      const parentW = bodyState(BODY_BY_ID.get(body.parent!)!, T0).r;
      const bodyW = bodyState(body, T0).r; // floating origin (focus) sits on the body
      const pts = orbitPath(bodyElements(body, T0)!, 384);
      const view = closeUpView(body.radius);
      const target = markerView(view, loopNearPoint(parentW, pts), bodyW);

      const drift = KM(newVertexView(view, parentW, pts, bodyW).distanceTo(target));
      // No float32 cancellation — the vertex lands where the ellipse places it.
      expect(drift, `${id}: near vertex should sit on its exact point`).toBeLessThan(0.01); // < 10 m
    }
  });

  it("beats the old parent-anchored idiom by orders of magnitude on every reported body", () => {
    for (const id of REPORTED) {
      const body = BODY_BY_ID.get(id)!;
      const parentW = bodyState(BODY_BY_ID.get(body.parent!)!, T0).r;
      const bodyW = bodyState(body, T0).r;
      const pts = orbitPath(bodyElements(body, T0)!, 384);
      const view = closeUpView(body.radius);
      const target = markerView(view, loopNearPoint(parentW, pts), bodyW);

      const oldDrift = KM(oldVertexView(view, parentW, pts, bodyW).distanceTo(target));
      const newDrift = KM(newVertexView(view, parentW, pts, bodyW).distanceTo(target));
      // The old idiom misses by ≥1 km (tens–hundreds for the worst); the fix is at
      // least 1000× tighter.
      expect(oldDrift, `${id}: old idiom should visibly miss`).toBeGreaterThan(1);
      expect(newDrift, `${id}: fix should be far tighter than the old idiom`).toBeLessThan(oldDrift / 1000);
    }
  });

  it("holds the near vertex still across frames (no wobble), where the old idiom jitters", () => {
    // The "spazzy" symptom is the residual CHANGING between frames as the body
    // moves. Sample several frames spread across a chunk of each orbit and measure
    // how far the near vertex (relative to its exact point) ranges. The fix stays
    // put; the old idiom wanders across many float32 buckets.
    const STEP = 2e7; // ~231 days/sample — enough arc to move every listed body
    const FRAMES = 6;
    for (const id of REPORTED) {
      const body = BODY_BY_ID.get(id)!;
      const parent = BODY_BY_ID.get(body.parent!)!;
      const residual = (t: number, idiom: typeof oldVertexView) => {
        const parentW = bodyState(parent, t).r;
        const bodyW = bodyState(body, t).r;
        const pts = orbitPath(bodyElements(body, t)!, 384);
        const view = closeUpView(body.radius);
        // Relative to the exact point: the loop's wobble, with real orbital motion divided out.
        return idiom(view, parentW, pts, bodyW).sub(markerView(view, loopNearPoint(parentW, pts), bodyW));
      };
      const spread = (idiom: typeof oldVertexView) => {
        const samples = Array.from({ length: FRAMES }, (_, k) => residual(T0 + k * STEP, idiom));
        let max = 0;
        for (let i = 0; i < samples.length; i++)
          for (let j = i + 1; j < samples.length; j++) max = Math.max(max, samples[i]!.distanceTo(samples[j]!));
        return KM(max);
      };
      const oldJitter = spread(oldVertexView);
      const newJitter = spread(newVertexView);

      expect(newJitter, `${id}: fix should be rock-steady across frames`).toBeLessThan(0.01); // < 10 m
      expect(oldJitter, `${id}: old idiom should visibly wobble`).toBeGreaterThan(1); // ≥ 1 km
    }
  });
});

describe("Pluto–Charon binary orbit loops", () => {
  const PLUTO = BODY_BY_ID.get("pluto")!;
  const CHARON = BODY_BY_ID.get("charon")!;
  const f = CHARON.mu / (PLUTO.mu + CHARON.mu);

  // Reproduce update()'s barycentre exactly: primary centre + f·(satellite rel centre).
  const baryAt = (t: number): Vec3 => {
    const p = bodyState(PLUTO, t).r;
    const s = bodyStateRelative(CHARON, t).r;
    return { x: p.x + f * s.x, y: p.y + f * s.y, z: p.z + f * s.z };
  };
  // Distance (km) from a filled loop's near vertex (index 0) to a world point,
  // both expressed in the same origin-relative render frame.
  const nearVertexToBody = (arr: Float32Array, bodyW: Vec3, origin: Vec3) =>
    KM(Math.hypot(
      arr[0]! - (bodyW.x - origin.x) / SCENE_SCALE,
      arr[1]! - (bodyW.y - origin.y) / SCENE_SCALE,
      arr[2]! - (bodyW.z - origin.z) / SCENE_SCALE,
    ));

  it("places the barycentre above Pluto's surface (a true binary)", () => {
    const offset = Math.hypot(
      baryAt(T0).x - bodyState(PLUTO, T0).r.x,
      baryAt(T0).y - bodyState(PLUTO, T0).r.y,
      baryAt(T0).z - bodyState(PLUTO, T0).r.z,
    );
    expect(offset).toBeGreaterThan(PLUTO.radius); // ~2130 km > 1188 km
  });

  it("draws Pluto's loop (scale −f) through Pluto and Charon's loop (scale 1−f) through Charon", () => {
    const origin = bodyState(PLUTO, T0).r; // focus on Pluto
    const bary = baryAt(T0);
    const charonPts = orbitPath(bodyElements(CHARON, T0)!, 384);

    const plutoLoop = new Float32Array(charonPts.length * 3);
    fillOrbitLoopWorld(plutoLoop, charonPts, bary, origin, -f);
    expect(nearVertexToBody(plutoLoop, bodyState(PLUTO, T0).r, origin), "Pluto loop → Pluto").toBeLessThan(0.01);

    const charonLoop = new Float32Array(charonPts.length * 3);
    fillOrbitLoopWorld(charonLoop, charonPts, bary, origin, 1 - f);
    expect(nearVertexToBody(charonLoop, bodyState(CHARON, T0).r, origin), "Charon loop → Charon").toBeLessThan(0.01);
  });
});
