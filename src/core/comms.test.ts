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
