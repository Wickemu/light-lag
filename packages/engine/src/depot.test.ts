import { describe, it, expect } from "vitest";
import { type Ship, type Station } from "./world.ts";
import { type Stage } from "./propulsion.ts";
import { BODY_BY_ID } from "./constants.ts";
import { circularOrbit } from "./orbit.ts";
import { elementsToState } from "./math/kepler.ts";
import { bodyState } from "./ephemeris.ts";
import { shipWorldState } from "./ships.ts";
import { add, length, sub } from "./math/vec3.ts";
import { shipPropAvailable, shipPropHeadroom } from "./refuel.ts";
import {
  stationWorldState, stationDockState, depotAvailable, depotHeadroom, loadDepot, unloadDepot,
} from "./depot.ts";

const EARTH = BODY_BY_ID.get("earth")!;
const ORBIT = circularOrbit(EARTH.radius + 400_000, 0.1, 0, 0);

/** A coasting ship about `primary` on the given `elements`, one core stage. */
function ship(propMass: number, propCapacity: number, primary = "earth"): Ship {
  const stage: Stage = { name: "core", dryMass: 2000, propMass, isp: 320, thrust: 1e5, propCapacity };
  return {
    id: "s", name: "s", primary, mode: "coast", elements: ORBIT,
    epoch: 0, payloadMass: 1000, stages: [stage], activeStage: 0, tau: 0,
  };
}

/** A depot station on the same orbit as `ship`, so a co-orbital ship docks exactly. */
function station(propMass: number, propCapacity: number, primary = "earth"): Station {
  return { id: "d1", name: "Depot 1", primary, elements: ORBIT, depot: { propMass, propCapacity } };
}

describe("depot — stationWorldState", () => {
  it("equals the station's conic about its primary plus the primary's ephemeris (at epoch)", () => {
    const st = station(0, 100_000); // epoch defaults to 0 ⇒ dt=0 ⇒ no propagation at t=0
    const t = 0;
    const want = (() => {
      const rel = elementsToState(st.elements, EARTH.mu);
      const prim = bodyState(EARTH, t);
      return { r: add(prim.r, rel.r), v: add(prim.v, rel.v) };
    })();
    const got = stationWorldState(st, t);
    expect(length(sub(got.r, want.r))).toBeCloseTo(0, 3);
    expect(length(sub(got.v, want.v))).toBeCloseTo(0, 6);
  });

  it("propagates along the orbit — the station moves as time advances", () => {
    const st = station(0, 100_000);
    const a = stationWorldState(st, 0);
    const b = stationWorldState(st, 1800); // ~⅓ of a LEO period later
    expect(length(sub(a.r, b.r))).toBeGreaterThan(1e6); // it has orbited, not frozen
  });

  it("co-locates with a ship placed on the identical elements/primary", () => {
    const t = 5e5;
    const ss = shipWorldState(ship(0, 100_000), t);
    const st = stationWorldState(station(0, 100_000), t);
    expect(length(sub(ss.r, st.r))).toBeCloseTo(0, 3);
    expect(length(sub(ss.v, st.v))).toBeCloseTo(0, 6);
  });
});

describe("depot — stationDockState", () => {
  it("docks a ship sharing the station's orbit (≈0 distance, ≈0 relative speed)", () => {
    const d = stationDockState(ship(0, 100_000), station(0, 100_000), 0);
    expect(d.distance).toBeCloseTo(0, 3);
    expect(d.relSpeed).toBeCloseTo(0, 6);
    expect(d.docked).toBe(true);
  });

  it("does not dock a ship on a different orbit", () => {
    const far = ship(0, 100_000);
    far.elements = circularOrbit(EARTH.radius + 2_000_000, 0.1, 0, 0);
    const d = stationDockState(far, station(0, 100_000), 0);
    expect(d.distance).toBeGreaterThan(1000);
    expect(d.docked).toBe(false);
  });
});

describe("depot — headroom / available", () => {
  it("reports fill and free capacity, clamped at the bounds", () => {
    expect(depotAvailable({ propMass: 3000, propCapacity: 10_000 })).toBe(3000);
    expect(depotHeadroom({ propMass: 3000, propCapacity: 10_000 })).toBe(7000);
    expect(depotHeadroom({ propMass: 10_000, propCapacity: 10_000 })).toBe(0);
    expect(depotAvailable({ propMass: 0, propCapacity: 10_000 })).toBe(0);
  });
});

describe("depot — loadDepot (ship → depot)", () => {
  it("conserves mass: the depot gains exactly what the ship loses", () => {
    const s = ship(8000, 10_000); // 8 t aboard
    const d = station(0, 100_000).depot!;
    const shipBefore = shipPropAvailable(s);
    const moved = loadDepot(s, d, 3000);
    expect(moved).toBeCloseTo(3000, 6);
    expect(d.propMass).toBeCloseTo(3000, 6);
    expect(shipPropAvailable(s)).toBeCloseTo(shipBefore - 3000, 6);
  });

  it("is capped by the depot's headroom", () => {
    const s = ship(8000, 10_000);
    const d = station(9000, 10_000).depot!; // only 1 t of headroom
    const moved = loadDepot(s, d, 1e12);
    expect(moved).toBeCloseTo(1000, 6);
    expect(d.propMass).toBeCloseTo(10_000, 6);
    expect(d.propMass).toBeLessThanOrEqual(d.propCapacity + 1e-6);
  });

  it("is capped by the ship's available propellant", () => {
    const s = ship(2000, 10_000); // only 2 t to give
    const d = station(0, 100_000).depot!;
    const moved = loadDepot(s, d, 1e12);
    expect(moved).toBeCloseTo(2000, 6);
    expect(shipPropAvailable(s)).toBeCloseTo(0, 6);
  });
});

describe("depot — unloadDepot (depot → ship)", () => {
  it("conserves mass and is capped by the ship's tank headroom", () => {
    const s = ship(4000, 10_000); // 6 t of headroom
    const d = station(50_000, 100_000).depot!;
    const moved = unloadDepot(s, d, 1e12);
    expect(moved).toBeCloseTo(6000, 6); // tops the ship to capacity
    expect(shipPropHeadroom(s)).toBeCloseTo(0, 6);
    expect(d.propMass).toBeCloseTo(44_000, 6); // depot down by exactly what the ship gained
  });

  it("is capped by the depot's available propellant", () => {
    const s = ship(0, 10_000); // 10 t of headroom
    const d = station(1500, 100_000).depot!; // only 1.5 t banked
    const moved = unloadDepot(s, d, 1e12);
    expect(moved).toBeCloseTo(1500, 6);
    expect(depotAvailable(d)).toBeCloseTo(0, 6);
  });
});

describe("depot — round-trip", () => {
  it("a full load then unload returns the propellant to the ship losslessly", () => {
    const s = ship(8000, 10_000);
    const d = station(0, 100_000).depot!;
    const aboardBefore = shipPropAvailable(s);
    loadDepot(s, d, 5000);
    unloadDepot(s, d, 5000);
    expect(shipPropAvailable(s)).toBeCloseTo(aboardBefore, 6);
    expect(d.propMass).toBeCloseTo(0, 6);
  });
});
