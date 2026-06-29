import { describe, it, expect } from "vitest";
import { computeMoonPorkchop, searchMoonWindow, moonLooseApoAlt } from "./moon.ts";
import { propagate, elementsToState } from "../math/kepler.ts";
import { circularOrbit, soiRadius } from "../orbit.ts";
import { bodyStateRelative, bodyElements } from "../ephemeris.ts";
import { length } from "../math/vec3.ts";
import { BODY_BY_ID } from "../constants.ts";

const EARTH = BODY_BY_ID.get("earth")!;
const MOON = BODY_BY_ID.get("moon")!;
const JUP = BODY_BY_ID.get("jupiter")!;
const EUROPA = BODY_BY_ID.get("europa")!;

// A ~400 km, slightly-inclined LEO about Earth (the parking orbit a lunar hop departs from).
function leoState(): { aPark: number; shipState: (t: number) => ReturnType<typeof elementsToState> } {
  const el = circularOrbit(EARTH.radius + 4e5, 0.09, 0, 0);
  return { aPark: el.a, shipState: (t: number) => elementsToState(propagate(el, EARTH.mu, t), EARTH.mu) };
}

describe("parent-centric moon porkchop", () => {
  it("returns a finite-best grid of the expected shape for an Earth→Moon hop", () => {
    const { aPark, shipState } = leoState();
    const pork = computeMoonPorkchop("earth", "moon", 0, shipState, aPark)!;
    expect(pork).toBeTruthy();
    expect(pork.fromId).toBe("earth");
    expect(pork.toId).toBe("moon");
    expect(pork.cells.length).toBe(pork.depN);
    expect(pork.cells[0]!.length).toBe(pork.tofN);
    expect(pork.best).toBeTruthy();
    expect(isFinite(pork.best!.total)).toBe(true);
    // The best cell is a real translunar injection + a lunar capture (a few km/s total).
    expect(pork.best!.total / 1000).toBeGreaterThan(3);
    expect(pork.best!.total / 1000).toBeLessThan(7);
    // arrT = depT + tof on every cell; maxFinite bounds the best.
    for (const col of pork.cells) for (const c of col) {
      expect(c.arrT).toBeCloseTo(c.depT + c.tof, 3);
    }
    expect(pork.maxFinite).toBeGreaterThanOrEqual(pork.best!.total);
  });

  it("the loose-ellipse variant captures cheaper than the circular one", () => {
    const { aPark, shipState } = leoState();
    const apo = moonLooseApoAlt(EARTH, MOON, 0);
    const circular = computeMoonPorkchop("earth", "moon", 0, shipState, aPark)!;
    const elliptical = computeMoonPorkchop("earth", "moon", 0, shipState, aPark, apo)!;
    // The cheap Oberth ellipse sheds only enough energy to bind — strictly less capture Δv.
    expect(elliptical.best!.dvArrive).toBeLessThan(circular.best!.dvArrive);
    expect(elliptical.best!.total).toBeLessThan(circular.best!.total);
  });

  it("is deterministic — two calls produce byte-identical grids", () => {
    const { aPark, shipState } = leoState();
    const a = computeMoonPorkchop("earth", "moon", 0, shipState, aPark);
    const b = computeMoonPorkchop("earth", "moon", 0, shipState, aPark);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("returns null for a moon that doesn't orbit the parent", () => {
    const { aPark, shipState } = leoState();
    expect(computeMoonPorkchop("earth", "europa", 0, shipState, aPark)).toBeNull();
  });

  it("moonLooseApoAlt is ~half the moon's SOI above its surface", () => {
    const rMoon = length(bodyStateRelative(MOON, 0).r);
    const rSoi = soiRadius(rMoon, MOON.mu, EARTH.mu);
    expect(moonLooseApoAlt(EARTH, MOON, 0)).toBeCloseTo(0.5 * rSoi - MOON.radius, 0);
  });
});

describe("searchMoonWindow threads captureApoAlt", () => {
  it("an elliptical capture costs less arrival Δv than the circular default", () => {
    // A loose Jupiter orbit roughly coplanar with the Galileans, ready to hop to Europa.
    const el0 = bodyElements(EUROPA, 0)!;
    const el = { a: 3e9, e: 0.6, i: el0.i, Omega: el0.Omega, omega: el0.omega, M: 0 };
    const shipState = (t: number) => elementsToState(propagate(el, JUP.mu, t), JUP.mu);
    const apo = moonLooseApoAlt(JUP, EUROPA, 0);
    const circular = searchMoonWindow("jupiter", "europa", 0, shipState, el.a)!;
    const elliptical = searchMoonWindow("jupiter", "europa", 0, shipState, el.a, apo)!;
    expect(circular).toBeTruthy();
    expect(elliptical).toBeTruthy();
    expect(elliptical.dvArrive).toBeLessThan(circular.dvArrive);
  });
});
