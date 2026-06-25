/**
 * Analytic ephemeris: where every natural body is at any instant t.
 *
 * Because bodies move on (near-)Keplerian orbits, we never integrate them — we
 * evaluate the closed-form solution directly. This is what makes arbitrary
 * time-warp exact and O(bodies): jumping the clock a thousand years forward
 * costs exactly the same as advancing one second, with no accumulated error.
 *
 * Planets use the JPL Standish linear-rate elements; the Moon uses mean
 * precessing elements about the Earth. Results are in the root inertial frame
 * (Sun at the origin, ecliptic J2000), SI units.
 */

import {
  AU, DEG, DAY, JULIAN_CENTURY, MU_SUN,
  type BodyDef, type StandishRow, type MoonRow, BODY_BY_ID,
} from "./constants.ts";
import { type State, type KeplerElements, elementsToState, wrapPi } from "./math/kepler.ts";
import { type Vec3, add } from "./math/vec3.ts";

/** Resolve the Standish elements of a planet at time t (s since J2000) into SI
 *  Keplerian elements (metres, radians). */
export function standishElements(row: StandishRow, t: number): KeplerElements {
  const T = t / JULIAN_CENTURY; // Julian centuries past J2000
  const a = (row.a + row.aDot * T) * AU;
  const e = row.e + row.eDot * T;
  const i = (row.i + row.iDot * T) * DEG;
  const L = (row.L + row.LDot * T) * DEG; // mean longitude
  const peri = (row.peri + row.periDot * T) * DEG; // longitude of perihelion ϖ
  const node = (row.node + row.nodeDot * T) * DEG; // Ω

  const omega = peri - node; // argument of periapsis ω = ϖ - Ω
  const M = wrapPi(L - peri); // mean anomaly M = L - ϖ

  return { a, e, i, Omega: node, omega, M };
}

/** Resolve a moon's precessing elements at time t (s since J2000) into SI
 *  Keplerian elements about its parent. */
export function moonElements(row: MoonRow, t: number): KeplerElements {
  const d = t / DAY; // days past J2000
  const i = row.i * DEG;
  const node = (row.node + row.nodeDot * d) * DEG;
  const omega = (row.peri + row.periDot * d) * DEG;
  const M = wrapPi((row.M0 + row.MDot * d) * DEG);
  return { a: row.a, e: row.e, i, Omega: node, omega, M };
}

/** The Keplerian elements of a body relative to its parent at time t. Returns
 *  null for the root body (the Sun), which has no parent orbit. */
export function bodyElements(body: BodyDef, t: number): KeplerElements | null {
  if (body.standish) return standishElements(body.standish, t);
  if (body.moon) return moonElements(body.moon, t);
  return null;
}

/** State of a body relative to its parent (zero for the root). */
export function bodyStateRelative(body: BodyDef, t: number): State {
  const el = bodyElements(body, t);
  if (!el) return { r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 } };
  const parent = body.parent ? BODY_BY_ID.get(body.parent) : undefined;
  // The relative two-body problem is governed by mu = G(M_parent + M_body), not
  // the primary's GM alone. For planets the planet's GM is negligible against
  // the Sun's, but for the Moon (GM_moon ≈ 1.2% of GM_earth) omitting it makes
  // the velocity ~0.5% too slow and inconsistent with the modelled motion.
  const mu = (parent ? parent.mu : MU_SUN) + body.mu;
  return elementsToState(el, mu);
}

/**
 * Absolute state of a body in the root inertial frame at time t, summing the
 * chain of parent-relative states (Moon → Earth → Sun, etc.).
 */
export function bodyState(body: BodyDef, t: number): State {
  let r: Vec3 = { x: 0, y: 0, z: 0 };
  let v: Vec3 = { x: 0, y: 0, z: 0 };
  let current: BodyDef | undefined = body;
  while (current) {
    const rel = bodyStateRelative(current, t);
    r = add(r, rel.r);
    v = add(v, rel.v);
    current = current.parent ? BODY_BY_ID.get(current.parent) : undefined;
  }
  return { r, v };
}

/** Convenience: absolute position of a body by id. */
export function bodyPosition(id: string, t: number): Vec3 {
  const body = BODY_BY_ID.get(id);
  if (!body) throw new Error(`Unknown body: ${id}`);
  return bodyState(body, t).r;
}
