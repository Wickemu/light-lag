import { describe, it, expect } from "vitest";
import { lightTime, signalArrival, retardedTime, dopplerFactor, redshiftZ, shiftedWavelength } from "./comms.ts";
import { bodyState } from "./ephemeris.ts";
import { BODY_BY_ID, C, AU } from "./constants.ts";

const ZERO = { x: 0, y: 0, z: 0 };
// Standard line of sight: emitter at origin, observer down the +x axis. n̂ = +x̂.
const FROM = ZERO;
const TO = { x: AU, y: 0, z: 0 };

const earth = BODY_BY_ID.get("earth")!;
const mars = BODY_BY_ID.get("mars")!;

describe("light-time", () => {
  it("1 AU is ~499 light-seconds (8.3 min)", () => {
    const lt = lightTime({ x: 0, y: 0, z: 0 }, { x: AU, y: 0, z: 0 });
    expect(lt).toBeCloseTo(AU / C, 6);
    expect(lt / 60).toBeGreaterThan(8.2);
    expect(lt / 60).toBeLessThan(8.4);
  });

  it("Earth–Mars one-way light-time stays within the real 3–22 minute band", () => {
    let min = Infinity, max = 0;
    for (let d = 0; d < 800; d += 10) {
      const t = d * 86400;
      const lt = lightTime(bodyState(earth, t).r, bodyState(mars, t).r) / 60;
      min = Math.min(min, lt);
      max = Math.max(max, lt);
    }
    expect(min).toBeGreaterThan(2.5);
    expect(min).toBeLessThan(8);
    expect(max).toBeGreaterThan(15);
    expect(max).toBeLessThan(24);
  });
});

describe("signal propagation at c", () => {
  it("signalArrival to a fixed point is tEmit + distance/c", () => {
    const tArr = signalArrival({ x: 0, y: 0, z: 0 }, () => ({ x: AU, y: 0, z: 0 }), 1000);
    expect(tArr - 1000).toBeCloseTo(AU / C, 3);
  });

  it("retardedTime to a fixed point is t − distance/c", () => {
    const tRet = retardedTime({ x: 0, y: 0, z: 0 }, () => ({ x: AU, y: 0, z: 0 }), 1e6);
    expect(1e6 - tRet).toBeCloseTo(AU / C, 3);
  });

  it("light has to chase a receding target (arrival later than the static estimate)", () => {
    const posFn = (t: number) => ({ x: AU + 50_000 * t, y: 0, z: 0 }); // recedes at 50 km/s
    const tArr = signalArrival({ x: 0, y: 0, z: 0 }, posFn, 0);
    expect(tArr).toBeGreaterThan(AU / C);
  });
});

describe("convergence at relativistic speed", () => {
  // A target receding radially at constant v from x0 (at t=0) has an EXACT
  // light-cone solution: a signal from the origin reaches it at x0/(c − v), and
  // its retarded time as seen at the origin at t is (c·t − x0)/(c + v). The old
  // fixed-point iteration contracted at rate v/c and stalled near c; the bracketed
  // solver must hit these closed forms even at 0.95c and 0.99c.
  for (const beta of [0.5, 0.95, 0.99]) {
    const v = beta * C;
    const x0 = AU;
    const posFn = (t: number) => ({ x: x0 + v * t, y: 0, z: 0 });

    it(`signalArrival matches x0/(c−v) at β=${beta}`, () => {
      const exact = x0 / (C - v);
      const tArr = signalArrival({ x: 0, y: 0, z: 0 }, posFn, 0);
      expect(Math.abs(tArr - exact)).toBeLessThan(1e-2);
      // Sanity: a 0.95c recession stretches the delay ~20× over the static hop.
      expect(tArr).toBeGreaterThan(AU / C);
    });

    it(`retardedTime matches (c·t−x0)/(c+v) at β=${beta}`, () => {
      const t = 1e7;
      const exact = (C * t - x0) / (C + v);
      const tRet = retardedTime({ x: 0, y: 0, z: 0 }, posFn, t);
      expect(Math.abs(tRet - exact)).toBeLessThan(1e-2);
      expect(tRet).toBeLessThan(t); // genuinely in the past
    });
  }

  it("residual is driven to the tolerance, not silently left unconverged", () => {
    const v = 0.97 * C;
    const posFn = (t: number) => ({ x: AU + v * t, y: 0, z: 0 });
    const tArr = signalArrival({ x: 0, y: 0, z: 0 }, posFn, 0);
    const residual = tArr - (lightTime({ x: 0, y: 0, z: 0 }, posFn(tArr)));
    expect(Math.abs(residual)).toBeLessThan(1e-2); // t == |pos(t)|/c at the solution
  });

  it("reports Infinity when light can never catch the target (recession ≥ c)", () => {
    const posFn = (t: number) => ({ x: AU + C * t, y: 0, z: 0 }); // recedes at exactly c
    const tArr = signalArrival({ x: 0, y: 0, z: 0 }, posFn, 0);
    expect(tArr).toBe(Infinity);
  });
});

describe("Doppler shift of signals", () => {
  it("no relative motion ⇒ no shift (factor 1, z 0)", () => {
    expect(dopplerFactor(ZERO, ZERO, FROM, TO)).toBeCloseTo(1, 12);
    expect(redshiftZ(1)).toBeCloseTo(0, 12);
  });

  it("classical limit: a slow emitter receding reddens by ~1 − v/c", () => {
    const v = 30_000; // 30 km/s ≈ Earth's orbital speed, ≪ c
    // Emitter moving in −x̂ (away from the +x observer): redshift.
    const factor = dopplerFactor({ x: -v, y: 0, z: 0 }, ZERO, FROM, TO);
    expect(factor).toBeCloseTo(1 - v / C, 7); // exact form adds the γ term ~½(v/c)²≈5e-9
    expect(redshiftZ(factor)).toBeGreaterThan(0);
  });

  it("a slow emitter approaching blueshifts (factor > 1, z < 0)", () => {
    const v = 30_000;
    const factor = dopplerFactor({ x: v, y: 0, z: 0 }, ZERO, FROM, TO); // toward observer
    expect(factor).toBeCloseTo(1 + v / C, 7); // exact form adds the γ term ~½(v/c)²≈5e-9
    expect(redshiftZ(factor)).toBeLessThan(0);
  });

  it("transverse motion still reddens by 1/γ (pure time dilation, no classical term)", () => {
    const v = 0.6 * C; // emitter crosses the line of sight (along ŷ): n̂·β = 0
    const factor = dopplerFactor({ x: 0, y: v, z: 0 }, ZERO, FROM, TO);
    const gamma = 1 / Math.sqrt(1 - 0.6 * 0.6); // = 1.25
    expect(factor).toBeCloseTo(1 / gamma, 12); // 0.8 — a redshift with zero radial speed
  });

  it("relativistic longitudinal recession matches √((1−β)/(1+β))", () => {
    for (const beta of [0.5, 0.9, 0.95]) {
      const factor = dopplerFactor({ x: -beta * C, y: 0, z: 0 }, ZERO, FROM, TO);
      expect(factor).toBeCloseTo(Math.sqrt((1 - beta) / (1 + beta)), 10);
    }
  });

  it("the factor is reciprocal under swapping emitter and observer velocity (approach↔recede)", () => {
    const v = { x: 0.3 * C, y: 0, z: 0 };
    const approach = dopplerFactor(v, ZERO, FROM, TO); // emitter chasing the photon: blueshift
    const recede = dopplerFactor(ZERO, v, FROM, TO); // observer fleeing the photon: redshift
    expect(approach * recede).toBeCloseTo(1, 10); // symmetric Doppler pair
  });

  it("wavelength shifts inversely to frequency: a redshift stretches 10 µm", () => {
    const factor = 0.5; // f halved
    expect(shiftedWavelength(10e-6, factor)).toBeCloseTo(20e-6, 12); // λ doubled
    expect(redshiftZ(factor)).toBeCloseTo(1, 12); // z = 1
  });
});
