import { describe, it, expect } from "vitest";
import { j2Rates, sunSyncInclination, specificEnergy } from "./orbit.ts";
import { createWorld } from "./world.ts";
import { Simulation } from "./sim.ts";
import { spawnShip, defaultDesign } from "../app/commands.ts";
import { shipOsculatingElements } from "./ships.ts";
import { BODY_BY_ID, DAY, DEG, RAD } from "./constants.ts";

const EARTH = BODY_BY_ID.get("earth")!;
const degPerDay = (radPerSec: number) => radPerSec * RAD * DAY;

describe("J2 secular precession rates match reality", () => {
  it("an ISS-like orbit regresses its node ~5°/day westward", () => {
    const a = EARTH.radius + 400e3;
    const r = j2Rates(EARTH.mu, EARTH.radius, EARTH.J2!, a, 0.0005, 51.6 * DEG);
    expect(degPerDay(r.nodeDot)).toBeLessThan(-4.7); // westward (negative)
    expect(degPerDay(r.nodeDot)).toBeGreaterThan(-5.3);
  });
  it("a polar orbit has no nodal regression", () => {
    const a = EARTH.radius + 600e3;
    expect(Math.abs(j2Rates(EARTH.mu, EARTH.radius, EARTH.J2!, a, 0, 90 * DEG).nodeDot)).toBeLessThan(1e-12);
  });
  it("the critical inclination (~63.43°) freezes the apsides", () => {
    const a = EARTH.radius + 800e3;
    const crit = Math.acos(Math.sqrt(1 / 5)); // 5cos²i − 1 = 0
    expect(Math.abs(j2Rates(EARTH.mu, EARTH.radius, EARTH.J2!, a, 0.01, crit).periDot)).toBeLessThan(1e-12);
    // Below the critical inclination the apsides advance; above, they regress.
    expect(j2Rates(EARTH.mu, EARTH.radius, EARTH.J2!, a, 0.01, 30 * DEG).periDot).toBeGreaterThan(0);
    expect(j2Rates(EARTH.mu, EARTH.radius, EARTH.J2!, a, 0.01, 80 * DEG).periDot).toBeLessThan(0);
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
    const i = sunSyncInclination(EARTH.mu, EARTH.radius, EARTH.J2!, EARTH.radius + 700e3)!;
    expect(i * RAD).toBeGreaterThan(97);
    expect(i * RAD).toBeLessThan(99);
  });
  it("the sun-sync inclination genuinely cancels the ~1 rev/yr solar drift", () => {
    const a = EARTH.radius + 700e3;
    const i = sunSyncInclination(EARTH.mu, EARTH.radius, EARTH.J2!, a)!;
    const nodeDot = j2Rates(EARTH.mu, EARTH.radius, EARTH.J2!, a, 0, i).nodeDot;
    // Eastward ~0.9856°/day (360° / 365.25 d) — matches the Sun's apparent motion.
    expect(degPerDay(nodeDot)).toBeCloseTo(360 / 365.25, 2);
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
