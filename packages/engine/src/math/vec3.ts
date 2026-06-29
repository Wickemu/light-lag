/**
 * Plain double-precision 3-vector.
 *
 * Deliberately NOT THREE.Vector3: the simulation core must stay free of the
 * renderer and must serialize to plain JSON. State holds bare {x,y,z} objects;
 * all operations are pure free functions returning fresh vectors (no aliasing
 * surprises). Conversion to THREE.Vector3 happens only at the render boundary.
 *
 * Units are always SI (metres, metres/second). Never store scaled/render units
 * here.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function clone(a: Vec3): Vec3 {
  return { x: a.x, y: a.y, z: a.z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

/** a + b*s — fused multiply-add, the workhorse of integrators. */
export function addScaled(a: Vec3, b: Vec3, s: number): Vec3 {
  return { x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s };
}

export function neg(a: Vec3): Vec3 {
  return { x: -a.x, y: -a.y, z: -a.z };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lengthSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function length(a: Vec3): number {
  return Math.sqrt(lengthSq(a));
}

export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

/**
 * Rotate `v` by `angle` (rad) about a unit axis `axis` (Rodrigues' rotation formula):
 * v·cosθ + (axis×v)·sinθ + axis·(axis·v)·(1−cosθ). `axis` must be normalized. Right-handed:
 * a positive angle turns counter-clockwise when looking down the axis toward the origin.
 */
export function rotateAboutAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = dot(axis, v) * (1 - c);
  const cr = cross(axis, v);
  return {
    x: v.x * c + cr.x * s + axis.x * k,
    y: v.y * c + cr.y * s + axis.y * k,
    z: v.z * c + cr.z * s + axis.z * k,
  };
}

/** Returns a unit vector. The zero vector maps to itself (no NaN). */
export function normalize(a: Vec3): Vec3 {
  const len = length(a);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  const inv = 1 / len;
  return { x: a.x * inv, y: a.y * inv, z: a.z * inv };
}

export const ZERO: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });
