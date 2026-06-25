/**
 * Lambert's problem: given a start position r1, an end position r2, and a
 * time-of-flight, find the conic that connects them — i.e. the velocity you must
 * have at r1 (and will have at r2). This is the general transfer planner that
 * makes porkchop plots and real launch windows possible.
 *
 * Implementation: the universal-variable / Stumpff-function method (Curtis,
 * "Orbital Mechanics for Engineering Students", Algorithm 5.2). Single
 * revolution. Handles elliptic and hyperbolic transfers, prograde or retrograde.
 *
 * SI: r in metres, dt in seconds, mu in m^3/s^2.
 */

import { type Vec3, length, cross, dot, sub, scale } from "../math/vec3.ts";

/** Stumpff function C(z). */
export function stumpffC(z: number): number {
  if (z > 0) {
    const s = Math.sqrt(z);
    return (1 - Math.cos(s)) / z;
  }
  if (z < 0) {
    const s = Math.sqrt(-z);
    return (Math.cosh(s) - 1) / -z;
  }
  return 1 / 2;
}

/** Stumpff function S(z). */
export function stumpffS(z: number): number {
  if (z > 0) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < 0) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6;
}

export interface LambertSolution {
  v1: Vec3; // velocity at r1
  v2: Vec3; // velocity at r2
}

/**
 * Solve Lambert's problem. Returns null for the degenerate transfer-angle cases
 * (0° or 180°, where the plane is undefined) or if the iteration fails to
 * converge.
 */
export function lambert(
  r1: Vec3,
  r2: Vec3,
  dt: number,
  mu: number,
  prograde = true,
): LambertSolution | null {
  if (dt <= 0) return null;

  const r1m = length(r1);
  const r2m = length(r2);
  const c12 = cross(r1, r2);
  let cosDtheta = dot(r1, r2) / (r1m * r2m);
  cosDtheta = Math.max(-1, Math.min(1, cosDtheta));

  let dTheta = Math.acos(cosDtheta);
  if (prograde) {
    if (c12.z < 0) dTheta = 2 * Math.PI - dTheta;
  } else {
    if (c12.z >= 0) dTheta = 2 * Math.PI - dTheta;
  }

  const sinDtheta = Math.sin(dTheta);
  const denom = 1 - cosDtheta;
  if (Math.abs(sinDtheta) < 1e-12 || denom < 1e-12) return null; // 0° / 180°

  const A = sinDtheta * Math.sqrt((r1m * r2m) / denom);
  if (A === 0) return null;

  const yOf = (z: number): number =>
    r1m + r2m + (A * (z * stumpffS(z) - 1)) / Math.sqrt(stumpffC(z));

  const Fof = (z: number): number => {
    const y = yOf(z);
    const C = stumpffC(z);
    const S = stumpffS(z);
    return Math.pow(y / C, 1.5) * S + A * Math.sqrt(y) - Math.sqrt(mu) * dt;
  };

  const dFdz = (z: number): number => {
    if (z === 0) {
      const y0 = yOf(0);
      return (Math.SQRT2 / 40) * Math.pow(y0, 1.5) + (A / 8) * (Math.sqrt(y0) + A * Math.sqrt(1 / (2 * y0)));
    }
    const C = stumpffC(z);
    const S = stumpffS(z);
    const y = yOf(z);
    return (
      Math.pow(y / C, 1.5) * ((1 / (2 * z)) * (C - (3 * S) / (2 * C)) + (3 * S * S) / (4 * C)) +
      (A / 8) * ((3 * S / C) * Math.sqrt(y) + A * Math.sqrt(C / y))
    );
  };

  // Bracket: advance z until y(z) > 0, then Newton-iterate F(z) = 0.
  let z = 0;
  let guard = 0;
  while (yOf(z) < 0 && guard++ < 1000) z += 0.1;
  if (yOf(z) < 0) return null;

  for (let i = 0; i < 100; i++) {
    const f = Fof(z);
    const d = dFdz(z);
    if (!isFinite(d) || d === 0) return null;
    const dz = f / d;
    z -= dz;
    if (Math.abs(dz) < 1e-8) break;
  }

  const y = yOf(z);
  if (!isFinite(y) || y < 0) return null;

  // Lagrange coefficients.
  const f = 1 - y / r1m;
  const g = A * Math.sqrt(y / mu);
  const gdot = 1 - y / r2m;
  if (g === 0) return null;

  const v1 = scale(sub(r2, scale(r1, f)), 1 / g);
  const v2 = scale(sub(scale(r2, gdot), r1), 1 / g);
  return { v1, v2 };
}
