import { describe, it, expect } from "vitest";
import {
  solveKeplerElliptic,
  solveKeplerHyperbolic,
  elementsToState,
  stateToElements,
  meanMotion,
  period,
  type KeplerElements,
} from "./kepler.ts";
import { length, distance } from "./vec3.ts";
import { MU_SUN, AU } from "../constants.ts";

const TWO_PI = 2 * Math.PI;

describe("Kepler's equation", () => {
  it("elliptic solution satisfies M = E - e·sin E", () => {
    for (const e of [0, 0.01, 0.2, 0.5, 0.8, 0.9, 0.99]) {
      for (let k = 0; k < 24; k++) {
        const M = -Math.PI + (TWO_PI * k) / 24;
        const E = solveKeplerElliptic(M, e);
        const residual = E - e * Math.sin(E) - M;
        // M is wrapped to [-π,π] inside the solver; compare wrapped.
        const wrapped = Math.atan2(Math.sin(residual), Math.cos(residual));
        expect(Math.abs(wrapped)).toBeLessThan(1e-10);
      }
    }
  });

  it("hyperbolic solution satisfies M = e·sinh F - F", () => {
    for (const e of [1.1, 1.5, 3.0]) {
      for (const M of [-5, -1, -0.1, 0.1, 1, 5]) {
        const F = solveKeplerHyperbolic(M, e);
        const residual = e * Math.sinh(F) - F - M;
        expect(Math.abs(residual)).toBeLessThan(1e-8);
      }
    }
  });
});

describe("elements <-> state round trip", () => {
  const cases: KeplerElements[] = [
    { a: 1.2 * AU, e: 0.3, i: 0.4, Omega: 1.0, omega: 2.0, M: 0.7 },
    { a: 0.7 * AU, e: 0.05, i: 0.1, Omega: 0.2, omega: 0.3, M: 3.0 },
    { a: 5.2 * AU, e: 0.048, i: 0.0228, Omega: 1.75, omega: 0.257, M: -1.2 },
  ];

  it("recovers elements (non-singular orbits) to high precision", () => {
    for (const el of cases) {
      const s = elementsToState(el, MU_SUN);
      const el2 = stateToElements(s.r, s.v, MU_SUN);
      expect(el2.a).toBeCloseTo(el.a, -3); // within ~1e3 m on 1e11
      expect(el2.e).toBeCloseTo(el.e, 8);
      expect(el2.i).toBeCloseTo(el.i, 8);
      expect(angleClose(el2.Omega, el.Omega)).toBe(true);
      expect(angleClose(el2.omega, el.omega)).toBe(true);
      expect(angleClose(el2.M, el.M)).toBe(true);
    }
  });

  it("is self-consistent through a full re-projection (state stable)", () => {
    for (const el of cases) {
      const s1 = elementsToState(el, MU_SUN);
      const el2 = stateToElements(s1.r, s1.v, MU_SUN);
      const s2 = elementsToState(el2, MU_SUN);
      expect(distance(s1.r, s2.r) / length(s1.r)).toBeLessThan(1e-9);
      expect(distance(s1.v, s2.v) / length(s1.v)).toBeLessThan(1e-9);
    }
  });
});

describe("hyperbolic elements <-> state round trip", () => {
  // Hyperbolic orbits (e>1, a<0) drive every interplanetary capture and flyby —
  // arrival.ts runs stateToElements on the inbound hyperbola — so coe2rv/rv2coe
  // must round-trip on the hyperbolic branch too, not just for ellipses.
  const cases: KeplerElements[] = [
    { a: -1.2 * AU, e: 1.2, i: 0.4, Omega: 1.0, omega: 2.0, M: 0.7 },
    { a: -0.8 * AU, e: 2.0, i: 0.3, Omega: 0.5, omega: 1.0, M: -1.5 },
    { a: -0.5 * AU, e: 3.0, i: 0.6, Omega: 2.5, omega: 0.3, M: 1.3 },
  ];

  it("recovers hyperbolic elements (a<0, e>1) to high precision", () => {
    for (const el of cases) {
      const s = elementsToState(el, MU_SUN);
      const el2 = stateToElements(s.r, s.v, MU_SUN);
      expect(el2.a).toBeCloseTo(el.a, -3); // within ~1e3 m on 1e11
      expect(el2.e).toBeCloseTo(el.e, 8);
      expect(el2.i).toBeCloseTo(el.i, 8);
      expect(angleClose(el2.Omega, el.Omega)).toBe(true);
      expect(angleClose(el2.omega, el.omega)).toBe(true);
      // Hyperbolic mean anomaly is unbounded (not wrapped); compare directly.
      expect(Math.abs(el2.M - el.M)).toBeLessThan(1e-6);
    }
  });

  it("is self-consistent through a full re-projection (state stable)", () => {
    for (const el of cases) {
      const s1 = elementsToState(el, MU_SUN);
      const el2 = stateToElements(s1.r, s1.v, MU_SUN);
      const s2 = elementsToState(el2, MU_SUN);
      expect(distance(s1.r, s2.r) / length(s1.r)).toBeLessThan(1e-9);
      expect(distance(s1.v, s2.v) / length(s1.v)).toBeLessThan(1e-9);
    }
  });
});

describe("orbit geometry", () => {
  it("places periapsis at a(1-e) and apoapsis at a(1+e)", () => {
    const a = 1.0 * AU;
    const e = 0.2;
    const peri = elementsToState({ a, e, i: 0, Omega: 0, omega: 0, M: 0 }, MU_SUN);
    const apo = elementsToState({ a, e, i: 0, Omega: 0, omega: 0, M: Math.PI }, MU_SUN);
    expect(length(peri.r)).toBeCloseTo(a * (1 - e), 0);
    expect(length(apo.r)).toBeCloseTo(a * (1 + e), 0);
  });

  it("conserves vis-viva energy: v²/2 - mu/r = -mu/2a", () => {
    const el = { a: 1.5 * AU, e: 0.25, i: 0.3, Omega: 0.5, omega: 0.6, M: 1.1 };
    const s = elementsToState(el, MU_SUN);
    const r = length(s.r);
    const v = length(s.v);
    const energy = (v * v) / 2 - MU_SUN / r;
    expect(energy).toBeCloseTo(-MU_SUN / (2 * el.a), 5);
  });

  it("conserves angular momentum magnitude around the orbit", () => {
    const el = { a: 2.0 * AU, e: 0.4, i: 0.2, Omega: 0.1, omega: 0.9, M: 0 };
    const hs: number[] = [];
    for (let k = 0; k < 8; k++) {
      const s = elementsToState({ ...el, M: (TWO_PI * k) / 8 }, MU_SUN);
      // |r × v|
      const r = s.r;
      const v = s.v;
      const hx = r.y * v.z - r.z * v.y;
      const hy = r.z * v.x - r.x * v.z;
      const hz = r.x * v.y - r.y * v.x;
      hs.push(Math.sqrt(hx * hx + hy * hy + hz * hz));
    }
    const max = Math.max(...hs);
    const min = Math.min(...hs);
    expect((max - min) / max).toBeLessThan(1e-9);
  });
});

describe("mean motion & period", () => {
  it("Kepler's third law: a 1 AU heliocentric orbit has a ~365.25 day period", () => {
    const T = period(AU, MU_SUN);
    const days = T / 86400;
    expect(days).toBeGreaterThan(360);
    expect(days).toBeLessThan(370);
  });

  it("mean motion is consistent with period (n·T = 2π)", () => {
    const a = 1.7 * AU;
    expect(meanMotion(a, MU_SUN) * period(a, MU_SUN)).toBeCloseTo(TWO_PI, 9);
  });
});

function angleClose(a: number, b: number, tol = 1e-6): boolean {
  const d = Math.atan2(Math.sin(a - b), Math.cos(a - b));
  return Math.abs(d) < tol;
}
