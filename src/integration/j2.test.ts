import { describe, it, expect } from "vitest";
import { j2Rates, sunSyncInclination, specificEnergy } from "@lightlag/engine/orbit";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import { spawnShip, defaultDesign } from "../app/commands.ts";
import { shipOsculatingElements } from "@lightlag/engine/ships";
import { BODIES, BODY_BY_ID, DAY, DEG, RAD, j2RefRadius } from "@lightlag/engine/constants";

const EARTH = BODY_BY_ID.get("earth")!;
const degPerDay = (radPerSec: number) => radPerSec * RAD * DAY;

describe("J2 secular precession rates match reality", () => {
  it("an ISS-like orbit regresses its node ~5°/day westward", () => {
    const a = EARTH.radius + 400e3;
    const r = j2Rates(EARTH.mu, j2RefRadius(EARTH), EARTH.J2!, a, 0.0005, 51.6 * DEG);
    expect(degPerDay(r.nodeDot)).toBeLessThan(-4.7); // westward (negative)
    expect(degPerDay(r.nodeDot)).toBeGreaterThan(-5.3);
  });
  it("a polar orbit has no nodal regression", () => {
    const a = EARTH.radius + 600e3;
    expect(Math.abs(j2Rates(EARTH.mu, j2RefRadius(EARTH), EARTH.J2!, a, 0, 90 * DEG).nodeDot)).toBeLessThan(1e-12);
  });
  it("the critical inclination (~63.43°) freezes the apsides", () => {
    const a = EARTH.radius + 800e3;
    const crit = Math.acos(Math.sqrt(1 / 5)); // 5cos²i − 1 = 0
    expect(Math.abs(j2Rates(EARTH.mu, j2RefRadius(EARTH), EARTH.J2!, a, 0.01, crit).periDot)).toBeLessThan(1e-12);
    // Below the critical inclination the apsides advance; above, they regress.
    expect(j2Rates(EARTH.mu, j2RefRadius(EARTH), EARTH.J2!, a, 0.01, 30 * DEG).periDot).toBeGreaterThan(0);
    expect(j2Rates(EARTH.mu, j2RefRadius(EARTH), EARTH.J2!, a, 0.01, 80 * DEG).periDot).toBeLessThan(0);
  });
  it("a spherical body (no J2) produces no precession", () => {
    const moon = BODY_BY_ID.get("io")!; // a moon with no J2 set
    expect(moon.J2).toBeUndefined();
    const r = j2Rates(moon.mu, moon.radius, moon.J2 ?? 0, moon.radius + 1e5, 0, 0.5);
    expect(r.nodeDot).toBe(0);
  });
});

describe("sun-synchronous orbits", () => {
  it("a ~700 km Earth orbit is sun-synchronous near 98°", () => {
    const i = sunSyncInclination(EARTH.mu, j2RefRadius(EARTH), EARTH.J2!, EARTH.radius + 700e3)!;
    expect(i * RAD).toBeGreaterThan(97);
    expect(i * RAD).toBeLessThan(99);
  });
  it("the sun-sync inclination genuinely cancels the ~1 rev/yr solar drift", () => {
    const a = EARTH.radius + 700e3;
    const i = sunSyncInclination(EARTH.mu, j2RefRadius(EARTH), EARTH.J2!, a)!;
    const nodeDot = j2Rates(EARTH.mu, j2RefRadius(EARTH), EARTH.J2!, a, 0, i).nodeDot;
    // Eastward ~0.9856°/day (360° / 365.25 d) — matches the Sun's apparent motion.
    expect(degPerDay(nodeDot)).toBeCloseTo(360 / 365.25, 2);
  });
});

describe("J2 is referenced to the EQUATORIAL radius, not the mean radius", () => {
  it("a J2 body's rate uses its equatorial radius (Saturn: ~7.1% vs mean)", () => {
    const sat = BODY_BY_ID.get("saturn")!;
    expect(sat.equatorialRadius).toBe(60268000); // 60268 km, not the 58232 km mean
    const a = sat.radius + 1e6, e = 0.01, inc = 45 * DEG;
    const eq = j2Rates(sat.mu, sat.equatorialRadius!, sat.J2!, a, e, inc);
    const mean = j2Rates(sat.mu, sat.radius, sat.J2!, a, e, inc);
    const prod = j2Rates(sat.mu, j2RefRadius(sat), sat.J2!, a, e, inc);
    // Production must compute the equatorial-radius value...
    expect(prod.nodeDot).toBe(eq.nodeDot);
    expect(prod.periDot).toBe(eq.periDot);
    // ...which is ~7.1% larger in magnitude than the (wrong) mean-radius value.
    expect(Math.abs(eq.nodeDot / mean.nodeDot) - 1).toBeCloseTo(0.0711, 3);
  });
  it("Jupiter's rate is ~4.6% larger with the equatorial radius", () => {
    const jup = BODY_BY_ID.get("jupiter")!;
    expect(jup.equatorialRadius).toBe(71492000);
    const a = jup.radius + 1e6, e = 0.01, inc = 30 * DEG;
    const eq = j2Rates(jup.mu, jup.equatorialRadius!, jup.J2!, a, e, inc);
    const mean = j2Rates(jup.mu, jup.radius, jup.J2!, a, e, inc);
    expect(Math.abs(eq.nodeDot / mean.nodeDot) - 1).toBeCloseTo(0.0457, 3);
  });
  it("every body that carries a J2 also defines an equatorial radius ≥ its mean", () => {
    for (const b of BODIES) {
      if (b.J2 === undefined) continue;
      expect(b.equatorialRadius).toBeDefined();
      expect(b.equatorialRadius!).toBeGreaterThanOrEqual(b.radius);
    }
  });
  it("a body with no equatorial radius falls back to mean radius", () => {
    expect(j2RefRadius({ radius: 123 })).toBe(123);
    expect(j2RefRadius({ radius: 123, equatorialRadius: 456 })).toBe(456);
  });
});

describe("J2 precesses ship orbits while conserving size, shape, energy", () => {
  it("a coasting LEO orbit's node drifts but a/e/i and energy are unchanged", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign()); // 400 km, 28.5°
    const ship = sim.world.ships.get(id)!;
    const e0 = shipOsculatingElements(ship, 0);
    const e5 = shipOsculatingElements(ship, 5 * DAY);
    // Node regressed several degrees over 5 days; a, e, i held.
    const dNode = Math.abs((e5.Omega - e0.Omega) * RAD);
    expect(dNode).toBeGreaterThan(10);
    expect(e5.a).toBeCloseTo(e0.a, 3);
    expect(e5.e).toBeCloseTo(e0.e, 6);
    expect(e5.i).toBeCloseTo(e0.i, 9);
    expect(specificEnergy(EARTH.mu, e5.a)).toBeCloseTo(specificEnergy(EARTH.mu, e0.a), 3);
  });
});
