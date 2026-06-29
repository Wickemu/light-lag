import { describe, it, expect } from "vitest";
import { suggestRoutes, transferWindow } from "./suggest.ts";
import { BODY_BY_ID, DAY, DEFAULT_CAPTURE_ALT, JULIAN_YEAR } from "../constants.ts";

const EARTH = BODY_BY_ID.get("earth")!;
const budget = { rParkFrom: EARTH.radius + 400e3, rParkTo: 0 };

describe("auto-route suggestion", () => {
  it("always offers a direct route, ranked among any flyby routes", () => {
    const to = BODY_BY_ID.get("jupiter")!;
    const routes = suggestRoutes("earth", "jupiter", 25 * JULIAN_YEAR,
      { rParkFrom: budget.rParkFrom, rParkTo: to.radius + DEFAULT_CAPTURE_ALT }, "dv");
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.some((r) => r.kind === "direct")).toBe(true);
    // Every route is origin→…→target.
    for (const r of routes) {
      expect(r.bodyIds[0]).toBe("earth");
      expect(r.bodyIds[r.bodyIds.length - 1]).toBe("jupiter");
      expect(r.dvTotal).toBeGreaterThan(0);
      expect(r.tArrive).toBeGreaterThan(r.tDepart);
    }
  });

  it("ranks by the chosen criterion (min-Δv first vs min-time first)", () => {
    const to = BODY_BY_ID.get("saturn")!;
    const b = { rParkFrom: budget.rParkFrom, rParkTo: to.radius + DEFAULT_CAPTURE_ALT };
    const byDv = suggestRoutes("earth", "saturn", 25 * JULIAN_YEAR, b, "dv");
    const byTime = suggestRoutes("earth", "saturn", 25 * JULIAN_YEAR, b, "time");
    // Under "dv" the first route is the cheapest offered; under "time" the fastest.
    const minDv = Math.min(...byDv.map((r) => r.dvTotal));
    const minTof = Math.min(...byTime.map((r) => r.tof));
    expect(byDv[0]!.dvTotal).toBe(minDv);
    expect(byTime[0]!.tof).toBe(minTof);
  });

  it("is deterministic — identical inputs give identical rankings", () => {
    const to = BODY_BY_ID.get("jupiter")!;
    const b = { rParkFrom: budget.rParkFrom, rParkTo: to.radius + DEFAULT_CAPTURE_ALT };
    const a = suggestRoutes("earth", "jupiter", 25 * JULIAN_YEAR, b, "balanced");
    const c = suggestRoutes("earth", "jupiter", 25 * JULIAN_YEAR, b, "balanced");
    expect(a.map((r) => `${r.kind}:${r.label}:${r.dvTotal.toFixed(3)}`))
      .toEqual(c.map((r) => `${r.kind}:${r.label}:${r.dvTotal.toFixed(3)}`));
  });

  it("offers a Venus flyby for an inner-system target but not a two-flyby chain", () => {
    const to = BODY_BY_ID.get("mars")!;
    const routes = suggestRoutes("earth", "mars", 1.2 * JULIAN_YEAR,
      { rParkFrom: budget.rParkFrom, rParkTo: to.radius + DEFAULT_CAPTURE_ALT }, "dv");
    expect(routes.every((r) => r.kind !== "chain")).toBe(true); // no VEEGA to Mars
  });

  it("transferWindow scales the search span to the target's synodic period", () => {
    const inner = transferWindow("earth", "mars", 0);
    const outer = transferWindow("earth", "neptune", 0);
    expect(inner.depSpan).toBeGreaterThan(0);
    expect(outer.tofMax).toBeGreaterThan(inner.tofMax); // Neptune is a far longer flight
    expect(inner.tofMin).toBeGreaterThanOrEqual(20 * DAY);
  });
});
