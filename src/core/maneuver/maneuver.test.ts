import { describe, it, expect } from "vitest";
import { lambert, stumpffC, stumpffS } from "./lambert.ts";
import { hohmann, synodicPeriod } from "./hohmann.ts";
import { computePorkchop } from "./porkchop.ts";
import { elementsToState, propagate, period } from "../math/kepler.ts";
import { length, distance } from "../math/vec3.ts";
import { BODY_BY_ID, MU_SUN, AU, DAY } from "../constants.ts";
import { bodyElements } from "../ephemeris.ts";

describe("Stumpff functions", () => {
  it("take their correct limits at z = 0", () => {
    expect(stumpffC(0)).toBeCloseTo(0.5, 12);
    expect(stumpffS(0)).toBeCloseTo(1 / 6, 12);
  });
  it("are continuous across z = 0", () => {
    expect(stumpffC(1e-6)).toBeCloseTo(0.5, 6);
    expect(stumpffC(-1e-6)).toBeCloseTo(0.5, 6);
    expect(stumpffS(1e-6)).toBeCloseTo(1 / 6, 6);
    expect(stumpffS(-1e-6)).toBeCloseTo(1 / 6, 6);
  });
});

describe("Lambert solver — self-consistency", () => {
  // The gold standard: take a real arc of a known orbit; Lambert fed its
  // endpoints and the true time-of-flight must recover the true velocities.
  const cases = [
    { a: 1.3 * AU, e: 0.2, i: 0.1, Omega: 0.3, omega: 0.5, M: 0.4, dtDays: 120 },
    { a: 1.0 * AU, e: 0.05, i: 0.02, Omega: 0.0, omega: 0.0, M: 0.0, dtDays: 90 },
    { a: 2.0 * AU, e: 0.3, i: 0.25, Omega: 1.0, omega: 2.0, M: -0.5, dtDays: 200 },
  ];
  for (const c of cases) {
    it(`recovers velocities for a=${c.a / AU} AU, e=${c.e}`, () => {
      const el1 = { a: c.a, e: c.e, i: c.i, Omega: c.Omega, omega: c.omega, M: c.M };
      const dt = c.dtDays * DAY;
      const s1 = elementsToState(el1, MU_SUN);
      const s2 = elementsToState(propagate(el1, MU_SUN, dt), MU_SUN);
      const sol = lambert(s1.r, s2.r, dt, MU_SUN, true);
      expect(sol).not.toBeNull();
      expect(distance(sol!.v1, s1.v) / length(s1.v)).toBeLessThan(1e-6);
      expect(distance(sol!.v2, s2.v) / length(s2.v)).toBeLessThan(1e-6);
    });
  }

  it("returns null for the degenerate 180° transfer", () => {
    const r1 = { x: AU, y: 0, z: 0 };
    const r2 = { x: -1.5 * AU, y: 0, z: 0 }; // exactly opposite → plane undefined
    expect(lambert(r1, r2, 200 * DAY, MU_SUN, true)).toBeNull();
  });
});

describe("Hohmann transfer (Earth → Mars, heliocentric)", () => {
  it("gives the textbook ~5.6 km/s total and ~259 day flight", () => {
    const aE = bodyElements(BODY_BY_ID.get("earth")!, 0)!.a;
    const aM = bodyElements(BODY_BY_ID.get("mars")!, 0)!.a;
    const h = hohmann(MU_SUN, aE, aM);
    expect(h.dvTotal).toBeGreaterThan(5000);
    expect(h.dvTotal).toBeLessThan(6200);
    expect(h.tof / DAY).toBeGreaterThan(250);
    expect(h.tof / DAY).toBeLessThan(270);
  });

  it("synodic period of Earth & Mars is ~780 days", () => {
    const tE = period(bodyElements(BODY_BY_ID.get("earth")!, 0)!.a, MU_SUN);
    const tM = period(bodyElements(BODY_BY_ID.get("mars")!, 0)!.a, MU_SUN);
    expect(synodicPeriod(tE, tM) / DAY).toBeGreaterThan(770);
    expect(synodicPeriod(tE, tM) / DAY).toBeLessThan(790);
  });
});

describe("Porkchop (Earth → Mars over one synodic period)", () => {
  it("finds a realistic minimum-Δv window with a sensible flight time", () => {
    const pork = computePorkchop({
      fromId: "earth", toId: "mars",
      depStart: 0, depEnd: 800 * DAY, depN: 60,
      tofMin: 120 * DAY, tofMax: 330 * DAY, tofN: 44,
    });
    expect(pork.best).not.toBeNull();
    const best = pork.best!;
    // Real Earth→Mars optimal injection+arrival Δv is ~5–7 km/s.
    expect(best.total).toBeGreaterThan(4500);
    expect(best.total).toBeLessThan(8000);
    // Optimal transfers run ~5–9 months.
    expect(best.tof / DAY).toBeGreaterThan(150);
    expect(best.tof / DAY).toBeLessThan(330);
    // Both legs are real, positive burns.
    expect(best.dvDepart).toBeGreaterThan(0);
    expect(best.dvArrive).toBeGreaterThan(0);
  });
});
