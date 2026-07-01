import { describe, it, expect } from "vitest";
import { type Ship } from "./world.ts";
import { type Stage } from "./propulsion.ts";
import { BODY_BY_ID } from "./constants.ts";
import {
  DEFAULT_ISRU_PLANT_W, bodyHasISRU, isruPowerW, isruRate,
  fillFromISRU, isruProduced, isruStatusOf,
} from "./isru.ts";

const MOON = BODY_BY_ID.get("moon")!;
const COMET = BODY_BY_ID.get("churyumov")!;
const MARS = BODY_BY_ID.get("mars")!;

/** A coasting ship about `primary` with the given stages (defaults to one part-drained tank). */
function ship(stages: Stage[], primary = "earth", a = 7.0e6): Ship {
  return {
    id: "s", name: "s", primary, mode: "coast",
    elements: { a, e: 0.001, i: 0.1, Omega: 0, omega: 0, M: 0 },
    epoch: 0, payloadMass: 1000, stages, activeStage: 0, tau: 0,
  };
}

describe("isru — body descriptor", () => {
  it("bodyHasISRU is true for a tagged volatile body and false for a dry one", () => {
    expect(bodyHasISRU(MOON)).toBe(true);
    expect(bodyHasISRU(COMET)).toBe(true);
    expect(bodyHasISRU(MARS)).toBe(false);
  });
});

describe("isru — power model", () => {
  it("falls back to the default plant power when the ship has no electric source", () => {
    const s = ship([{ name: "S1", dryMass: 1000, propMass: 4000, isp: 300, thrust: 1e5, propCapacity: 5000 }]);
    expect(isruPowerW(s, 0)).toBe(DEFAULT_ISRU_PLANT_W);
  });

  it("a nuclear-electric source delivers its rated power regardless of distance", () => {
    const nuke: Stage = { name: "ion", dryMass: 500, propMass: 200, isp: 3000, thrust: 1, propCapacity: 1000, electric: { powerW: 20_000, eta: 0.6, solar: false } };
    // Far from the Sun (a ~5 AU heliocentric orbit): a reactor is unmoved.
    expect(isruPowerW(ship([nuke], "sun", 5 * 1.495978707e11), 0)).toBeCloseTo(20_000, 6);
  });

  it("a solar-electric source derates as 1/r² far from the Sun", () => {
    const solar: Stage = { name: "pv", dryMass: 500, propMass: 200, isp: 3000, thrust: 1, propCapacity: 1000, electric: { powerW: 20_000, eta: 0.6, solar: true } };
    const near = isruPowerW(ship([solar], "earth"), 0); // ~1 AU
    const far = isruPowerW(ship([solar], "sun", 5 * 1.495978707e11), 0); // ~5 AU
    expect(near).toBeGreaterThan(far);
    expect(far).toBeLessThan(20_000); // starved far out
  });
});

describe("isru — rate formula", () => {
  it("rate = plant power / the body's specific extraction energy", () => {
    const s = ship([{ name: "S1", dryMass: 1000, propMass: 4000, isp: 300, thrust: 1e5, propCapacity: 5000 }]);
    // No electric source ⇒ default plant power, independent of position.
    expect(isruRate(s, MOON, 0)).toBeCloseTo(DEFAULT_ISRU_PLANT_W / MOON.isru!.specificEnergyJPerKg, 12);
    // Cheaper cometary ice ⇒ a faster rate than the Moon's dear cold-trap regolith.
    expect(isruRate(s, COMET, 0)).toBeGreaterThan(isruRate(s, MOON, 0));
  });

  it("a dry body yields a zero rate", () => {
    const s = ship([{ name: "S1", dryMass: 1000, propMass: 4000, isp: 300, thrust: 1e5, propCapacity: 5000 }]);
    expect(isruRate(s, MARS, 0)).toBe(0);
  });
});

describe("isru — tank fill", () => {
  it("adds propellant capped at headroom, active→tip, and conserves the amount", () => {
    const s = ship([
      { name: "S1", dryMass: 1000, propMass: 3000, isp: 300, thrust: 1e5, propCapacity: 5000 }, // 2000 room
      { name: "S2", dryMass: 500, propMass: 1000, isp: 340, thrust: 2e4, propCapacity: 4000 }, // 3000 room
    ]);
    const added = fillFromISRU(s, 2500); // fills S1's 2000 first, then 500 into S2
    expect(added).toBe(2500);
    expect(s.stages[0]!.propMass).toBe(5000); // S1 full
    expect(s.stages[1]!.propMass).toBe(1500); // 500 into S2
  });

  it("never over-fills: a request beyond headroom returns only the headroom", () => {
    const s = ship([{ name: "S1", dryMass: 1000, propMass: 3000, isp: 300, thrust: 1e5, propCapacity: 5000 }]);
    expect(fillFromISRU(s, 1e9)).toBe(2000); // only 2000 kg of headroom
    expect(s.stages[0]!.propMass).toBe(5000);
  });

  it("a full ship gains nothing", () => {
    const s = ship([{ name: "S1", dryMass: 1000, propMass: 5000, isp: 300, thrust: 1e5, propCapacity: 5000 }]);
    expect(fillFromISRU(s, 1000)).toBe(0);
    expect(s.stages[0]!.propMass).toBe(5000);
  });
});

describe("isru — produced-so-far & status", () => {
  const proc = { bodyId: "moon", tStart: 100, ratePerSec: 2, target: 1000 };

  it("isruProduced is rate·elapsed clamped to [0, target]", () => {
    expect(isruProduced(proc, 100)).toBe(0); // at start
    expect(isruProduced(proc, 150)).toBe(100); // 2 kg/s · 50 s
    expect(isruProduced(proc, 100 + 10_000)).toBe(1000); // clamped to target
    expect(isruProduced(proc, 50)).toBe(0); // before start ⇒ clamped to 0
  });

  it("isruStatusOf reports fraction/ETA and never mutates the ship", () => {
    const s = ship([{ name: "S1", dryMass: 1000, propMass: 4000, isp: 300, thrust: 1e5, propCapacity: 5000 }]);
    expect(isruStatusOf(s, 0)).toBeNull(); // not mining
    s.isru = { ...proc };
    const before = s.stages[0]!.propMass;
    const st = isruStatusOf(s, 150)!;
    expect(st.producedKg).toBe(100);
    expect(st.fraction).toBeCloseTo(0.1, 12);
    expect(st.etaS).toBeCloseTo((1000 - 100) / 2, 6);
    expect(s.stages[0]!.propMass).toBe(before); // pure read — no mutation
  });
});
