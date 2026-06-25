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
  type BodyDef, type StandishRow, type MoonRow, type FixedHelioRow, BODY_BY_ID,
} from "./constants.ts";
import { type State, type KeplerElements, elementsToState, wrapPi } from "./math/kepler.ts";
import { type Vec3, add, sub, scale } from "./math/vec3.ts";

/** Resolve the Standish elements of a planet at time t (s since J2000) into SI
 *  Keplerian elements (metres, radians). Uses the JPL "Approximate Positions"
 *  1800–2050 linear element set — arc-minute class for the inner planets and a
 *  few arc-minutes for the giants across the realistic game era (verified
 *  against JPL Horizons in ephemeris.horizons.test.ts). Extending validity to
 *  3000 BC–3000 AD (the giants' b,c,s,f libration terms) is a documented roadmap
 *  option that trades a little in-window precision for range. */
export function standishElements(row: StandishRow, t: number): KeplerElements {
  const T = t / JULIAN_CENTURY; // Julian centuries past J2000
  const a = (row.a + row.aDot * T) * AU;
  const e = row.e + row.eDot * T;
  const i = (row.i + row.iDot * T) * DEG;
  const periDeg = row.peri + row.periDot * T; // longitude of perihelion ϖ (deg)
  const nodeDeg = row.node + row.nodeDot * T; // Ω (deg)
  const Ldeg = row.L + row.LDot * T; // mean longitude (deg)

  return {
    a, e, i,
    Omega: nodeDeg * DEG,
    omega: (periDeg - nodeDeg) * DEG, // ω = ϖ − Ω
    M: wrapPi((Ldeg - periDeg) * DEG), // mean anomaly M = L − ϖ
  };
}

/** Resolve a small body's fixed heliocentric osculating elements at time t
 *  (s since J2000) into SI Keplerian elements about the Sun. The mean motion is
 *  derived from MU_SUN (n = √(MU_SUN/a³)); only the mean anomaly advances. A pure
 *  two-body conic — exact at J2000, drifting over decades (perturbations
 *  neglected), the same documented approximation the Moon row carries. Note: the
 *  row stores ω directly (NOT ϖ), so unlike standishElements there is no ϖ→ω
 *  conversion here. */
export function helioElements(row: FixedHelioRow, t: number): KeplerElements {
  const a = row.a * AU;
  const n = Math.sqrt(MU_SUN / (a * a * a)); // mean motion (rad/s)
  return {
    a, e: row.e, i: row.i * DEG,
    Omega: row.node * DEG,
    omega: row.peri * DEG,
    M: wrapPi(row.M0 * DEG + n * t),
  };
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
  if (body.helio) return helioElements(body.helio, t);
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
  const state = elementsToState(el, mu);

  // The Standish "earth" row is the Earth–Moon BARYCENTRE. Shift to Earth's true
  // centre: r_earth = r_EMB − f·r_moon(rel Earth), f = μ_moon/(μ_earth+μ_moon).
  // The Moon's own row is already relative to Earth's centre, so the parent chain
  // then lands it at true_earth + moonRel, and the two recombine to the original
  // EMB exactly (mass-weighted barycentre invariant preserved).
  if (body.id === "earth") {
    const moon = BODY_BY_ID.get("moon");
    if (moon) {
      const moonRel = bodyStateRelative(moon, t); // Moon relative to Earth's centre
      const f = moon.mu / (body.mu + moon.mu);
      return { r: sub(state.r, scale(moonRel.r, f)), v: sub(state.v, scale(moonRel.v, f)) };
    }
  }
  return state;
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
