import { describe, it, expect } from "vitest";
import { planRoute } from "./route.ts";
import { bodyState } from "./ephemeris.ts";
import { distance, length } from "./math/vec3.ts";
import { BODY_BY_ID, AU } from "./constants.ts";

const DAY = 86400;

/** Find a window where the Earth→Mars Lambert solve succeeds (most do; a few
 *  near-180° geometries do not). Returns the first ok route in a coarse scan. */
function firstOkEarthMars() {
  for (let dep = 0; dep <= 900 * DAY; dep += 20 * DAY) {
    for (let tof = 150 * DAY; tof <= 300 * DAY; tof += 25 * DAY) {
      const r = planRoute({ fromId: "earth", targetId: "mars", tDepart: dep, tArrive: dep + tof });
      if (r.ok) return { route: r, dep, arr: dep + tof };
    }
  }
  throw new Error("no Lambert solution found in scan");
}

describe("planRoute", () => {
  it("returns ok=false for reversed times", () => {
    expect(planRoute({ fromId: "earth", targetId: "mars", tDepart: 100, tArrive: 50 }).ok).toBe(false);
  });

  it("returns ok=false for an unknown body", () => {
    expect(planRoute({ fromId: "earth", targetId: "nibiru", tDepart: 0, tArrive: 200 * DAY }).ok).toBe(false);
  });

  it("the heliocentric arc connects the departure body to the target", () => {
    const { route, dep, arr } = firstOkEarthMars();
    const helio = route.legs.find((l) => l.kind === "helio")!;
    expect(helio).toBeDefined();
    const first = helio.points[0]!;
    const last = helio.points[helio.points.length - 1]!;
    // Endpoints sit on the body centres (Lambert + conic round-trip; ~km class).
    expect(distance(first, bodyState(BODY_BY_ID.get("earth")!, dep).r)).toBeLessThan(1e6);
    expect(distance(last, bodyState(BODY_BY_ID.get("mars")!, arr).r)).toBeLessThan(1e6);
    expect(distance(route.depPoint, bodyState(BODY_BY_ID.get("earth")!, dep).r)).toBeLessThan(1);
    expect(distance(route.arrPoint, bodyState(BODY_BY_ID.get("mars")!, arr).r)).toBeLessThan(1);
  });

  it("the arc is a real interplanetary sweep, not a closed loop through the Sun", () => {
    const { route } = firstOkEarthMars();
    const helio = route.legs.find((l) => l.kind === "helio")!;
    // Every point stays in the inner system — the arc never collapses toward the
    // Sun (which a mis-sampled closed ellipse through the origin would) nor flies off.
    let min = Infinity, max = 0;
    for (const p of helio.points) {
      const rAU = length(p) / AU;
      min = Math.min(min, rAU);
      max = Math.max(max, rAU);
    }
    expect(min).toBeGreaterThan(0.5);
    expect(max).toBeLessThan(5);
  });

  it("includes context rings when park radii are given", () => {
    const { dep, arr } = firstOkEarthMars();
    const r = planRoute({
      fromId: "earth", targetId: "mars", tDepart: dep, tArrive: arr,
      rParkFrom: BODY_BY_ID.get("earth")!.radius + 4e5,
      rParkTo: BODY_BY_ID.get("mars")!.radius + 4e5,
    });
    expect(r.legs.some((l) => l.kind === "park-from")).toBe(true);
    expect(r.legs.some((l) => l.kind === "park-to")).toBe(true);
  });

  it("rejects an out-of-order flyby", () => {
    const r = planRoute({
      fromId: "earth", targetId: "jupiter", tDepart: 100 * DAY, tArrive: 800 * DAY,
      flyby: { bodyId: "venus", tFlyby: 50 * DAY }, // before departure
    });
    expect(r.ok).toBe(false);
  });
});
