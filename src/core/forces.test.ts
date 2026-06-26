import { describe, it, expect } from "vitest";
import { bodyForceBreakdown, shipForceBreakdown } from "./forces.ts";
import { type Ship } from "./world.ts";
import { circularOrbit } from "./orbit.ts";
import { period, type KeplerElements } from "./math/kepler.ts";
import { bodyState, bodyElements } from "./ephemeris.ts";
import { dot, sub, normalize } from "./math/vec3.ts";
import { BODIES, BODY_BY_ID, MU_SUN } from "./constants.ts";

function coastShip(primary: string, elements: KeplerElements): Ship {
  return {
    id: "t", name: "T", primary, mode: "coast",
    elements, epoch: 0, payloadMass: 1000, stages: [], activeStage: 0, tau: 0,
  };
}

describe("bodyForceBreakdown", () => {
  it("returns null for the Sun (no parent)", () => {
    expect(bodyForceBreakdown(BODY_BY_ID.get("sun")!, 0)).toBeNull();
  });

  it("Moon: dominant pull toward Earth + faint Sun tidal term + lunar orbital speed", () => {
    const moon = BODY_BY_ID.get("moon")!;
    const bd = bodyForceBreakdown(moon, 0)!;
    expect(bd.pulls[0]!.attractorId).toBe("earth");
    const dirToEarth = normalize(sub(bodyState(BODY_BY_ID.get("earth")!, 0).r, bd.position));
    expect(dot(normalize(bd.pulls[0]!.gravAccel), dirToEarth)).toBeGreaterThan(0.99);
    // Secondary is the Sun's TIDAL perturbation — present, flagged, and faint.
    expect(bd.pulls[1]!.attractorId).toBe("sun");
    expect(bd.pulls[1]!.tidal).toBe(true);
    expect(bd.pulls[1]!.magnitude).toBeLessThan(bd.pulls[0]!.magnitude * 0.1);
    // Parent-relative speed is the lunar orbital speed (~1 km/s), not heliocentric.
    expect(bd.speed).toBeGreaterThan(800);
    expect(bd.speed).toBeLessThan(1100);
  });

  it("Earth: single pull toward the Sun, no secondary", () => {
    const bd = bodyForceBreakdown(BODY_BY_ID.get("earth")!, 0)!;
    expect(bd.pulls[0]!.attractorId).toBe("sun");
    expect(bd.pulls.length).toBe(1);
    expect(bd.pulls[0]!.magnitude).toBeGreaterThan(4e-3);
    expect(bd.pulls[0]!.magnitude).toBeLessThan(7e-3);
  });

  it("near-circular orbit: gravity and speed sit near their circular references", () => {
    const bd = bodyForceBreakdown(BODY_BY_ID.get("earth")!, 0)!;
    expect(bd.pulls[0]!.magnitude / bd.gRefA).toBeGreaterThan(0.9);
    expect(bd.pulls[0]!.magnitude / bd.gRefA).toBeLessThan(1.1);
    expect(bd.speed / bd.vRefA).toBeGreaterThan(0.9);
    expect(bd.speed / bd.vRefA).toBeLessThan(1.1);
  });

  it("eccentric orbit: gravity pulses strongly over one revolution", () => {
    const comet = BODIES.find((b) => b.kind === "comet" && (bodyElements(b, 0)?.e ?? 0) > 0.8)!;
    expect(comet).toBeDefined();
    const T = period(bodyElements(comet, 0)!.a, MU_SUN);
    let min = Infinity, max = 0;
    for (let k = 0; k <= 60; k++) {
      const g = bodyForceBreakdown(comet, (T * k) / 60)!.pulls[0]!.magnitude;
      min = Math.min(min, g);
      max = Math.max(max, g);
    }
    expect(max / min).toBeGreaterThan(5); // periapsis vs apoapsis pull ratio
  });
});

describe("shipForceBreakdown", () => {
  it("returns null on an interstellar leg", () => {
    const ship = coastShip("sun", circularOrbit(1e9, 0, 0, 0));
    ship.interstellarLeg = {
      targetStar: "alpha-centauri", tDepart: 0, tArrive: 1e9,
      properAccel: 9.8, startPos: { x: 0, y: 0, z: 0 },
    };
    expect(shipForceBreakdown(ship, 0)).toBeNull();
  });

  it("LEO coast: dominant pull toward Earth, Sun tidal secondary, ~7.7 km/s", () => {
    const earth = BODY_BY_ID.get("earth")!;
    const ship = coastShip("earth", circularOrbit(earth.radius + 4e5, 0.3, 0, 0));
    const bd = shipForceBreakdown(ship, 0)!;
    expect(bd.pulls[0]!.attractorId).toBe("earth");
    expect(bd.pulls[1]!.attractorId).toBe("sun");
    expect(bd.speed).toBeGreaterThan(7000);
    expect(bd.speed).toBeLessThan(8200);
  });
});
