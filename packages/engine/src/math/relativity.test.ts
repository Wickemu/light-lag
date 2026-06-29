import { describe, it, expect } from "vitest";
import { properToCoordinateAccel } from "./relativity.ts";
import { C } from "../constants.ts";
import { length } from "./vec3.ts";

describe("properToCoordinateAccel", () => {
  it("reduces to the proper force at v ≪ c (Newtonian limit)", () => {
    const v = { x: 7700, y: 0, z: 0 }; // LEO speed — β ≈ 2.6e-5
    const aProper = { x: 3, y: -2, z: 1 };
    const a = properToCoordinateAccel(v, aProper);
    expect(a.x).toBeCloseTo(aProper.x, 6);
    expect(a.y).toBeCloseTo(aProper.y, 6);
    expect(a.z).toBeCloseTo(aProper.z, 6);
  });

  it("at v = 0 returns the proper force exactly", () => {
    const a = properToCoordinateAccel({ x: 0, y: 0, z: 0 }, { x: 5, y: 6, z: 7 });
    expect(a).toEqual({ x: 5, y: 6, z: 7 });
  });

  it("a longitudinal force is scaled by 1/γ³", () => {
    const beta = 0.6, gamma = 1.25; // 1/√(1−0.36)
    const v = { x: beta * C, y: 0, z: 0 };
    const a = properToCoordinateAccel(v, { x: 10, y: 0, z: 0 });
    expect(a.x).toBeCloseTo(10 / gamma ** 3, 9);
    expect(a.y).toBe(0);
    expect(a.z).toBe(0);
  });

  it("a transverse force is scaled by 1/γ² (proper acceleration, not the lab-force 1/γ)", () => {
    const beta = 0.6, gamma = 1.25;
    const v = { x: beta * C, y: 0, z: 0 };
    const a = properToCoordinateAccel(v, { x: 0, y: 10, z: 0 });
    expect(a.x).toBeCloseTo(0, 9);
    expect(a.y).toBeCloseTo(10 / gamma ** 2, 9); // 6.4, NOT 10/γ = 8
    expect(a.z).toBe(0);
  });

  it("a mixed force splits into α∥/γ³ + α⊥/γ² (Rindler)", () => {
    const beta = 0.8, gamma = 1 / Math.sqrt(1 - 0.64); // 5/3
    const v = { x: beta * C, y: 0, z: 0 };
    const aProper = { x: 7, y: 11, z: -4 }; // x is longitudinal, y/z transverse
    const a = properToCoordinateAccel(v, aProper);
    expect(a.x).toBeCloseTo(7 / gamma ** 3, 6);
    expect(a.y).toBeCloseTo(11 / gamma ** 2, 6);
    expect(a.z).toBeCloseTo(-4 / gamma ** 2, 6);
  });

  it("clamps a superluminal intermediate state instead of returning NaN", () => {
    const v = { x: 1.5 * C, y: 0, z: 0 }; // |v| > c (a pathological RK4 sub-step)
    const a = properToCoordinateAccel(v, { x: 10, y: 10, z: 0 });
    expect(Number.isFinite(a.x)).toBe(true);
    expect(Number.isFinite(a.y)).toBe(true);
  });

  it("integrating a constant proper force never reaches c (asymptotic, not linear)", () => {
    // Hyperbolic motion: a huge constant proper acceleration, stepped for a long
    // time — coordinate speed must approach but never reach c.
    const aProper = { x: 50, y: 0, z: 0 }; // ~5g
    let v = { x: 0, y: 0, z: 0 };
    const dt = 1e5; // s
    for (let i = 0; i < 100000; i++) {
      const a = properToCoordinateAccel(v, aProper);
      v = { x: v.x + a.x * dt, y: v.y + a.y * dt, z: v.z + a.z * dt };
    }
    expect(length(v)).toBeLessThan(C);
    expect(length(v)).toBeGreaterThan(0.9 * C); // a·t/c ≫ 1 → ultra-relativistic
  });
});
