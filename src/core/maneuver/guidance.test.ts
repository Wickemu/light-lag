import { describe, it, expect } from "vitest";
import { solveBurnMagnitude } from "./guidance.ts";
import { circularSpeed, visVivaSpeed, apoapsisRadius, periapsisRadius } from "../orbit.ts";
import { stateToElements, elementsToState } from "../math/kepler.ts";
import { addScaled, type Vec3 } from "../math/vec3.ts";
import { BODY_BY_ID } from "../constants.ts";

const EARTH = BODY_BY_ID.get("earth")!;
const MU = EARTH.mu;
const LEO = EARTH.radius + 400e3;
const GEO = 42164e3;

/** A circular, equatorial (xy-plane) orbit at radius r — at the +x point moving +y. */
function circular(r: number): { r: Vec3; v: Vec3 } {
  return { r: { x: r, y: 0, z: 0 }, v: { x: 0, y: circularSpeed(MU, r), z: 0 } };
}

/** Apply an impulsive prograde Δv and return the resulting elements. */
function afterPrograde(r: Vec3, v: Vec3, dv: number) {
  // prograde = +v direction; for our circular start that is +y.
  const speed = Math.hypot(v.x, v.y, v.z);
  const hat = { x: v.x / speed, y: v.y / speed, z: v.z / speed };
  return stateToElements(r, addScaled(v, hat, dv), MU);
}

describe("solveBurnMagnitude — closed-loop trim", () => {
  it("raises apoapsis from circular LEO to GEO, matching the analytic Hohmann burn", () => {
    const { r, v } = circular(LEO);
    const s = solveBurnMagnitude(r, v, MU, "prograde", { kind: "apoapsis", rTarget: GEO }, 5000);
    expect(s).not.toBeNull();

    // Analytic first Hohmann burn from LEO toward a GEO apoapsis.
    const aT = (LEO + GEO) / 2;
    const dvHohmann = visVivaSpeed(MU, LEO, aT) - circularSpeed(MU, LEO);
    expect(s!).toBeCloseTo(dvHohmann, 0); // within ~1 m/s

    const el = afterPrograde(r, v, s!);
    expect(apoapsisRadius(el.a, el.e)).toBeCloseTo(GEO, -1); // within ~10 m at GEO scale
  });

  it("lowers periapsis with a retrograde burn", () => {
    // Start on a circular orbit at GEO, lower periapsis toward LEO.
    const { r, v } = circular(GEO);
    const s = solveBurnMagnitude(r, v, MU, "retrograde", { kind: "periapsis", rTarget: LEO }, 5000);
    expect(s).not.toBeNull();
    const speed = Math.hypot(v.x, v.y, v.z);
    const hat = { x: -v.x / speed, y: -v.y / speed, z: -v.z / speed };
    const el = stateToElements(r, addScaled(v, hat, s!), MU);
    expect(periapsisRadius(el.a, el.e)).toBeCloseTo(LEO, -2); // within ~100 m
  });

  it("circularizes at apoapsis (drives e→0)", () => {
    // A GTO sampled AT apoapsis (r = GEO), moving prograde at apoapsis speed.
    const aT = (LEO + GEO) / 2;
    const vApo = visVivaSpeed(MU, GEO, aT);
    const r: Vec3 = { x: GEO, y: 0, z: 0 };
    const v: Vec3 = { x: 0, y: vApo, z: 0 };
    const s = solveBurnMagnitude(r, v, MU, "prograde", { kind: "circular" }, 5000);
    expect(s).not.toBeNull();
    // Should match the circularization burn vCircGEO − vApo.
    expect(s!).toBeCloseTo(circularSpeed(MU, GEO) - vApo, 0);
    const el = afterPrograde(r, v, s!);
    expect(el.e).toBeLessThan(1e-3);
    expect(el.a).toBeCloseTo(GEO, -2);
  });

  it("returns null when circularization is geometrically impossible (off-apsis)", () => {
    // A GTO sampled OFF the apsides (M = 1 rad): no single retrograde Δv yields e≈0.
    const aT = (LEO + GEO) / 2;
    const e = (GEO - LEO) / (GEO + LEO);
    const { r, v } = elementsToState({ a: aT, e, i: 0, Omega: 0, omega: 0, M: 1 }, MU);
    const s = solveBurnMagnitude(r, v, MU, "retrograde", { kind: "circular" }, 5000);
    expect(s).toBeNull();
  });

  it("returns null when the goal is unreachable within the correction cap", () => {
    const { r, v } = circular(LEO);
    // Raising apoapsis to GEO needs ~2.4 km/s; a 100 m/s cap can't.
    const s = solveBurnMagnitude(r, v, MU, "prograde", { kind: "apoapsis", rTarget: GEO }, 100);
    expect(s).toBeNull();
  });

  it("hits a target semi-major axis", () => {
    const { r, v } = circular(LEO);
    const aTarget = 2 * LEO;
    const s = solveBurnMagnitude(r, v, MU, "prograde", { kind: "sma", aTarget }, 5000);
    expect(s).not.toBeNull();
    const el = afterPrograde(r, v, s!);
    expect(el.a).toBeCloseTo(aTarget, -2);
  });

  it("returns 0 when the orbit already meets the goal", () => {
    const { r, v } = circular(LEO);
    // Already circular at LEO ⇒ circular goal needs no burn.
    expect(solveBurnMagnitude(r, v, MU, "prograde", { kind: "circular" }, 5000)).toBe(0);
  });

  it("is deterministic and repeatable (identical f64 across calls)", () => {
    const { r, v } = circular(LEO);
    const a = solveBurnMagnitude(r, v, MU, "prograde", { kind: "apoapsis", rTarget: GEO }, 5000);
    const b = solveBurnMagnitude(r, v, MU, "prograde", { kind: "apoapsis", rTarget: GEO }, 5000);
    expect(a).toBe(b);
  });

  it("rejects a non-positive cap", () => {
    const { r, v } = circular(LEO);
    expect(solveBurnMagnitude(r, v, MU, "prograde", { kind: "apoapsis", rTarget: GEO }, 0)).toBeNull();
  });
});
