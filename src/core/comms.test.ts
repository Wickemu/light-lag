import { describe, it, expect } from "vitest";
import { lightTime, signalArrival, retardedTime } from "./comms.ts";
import { bodyState } from "./ephemeris.ts";
import { BODY_BY_ID, C, AU } from "./constants.ts";

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
