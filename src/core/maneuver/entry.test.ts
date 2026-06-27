import { describe, it, expect } from "vitest";
import {
  entryTrajectory, aerocapture, suttonGravesFlux, wallTemp, entryInterfaceAlt,
  type EntryVehicle,
} from "./entry.ts";
import { hyperbolicBurnDv } from "../orbit.ts";
import { BODY_BY_ID, DEG, G0, SIGMA } from "../constants.ts";

const EARTH = BODY_BY_ID.get("earth")!;
const MARS = BODY_BY_ID.get("mars")!;
const MOON = BODY_BY_ID.get("moon")!;

// An Apollo-class blunt capsule (lunar-return ballistic entry).
const APOLLO: EntryVehicle = { noseRadius: 4.7, ballisticCoef: 350, emissivity: 0.85 };
// An MSL-class Mars entry capsule.
const MSL: EntryVehicle = { noseRadius: 1.25, ballisticCoef: 115, emissivity: 0.85 };

describe("Sutton-Graves heating + wall temperature", () => {
  it("convective flux scales as v³ and 1/√(nose radius)", () => {
    const k = 1.7415e-4;
    expect(suttonGravesFlux(k, 1e-3, 1, 2000)).toBeCloseTo(8 * suttonGravesFlux(k, 1e-3, 1, 1000), 6);
    const big = suttonGravesFlux(k, 1e-3, 1, 5000);
    const small = suttonGravesFlux(k, 1e-3, 4, 5000); // 4× nose radius → half the flux
    expect(small).toBeCloseTo(big / 2, 6);
  });
  it("wall temperature inverts the radiative-equilibrium balance εσT⁴ = q", () => {
    const q = 0.85 * SIGMA * 3000 ** 4;
    expect(wallTemp(q, 0.85)).toBeCloseTo(3000, 6);
  });
  it("the interface sits at 11 scale heights (drag above it negligible)", () => {
    expect(entryInterfaceAlt(EARTH)).toBeCloseTo(11 * EARTH.atmosphere!.scaleHeight, 6);
    expect(entryInterfaceAlt(MOON)).toBe(0); // airless: no interface
  });
});

describe("ballistic entry trajectory", () => {
  it("an Apollo-class lunar-return entry (~11 km/s) lands, hot and high-g", () => {
    const r = entryTrajectory(EARTH, APOLLO, { entrySpeed: 11100, flightPathAngle: 6.5 * DEG })!;
    expect(r.outcome).toBe("landed");
    // A purely ballistic entry is harsh — the real capsule flew a lifting entry to
    // hold ~6–7 g; ballistic at this speed is tens of g.
    expect(r.peakDecelG).toBeGreaterThan(15);
    expect(r.peakDecelG).toBeLessThan(35);
    // Stagnation convective flux of order a few MW/m²; wall temp ~2.5–3 kK.
    expect(r.peakHeatFlux).toBeGreaterThan(1e6);
    expect(r.peakHeatFlux).toBeLessThan(5e6);
    expect(r.peakWallTemp).toBeGreaterThan(2200);
    expect(r.peakWallTemp).toBeLessThan(3200);
    // Integrated heat load (TPS sizing) of order tens–hundreds of MJ/m².
    expect(r.heatLoad).toBeGreaterThan(1e7);
    expect(r.heatLoad).toBeLessThan(1e9);
    expect(r.peakFluxAlt).toBeGreaterThan(0);
  });

  it("peak deceleration is ballistic-coefficient-independent (Allen-Eggers)", () => {
    // Allen-Eggers: a_peak = v_E²·sinγ_E / (2eH), independent of β. Two very
    // different ballistic coefficients agree, and both sit near the closed form.
    const g = 20 * DEG, vE = 8000, H = EARTH.atmosphere!.scaleHeight;
    const blunt = entryTrajectory(EARTH, { noseRadius: 2, ballisticCoef: 100 }, { entrySpeed: vE, flightPathAngle: g })!;
    const slender = entryTrajectory(EARTH, { noseRadius: 2, ballisticCoef: 400 }, { entrySpeed: vE, flightPathAngle: g })!;
    expect(blunt.peakDecelG).toBeCloseTo(slender.peakDecelG, 0); // β-independent
    const allenEggers = (vE * vE * Math.sin(g)) / (2 * Math.E * H) / G0;
    expect(blunt.peakDecelG).toBeGreaterThan(allenEggers * 0.85);
    expect(blunt.peakDecelG).toBeLessThan(allenEggers * 1.15);
  });

  it("a too-shallow hyperbolic entry skips back out still unbound", () => {
    const slender: EntryVehicle = { noseRadius: 2, ballisticCoef: 2000 };
    const r = entryTrajectory(EARTH, slender, { entrySpeed: 12000, flightPathAngle: 0.5 * DEG })!;
    expect(r.outcome).toBe("skip-out");
    expect(r.exitEnergy).toBeGreaterThan(0); // leaves unbound
    expect(r.exitSpeed).toBeGreaterThan(11000); // barely braked
  });

  it("a steeper entry is harsher than a shallow one (more g, more heating)", () => {
    const shallow = entryTrajectory(EARTH, APOLLO, { entrySpeed: 9000, flightPathAngle: 3 * DEG })!;
    const steep = entryTrajectory(EARTH, APOLLO, { entrySpeed: 9000, flightPathAngle: 20 * DEG })!;
    expect(steep.peakDecelG).toBeGreaterThan(shallow.peakDecelG);
    expect(steep.peakHeatFlux).toBeGreaterThan(shallow.peakHeatFlux);
  });

  it("Mars EDL (CO₂, ~6 km/s) lands; CO₂ convects cooler than air for the same flow", () => {
    const r = entryTrajectory(MARS, MSL, { entrySpeed: 6000, flightPathAngle: 15 * DEG })!;
    expect(r.outcome).toBe("landed");
    expect(r.peakDecelG).toBeGreaterThan(8);
    expect(r.peakDecelG).toBeLessThan(18);
    expect(r.peakHeatFlux).toBeGreaterThan(2e5);
    expect(r.peakHeatFlux).toBeLessThan(1.5e6);
    // Same vehicle/trajectory, air heating coefficient → higher flux than CO₂.
    const air = entryTrajectory(MARS, { ...MSL, suttonGravesK: 1.7415e-4 }, { entrySpeed: 6000, flightPathAngle: 15 * DEG })!;
    expect(air.peakHeatFlux).toBeGreaterThan(r.peakHeatFlux);
  });

  it("returns null for an airless body", () => {
    expect(entryTrajectory(MOON, APOLLO, { entrySpeed: 2000, flightPathAngle: 10 * DEG })).toBeNull();
  });
});

describe("aerocapture", () => {
  it("captures a hyperbolic Mars arrival, saving nearly the whole capture burn", () => {
    const ac = aerocapture(MARS, MSL, { vInf: 2500, targetApoAlt: 33000e3, targetPeriAlt: 250e3 })!;
    expect(ac.feasible).toBe(true);
    expect(ac.entry.outcome).toBe("captured"); // single pass, now bound
    expect(ac.dvSaved).toBeGreaterThan(0);
    expect(ac.dvSaved).toBeGreaterThan(0.9 * ac.dvPropulsive); // most of the burn avoided
    expect(ac.trimDv).toBeLessThan(200); // only a small periapsis-raise remains
    // The solved apoapsis matches the requested capture orbit.
    expect(ac.apoapsisAlt / 1000).toBeCloseTo(33000, -1);
    // The propulsive baseline it compares against is the Oberth capture burn.
    expect(ac.dvPropulsive).toBeCloseTo(hyperbolicBurnDv(2500, MARS.mu, MARS.radius + 250e3), 0);
  });

  it("captures an Earth arrival into a GEO-apoapsis orbit", () => {
    const ac = aerocapture(EARTH, { noseRadius: 4, ballisticCoef: 150, emissivity: 0.85 }, { vInf: 3000, targetApoAlt: 35786e3, targetPeriAlt: 300e3 })!;
    expect(ac.feasible).toBe(true);
    expect(ac.dvSaved).toBeGreaterThan(0);
    expect(ac.apoapsisAlt / 1000).toBeCloseTo(35786, -1);
  });

  it("reports infeasible when a fast slender arrival never sheds enough to capture", () => {
    const ac = aerocapture(MARS, { noseRadius: 1.25, ballisticCoef: 2000 }, { vInf: 9000, targetApoAlt: 5000e3 })!;
    expect(ac.feasible).toBe(false);
    expect(ac.reason).toBeDefined();
  });

  it("returns null for an airless body", () => {
    expect(aerocapture(MOON, MSL, { vInf: 2000, targetApoAlt: 1000e3 })).toBeNull();
  });
});
