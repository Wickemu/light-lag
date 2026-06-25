/**
 * Two-body (Keplerian) orbital mechanics: the keystone of the whole sim.
 *
 * Everything that coasts — planets, moons, ships with engines off — is an exact
 * conic section. We evaluate it analytically at any time t, which means a
 * million-times fast-forward is just as cheap and just as exact as real time,
 * with zero numerical drift. Powered flight (Phase 2) is the only thing that
 * gets numerically integrated.
 *
 * All angles are radians, all distances metres, mu = GM in m^3/s^2. We use the
 * published gravitational parameter mu directly (known to 10+ sig figs) rather
 * than G*M (G is only good to ~4), so we never throw away precision we have.
 *
 * References: Vallado, "Fundamentals of Astrodynamics and Applications";
 * Curtis, "Orbital Mechanics for Engineering Students".
 */

import { type Vec3, vec3, add, scale, length, dot, cross } from "./vec3.ts";

const TWO_PI = 2 * Math.PI;

/** Classical (Keplerian) orbital elements. M is the mean anomaly AT the epoch
 *  you are evaluating — propagation is done by advancing M before calling here. */
export interface KeplerElements {
  /** Semi-major axis (m). Negative for hyperbolic orbits. */
  a: number;
  /** Eccentricity (dimensionless). 0 = circle, <1 ellipse, 1 parabola, >1 hyperbola. */
  e: number;
  /** Inclination (rad). */
  i: number;
  /** Longitude of the ascending node, Ω (rad). */
  Omega: number;
  /** Argument of periapsis, ω (rad). */
  omega: number;
  /** Mean anomaly, M (rad). */
  M: number;
}

export interface State {
  r: Vec3;
  v: Vec3;
}

/** Wrap an angle into [-π, π]. */
export function wrapPi(x: number): number {
  let a = (x + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

/** Wrap an angle into [0, 2π). */
export function wrapTwoPi(x: number): number {
  let a = x % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a;
}

/**
 * Solve Kepler's equation M = E - e·sin E for the eccentric anomaly E (elliptic).
 *
 * Newton-Raphson. The naive fixed-point iteration E = M + e·sin E DIVERGES as
 * e -> 1, which is why we use Newton and seed E = π for high eccentricity.
 * Converges to ~1e-13 in a handful of iterations across e ∈ [0, 0.999].
 */
export function solveKeplerElliptic(M: number, e: number): number {
  const m = wrapPi(M);
  // Good initial guess: for low e, E ≈ M; for high e the curve is stiff near
  // periapsis, so seed at π to stay in the basin of convergence.
  let E = e < 0.8 ? m : Math.PI * Math.sign(m || 1);
  for (let iter = 0; iter < 100; iter++) {
    const f = E - e * Math.sin(E) - m;
    const fp = 1 - e * Math.cos(E);
    const dE = f / fp;
    E -= dE;
    if (Math.abs(dE) < 1e-13) break;
  }
  return E;
}

/**
 * Solve the hyperbolic Kepler equation M = e·sinh F - F for F (e > 1).
 * Different function entirely from the elliptic case — required for escape
 * trajectories and flybys.
 */
export function solveKeplerHyperbolic(M: number, e: number): number {
  // Initial guess (Vallado): scales with M.
  let F = Math.asinh(M / e);
  if (!isFinite(F)) F = Math.sign(M) * Math.log((2 * Math.abs(M)) / e + 1.8);
  for (let iter = 0; iter < 100; iter++) {
    const f = e * Math.sinh(F) - F - M;
    const fp = e * Math.cosh(F) - 1;
    const dF = f / fp;
    F -= dF;
    if (Math.abs(dF) < 1e-13) break;
  }
  return F;
}

/** True anomaly ν from eccentric anomaly E (elliptic). */
export function trueAnomalyFromE(E: number, e: number): number {
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
}

/** True anomaly ν from hyperbolic anomaly F (hyperbolic). */
export function trueAnomalyFromF(F: number, e: number): number {
  return 2 * Math.atan2(Math.sqrt(e + 1) * Math.sinh(F / 2), Math.sqrt(e - 1) * Math.cosh(F / 2));
}

/** Mean anomaly from eccentric anomaly (elliptic). */
export function meanAnomalyFromE(E: number, e: number): number {
  return E - e * Math.sin(E);
}

/**
 * Rotate a vector from the perifocal frame (x toward periapsis, z along orbit
 * normal) into the inertial frame, by R = Rz(Ω)·Rx(i)·Rz(ω).
 */
function perifocalToInertial(p: Vec3, i: number, Omega: number, omega: number): Vec3 {
  const cO = Math.cos(Omega), sO = Math.sin(Omega);
  const ci = Math.cos(i), si = Math.sin(i);
  const cw = Math.cos(omega), sw = Math.sin(omega);

  // Combined rotation matrix rows.
  const r11 = cO * cw - sO * sw * ci;
  const r12 = -cO * sw - sO * cw * ci;
  const r13 = sO * si;
  const r21 = sO * cw + cO * sw * ci;
  const r22 = -sO * sw + cO * cw * ci;
  const r23 = -cO * si;
  const r31 = sw * si;
  const r32 = cw * si;
  const r33 = ci;

  return {
    x: r11 * p.x + r12 * p.y + r13 * p.z,
    y: r21 * p.x + r22 * p.y + r23 * p.z,
    z: r31 * p.x + r32 * p.y + r33 * p.z,
  };
}

/**
 * Classical elements -> position & velocity (the "coe2rv" transform).
 * Handles elliptic and hyperbolic orbits. mu in m^3/s^2.
 */
export function elementsToState(el: KeplerElements, mu: number): State {
  const { a, e, i, Omega, omega, M } = el;

  let nu: number;
  let r: number;
  if (e < 1) {
    const E = solveKeplerElliptic(M, e);
    nu = trueAnomalyFromE(E, e);
    r = a * (1 - e * Math.cos(E));
  } else {
    const F = solveKeplerHyperbolic(M, e);
    nu = trueAnomalyFromF(F, e);
    // For hyperbola a < 0; r = a(1 - e cosh F) is positive.
    r = a * (1 - e * Math.cosh(F));
  }

  // Semi-latus rectum p = a(1 - e^2). For hyperbola a<0 and (1-e^2)<0 so p>0.
  const p = a * (1 - e * e);
  const h = Math.sqrt(mu * p);

  // Position in the perifocal frame.
  const cnu = Math.cos(nu), snu = Math.sin(nu);
  const rPerifocal = vec3(r * cnu, r * snu, 0);

  // Velocity in the perifocal frame: v = (mu/h) * [-sin ν, e + cos ν, 0].
  const vScale = mu / h;
  const vPerifocal = vec3(vScale * -snu, vScale * (e + cnu), 0);

  return {
    r: perifocalToInertial(rPerifocal, i, Omega, omega),
    v: perifocalToInertial(vPerifocal, i, Omega, omega),
  };
}

/**
 * Sample the closed orbit (ellipse) defined by `el` into `segments` points,
 * expressed relative to the focus (the parent body). Used by the renderer to
 * draw orbit paths; sweeps true anomaly directly so no Kepler solve is needed.
 * Only valid for bound (elliptic) orbits.
 */
export function orbitPath(el: KeplerElements, segments = 256): Vec3[] {
  const { a, e, i, Omega, omega } = el;
  const p = a * (1 - e * e);
  const pts: Vec3[] = [];
  for (let k = 0; k <= segments; k++) {
    const nu = (TWO_PI * k) / segments;
    const r = p / (1 + e * Math.cos(nu));
    const local = vec3(r * Math.cos(nu), r * Math.sin(nu), 0);
    pts.push(perifocalToInertial(local, i, Omega, omega));
  }
  return pts;
}

/**
 * Position & velocity -> classical elements (the "rv2coe" transform).
 * Exercised at every burn boundary and SOI crossing, so it handles the
 * singular cases (circular and/or equatorial) gracefully via the standard
 * node-vector construction. mu in m^3/s^2.
 */
export function stateToElements(r: Vec3, v: Vec3, mu: number): KeplerElements {
  const rMag = length(r);
  const vMag = length(v);

  const h = cross(r, v); // specific angular momentum
  const hMag = length(h);

  // Node vector n = k × h, points toward the ascending node.
  const n = vec3(-h.y, h.x, 0);
  const nMag = length(n);

  // Eccentricity vector: e = ((v^2 - mu/r) r - (r·v) v) / mu, points to periapsis.
  const rv = dot(r, v);
  const eVec = scale(
    add(scale(r, vMag * vMag - mu / rMag), scale(v, -rv)),
    1 / mu,
  );
  const e = length(eVec);

  // Specific orbital energy gives the semi-major axis (vis-viva). The
  // near-parabolic test must be RELATIVE: specific energy here is O(1e7) J/kg,
  // so an absolute threshold never fires — flag on eccentricity instead.
  const energy = (vMag * vMag) / 2 - mu / rMag;
  const a = Math.abs(e - 1) < 1e-9 ? Infinity : -mu / (2 * energy);

  const i = Math.acos(clamp(h.z / hMag, -1, 1));

  const equatorial = nMag < 1e-9;
  const circular = e < 1e-9;

  let Omega: number;
  let omega: number;
  let nu: number;

  if (!equatorial && !circular) {
    Omega = Math.acos(clamp(n.x / nMag, -1, 1));
    if (n.y < 0) Omega = TWO_PI - Omega;

    omega = Math.acos(clamp(dot(n, eVec) / (nMag * e), -1, 1));
    if (eVec.z < 0) omega = TWO_PI - omega;

    nu = Math.acos(clamp(dot(eVec, r) / (e * rMag), -1, 1));
    if (rv < 0) nu = TWO_PI - nu;
  } else if (!equatorial && circular) {
    // Circular inclined: use argument of latitude in place of ω + ν.
    Omega = Math.acos(clamp(n.x / nMag, -1, 1));
    if (n.y < 0) Omega = TWO_PI - Omega;
    omega = 0;
    nu = Math.acos(clamp(dot(n, r) / (nMag * rMag), -1, 1));
    if (r.z < 0) nu = TWO_PI - nu;
  } else if (equatorial && !circular) {
    // Equatorial elliptic: use longitude of periapsis in place of Ω + ω.
    Omega = 0;
    omega = Math.atan2(eVec.y, eVec.x);
    if (h.z < 0) omega = TWO_PI - omega;
    nu = Math.acos(clamp(dot(eVec, r) / (e * rMag), -1, 1));
    if (rv < 0) nu = TWO_PI - nu;
  } else {
    // Circular equatorial: use true longitude.
    Omega = 0;
    omega = 0;
    nu = Math.atan2(r.y, r.x);
    if (h.z < 0) nu = TWO_PI - nu;
  }

  // Mean anomaly from true anomaly.
  let M: number;
  if (e < 1) {
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
    M = wrapTwoPi(meanAnomalyFromE(E, e));
  } else {
    const F = 2 * Math.atanh(clamp(Math.sqrt((e - 1) / (e + 1)) * Math.tan(nu / 2), -0.999999999999, 0.999999999999));
    M = e * Math.sinh(F) - F;
  }

  return { a, e, i, Omega: wrapTwoPi(Omega), omega: wrapTwoPi(omega), M };
}

/**
 * Advance a set of elements by dt seconds (mean anomaly += n·dt). Pure Kepler
 * propagation — exact for any dt, the reason coasting is free at any timewarp.
 */
export function propagate(el: KeplerElements, mu: number, dt: number): KeplerElements {
  const n = meanMotion(el.a, mu);
  return { ...el, M: el.e < 1 ? wrapPi(el.M + n * dt) : el.M + n * dt };
}

/** Mean motion n = sqrt(mu / |a|^3) (rad/s). */
export function meanMotion(a: number, mu: number): number {
  return Math.sqrt(mu / Math.abs(a * a * a));
}

/** Orbital period (s) for a bound (elliptic) orbit; Infinity otherwise. */
export function period(a: number, mu: number): number {
  if (a <= 0) return Infinity;
  return TWO_PI * Math.sqrt((a * a * a) / mu);
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
