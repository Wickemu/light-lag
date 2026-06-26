import { describe, it, expect } from "vitest";
import { shipForecastPath } from "./trajectory.ts";
import { type Ship } from "./world.ts";
import { circularOrbit } from "./orbit.ts";
import { shipWorldState, shipRelativeState } from "./ships.ts";
import { bodyState } from "./ephemeris.ts";
import { period, stateToElements, type KeplerElements } from "./math/kepler.ts";
import { add, distance } from "./math/vec3.ts";
import { BODY_BY_ID, MU_SUN } from "./constants.ts";

function coastShip(primary: string, elements: KeplerElements, epoch = 0): Ship {
  return {
    id: "t", name: "T", primary, mode: "coast",
    elements, epoch, payloadMass: 1000, stages: [], activeStage: 0, tau: 0,
  };
}

const EARTH = BODY_BY_ID.get("earth")!;
const LEO = () => circularOrbit(EARTH.radius + 4e5, 0.3, 0, 0);

describe("shipForecastPath", () => {
  it("returns null for a landed ship", () => {
    const ship = coastShip("earth", LEO());
    ship.landed = { bodyId: "earth", surfaceDir: { x: 1, y: 0, z: 0 } };
    expect(shipForecastPath(ship, 1000)).toBeNull();
  });

  it("returns null for an interstellar leg", () => {
    const ship = coastShip("sun", LEO());
    ship.interstellarLeg = {
      targetStar: "alpha-centauri", tDepart: 0, tArrive: 1e9,
      properAccel: 9.8, startPos: { x: 0, y: 0, z: 0 },
    };
    expect(shipForecastPath(ship, 1000)).toBeNull();
  });

  it("places a sample exactly on the ship at the current time", () => {
    const t = 5000;
    const ship = coastShip("earth", LEO());
    const path = shipForecastPath(ship, t)!;
    expect(path).not.toBeNull();
    expect(path.primary).toBe("earth");
    const head = path.points[path.headIndex]!; // primary-relative
    const truth = shipRelativeState(ship, t).r;
    expect(distance(head, truth)).toBeLessThan(1e-3);
    expect(Math.abs(path.times[path.headIndex]! - t)).toBeLessThan(1e-6);
  });

  it("samples ~one full period for a bound orbit with no pending event (closed)", () => {
    const ship = coastShip("earth", LEO());
    const path = shipForecastPath(ship, 0)!;
    const per = period(LEO().a, EARTH.mu);
    const span = path.times[path.times.length - 1]! - path.times[0]!;
    expect(path.closed).toBe(true);
    expect(span).toBeCloseTo(per, -1); // within ~10s of one revolution
    // The loop nearly returns to the ship after one revolution (it does not close
    // to the metre because J2 secularly precesses the orbit each period).
    expect(distance(path.points[0]!, path.points[path.points.length - 1]!)).toBeLessThan(LEO().a * 0.05);
  });

  it("produces an OPEN arc for a hyperbolic leg", () => {
    // Heliocentric hyperbola (a < 0, e > 1), pre-periapsis.
    const hyp: KeplerElements = { a: -1.5e11, e: 1.4, i: 0, Omega: 0, omega: 0, M: -0.3 };
    const ship = coastShip("sun", hyp);
    const path = shipForecastPath(ship, 0)!;
    expect(path.closed).toBe(false);
    expect(path.points.length).toBeGreaterThan(2);
    // Times strictly increase (a real swept arc, not a degenerate point).
    for (let k = 1; k < path.times.length; k++) {
      expect(path.times[k]!).toBeGreaterThan(path.times[k - 1]!);
    }
  });

  it("caps the forward horizon at the next scheduled event", () => {
    const t = 1000;
    const ship = coastShip("earth", LEO());
    const eventT = t + 600; // an event well inside one LEO period
    const path = shipForecastPath(ship, t, { nextEventT: eventT })!;
    expect(path.times[path.times.length - 1]!).toBeCloseTo(eventT, 3);
    expect(path.closed).toBe(false); // partial arc, not a full period
  });

  it("is continuous across a primary switch (anti-snap invariant)", () => {
    // A ship coasting about Earth, and the SAME world state re-expressed as a
    // heliocentric leg (what enterSoi/executeDeparture do at an event boundary).
    const t = 8000;
    const before = coastShip("earth", LEO());
    const ws = shipWorldState(before, t);

    // Build the post-event leg from the continuous world state (Sun at origin).
    const after = coastShip("sun", stateToElements(ws.r, ws.v, MU_SUN), t);

    const pBefore = shipForecastPath(before, t)!;
    const pAfter = shipForecastPath(after, t)!;
    // Reconstruct each head's WORLD position (anchor at the primary's position).
    const worldHead = (p: typeof pBefore) =>
      add(bodyState(BODY_BY_ID.get(p.primary)!, t).r, p.points[p.headIndex]!);
    // No world-space jump: both heads sit on the same physical position.
    expect(distance(worldHead(pBefore), worldHead(pAfter))).toBeLessThan(1e-3);
  });
});
