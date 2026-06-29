import { describe, it, expect } from "vitest";
import {
  lagrangeStateRelative, lagrangeState, lagrangeEligible, lagrangeCentral, collinearRatio,
} from "./lagrange.ts";
import { BODY_BY_ID, MU_SUN } from "../constants.ts";
import { bodyStateRelative } from "../ephemeris.ts";
import { length, sub, dot } from "../math/vec3.ts";

const EARTH = BODY_BY_ID.get("earth")!;
const MOON = BODY_BY_ID.get("moon")!;

describe("collinear ratio ξ = ∛(μ₂/3μ₁)", () => {
  it("is ~0.01 for Sun–Earth and ~0.16 for Earth–Moon", () => {
    expect(collinearRatio(MU_SUN, EARTH.mu)).toBeCloseTo(0.01, 3);
    expect(collinearRatio(EARTH.mu, MOON.mu)).toBeGreaterThan(0.15);
    expect(collinearRatio(EARTH.mu, MOON.mu)).toBeLessThan(0.17);
  });
});

describe("Sun–Earth Lagrange points (keyed off Earth)", () => {
  const t = 0;
  const earthRel = bodyStateRelative(EARTH, t); // Earth relative to the Sun

  it("L1 sits ~1.5 million km sunward of Earth", () => {
    const l1 = lagrangeStateRelative(EARTH, "L1", t);
    const d = length(sub(l1.r, earthRel.r));
    expect(d).toBeGreaterThan(1.4e9);
    expect(d).toBeLessThan(1.6e9);
    expect(length(l1.r)).toBeLessThan(length(earthRel.r)); // inside Earth's orbit
  });

  it("L2 sits ~1.5 million km anti-sunward of Earth (the JWST point)", () => {
    const l2 = lagrangeStateRelative(EARTH, "L2", t);
    const d = length(sub(l2.r, earthRel.r));
    expect(d).toBeGreaterThan(1.4e9);
    expect(d).toBeLessThan(1.6e9);
    expect(length(l2.r)).toBeGreaterThan(length(earthRel.r)); // outside Earth's orbit
  });

  it("L3 sits on the far side of the Sun, just beyond Earth's orbital radius", () => {
    const l3 = lagrangeStateRelative(EARTH, "L3", t);
    expect(dot(l3.r, earthRel.r)).toBeLessThan(0); // opposite side of the Sun
    expect(length(l3.r)).toBeGreaterThan(length(earthRel.r));
    expect(length(l3.r)).toBeLessThan(1.01 * length(earthRel.r)); // only slightly beyond
  });

  it("L4/L5 are equilateral: same radius as Earth, 60° ahead/behind, same speed", () => {
    const l4 = lagrangeStateRelative(EARTH, "L4", t);
    const l5 = lagrangeStateRelative(EARTH, "L5", t);
    expect(length(l4.r)).toBeCloseTo(length(earthRel.r), -3); // same radius (within ~km)
    expect(length(l4.v)).toBeCloseTo(length(earthRel.v), 0); // same speed
    const cos = dot(l4.r, earthRel.r) / (length(l4.r) * length(earthRel.r));
    expect(cos).toBeCloseTo(0.5, 3); // 60°
    // L4 leads, L5 trails: opposite signs of the cross-product component along the orbit normal.
    const ahead = l4.r.x * earthRel.r.y - l4.r.y * earthRel.r.x;
    const behind = l5.r.x * earthRel.r.y - l5.r.y * earthRel.r.x;
    expect(Math.sign(ahead)).toBe(-Math.sign(behind));
  });

  it("lagrangeState is heliocentric-absolute (Earth's primary is the root Sun)", () => {
    const rel = lagrangeStateRelative(EARTH, "L2", t);
    const abs = lagrangeState(EARTH, "L2", t);
    expect(abs.r.x).toBeCloseTo(rel.r.x, 6); // Sun at the root origin ⇒ relative == absolute
  });
});

describe("Earth–Moon Lagrange points (keyed off the Moon)", () => {
  it("L1 sits ~58,000 km moonward of Earth (~326,000 km from Earth)", () => {
    const t = 0;
    const l1 = lagrangeStateRelative(MOON, "L1", t); // relative to Earth
    const moonRel = bodyStateRelative(MOON, t);
    const dEarth = length(l1.r);
    const dMoon = length(sub(l1.r, moonRel.r));
    expect(dEarth).toBeGreaterThan(3.0e8);
    expect(dEarth).toBeLessThan(3.5e8);
    expect(dMoon).toBeGreaterThan(5e7);
    expect(dMoon).toBeLessThan(7e7);
  });

  it("its cruise frame is geocentric and its absolute state is Earth-relative", () => {
    expect(lagrangeCentral(MOON)).toBe("earth");
    const abs = lagrangeState(MOON, "L4", 0);
    const earthAbs = length(bodyStateRelative(EARTH, 0).r); // Earth-Sun distance ~1 AU
    expect(length(abs.r)).toBeGreaterThan(0.5 * earthAbs); // includes Earth's heliocentric offset
  });
});

describe("eligibility & determinism", () => {
  it("offers L-points for any orbiting body but not the Sun", () => {
    expect(lagrangeEligible(EARTH)).toBe(true);
    expect(lagrangeEligible(MOON)).toBe(true);
    expect(lagrangeEligible(BODY_BY_ID.get("sun")!)).toBe(false);
  });

  it("a planet's L-points are heliocentric (no cruise central)", () => {
    expect(lagrangeCentral(EARTH)).toBeUndefined();
  });

  it("is a pure function of t — identical inputs give identical state", () => {
    const a = lagrangeState(EARTH, "L2", 12345);
    const b = lagrangeState(EARTH, "L2", 12345);
    expect(a.r).toEqual(b.r);
    expect(a.v).toEqual(b.v);
  });
});
