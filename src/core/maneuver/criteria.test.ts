import { describe, it, expect } from "vitest";
import { score, better, BALANCED_TIME_WEIGHT, type Scorable, type Criterion } from "./criteria.ts";

const A: Scorable = { dvTotal: 6000, tof: 400 * 86400 }; // cheap but slow
const B: Scorable = { dvTotal: 9000, tof: 200 * 86400 }; // dear but fast
const refs = { dvRef: 6000, tofRef: 400 * 86400 };

describe("trajectory-selection criteria", () => {
  it("min-Δv picks the cheaper route, min-time picks the faster", () => {
    expect(better(A, B, "dv", refs)).toBe(true); // A is cheaper
    expect(better(B, A, "dv", refs)).toBe(false);
    expect(better(B, A, "time", refs)).toBe(true); // B is faster
    expect(better(A, B, "time", refs)).toBe(false);
  });

  it("balanced normalizes Δv and time to the reference and weights them with k", () => {
    // A is the reference, so its balanced score is 1 + k·1 = 2.
    expect(score(A, "balanced", refs)).toBeCloseTo(1 + BALANCED_TIME_WEIGHT, 12);
    // B: 9000/6000 + 1·(200/400) = 1.5 + 0.5 = 2.0 — a genuine tie with A at k=1.
    expect(score(B, "balanced", refs)).toBeCloseTo(2.0, 12);
    // Doubling the time weight makes the slow route (A) score worse than the fast one (B).
    const heavy = { ...refs, k: 2 };
    expect(score(A, "balanced", heavy)).toBeGreaterThan(score(B, "balanced", heavy));
    expect(better(B, A, "balanced", heavy)).toBe(true);
  });

  it("the ordering is a strict total order tie-broken on (score, Δv, tof)", () => {
    // Equal balanced score (the k=1 tie above) ⇒ break on Δv: A (6000) beats B (9000).
    expect(score(A, "balanced", refs)).toBeCloseTo(score(B, "balanced", refs), 12);
    expect(better(A, B, "balanced", refs)).toBe(true);
    expect(better(B, A, "balanced", refs)).toBe(false);
    // Identical candidates: neither is strictly better (irreflexive).
    expect(better(A, { ...A }, "dv", refs)).toBe(false);
  });

  it("picking the minimum is order-independent (deterministic winner)", () => {
    const set: Scorable[] = [
      { dvTotal: 7000, tof: 300 * 86400 },
      { dvTotal: 5000, tof: 500 * 86400 },
      { dvTotal: 5000, tof: 450 * 86400 }, // same Δv as above, shorter tof → should win on "dv" tie-break
      { dvTotal: 8000, tof: 250 * 86400 },
    ];
    const pickMin = (arr: Scorable[], crit: Criterion): Scorable =>
      arr.reduce((best, c) => (better(c, best, crit, refs) ? c : best));
    const reversed = [...set].reverse();
    for (const crit of ["dv", "time", "balanced"] as Criterion[]) {
      expect(pickMin(set, crit)).toEqual(pickMin(reversed, crit)); // same winner either way
    }
    // On "dv", the 5000/450d candidate wins (cheapest, then shortest among the ties).
    expect(pickMin(set, "dv")).toEqual({ dvTotal: 5000, tof: 450 * 86400 });
  });
});
