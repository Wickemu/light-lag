import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import { spawnShip, planMoonTour, searchMoonTour, type ShipDesign } from "./commands.ts";
import { shipOsculatingElements, shipRelativeState } from "@lightlag/engine/ships";
import { serializeWorld, deserializeWorld, hashWorld } from "@lightlag/engine/serialize";
import { bodyElements, bodyStateRelative } from "@lightlag/engine/ephemeris";
import { lambert } from "@lightlag/engine/maneuver/lambert";
import { outboundClearsParent } from "@lightlag/engine/maneuver/moon";
import { BODY_BY_ID, DAY } from "@lightlag/engine/constants";

const JUPITER = BODY_BY_ID.get("jupiter")!;
const EUROPA = BODY_BY_ID.get("europa")!;
const GANYMEDE = BODY_BY_ID.get("ganymede")!;
const FLYBYS = ["callisto", "ganymede"];

// A torch-class orbiter: a Galilean pump-down costs a few km/s spread across departure + flybys +
// capture, so give it a generous budget (the test exercises the chaining/frames, not realism).
function bigDesign(): ShipDesign {
  return {
    name: "Galilean Orbiter", payloadMass: 500, altitudeKm: 400, inclinationDeg: 5,
    stages: [{ name: "Torch", dryMass: 1000, propMass: 60000, isp: 4000, thrust: 5e5 }],
  };
}

/** Hand-place the ship in a loose, eccentric Jupiter orbit (as moonMission.test.ts hand-sets
 *  the primary), roughly coplanar with the Galileans. */
function parkAtJupiter(sim: Simulation, id: string): void {
  const ship = sim.world.ships.get(id)!;
  const el0 = bodyElements(EUROPA, sim.world.t)!;
  ship.primary = "jupiter";
  ship.elements = { a: 5e9, e: 0.75, i: el0.i, Omega: el0.Omega, omega: el0.omega, M: 0 };
  ship.epoch = sim.world.t;
  ship.r = undefined;
  ship.v = undefined;
  ship.mode = "coast";
}

function findTour(sim: Simulation, id: string) {
  const ship = sim.world.ships.get(id)!;
  return searchMoonTour("jupiter", FLYBYS, "europa", {
    tDepart: sim.world.t, shipState: (t) => shipRelativeState(ship, t), steps: 5, phaseSteps: 32,
  });
}

describe("intra-system moon tour, flown in-sim (Jupiter Galilean pump-down to Europa)", () => {
  it("flies depart → Callisto → Ganymede flybys → Europa capture, all inside Jupiter's SOI", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    parkAtJupiter(sim, id);
    const ship = sim.world.ships.get(id)!;
    const tour = findTour(sim, id)!;
    expect(tour).toBeTruthy();

    expect(planMoonTour(sim, id, FLYBYS, "europa", tour.times)).toBeTruthy();
    expect(ship.transfer!.central).toBe("jupiter");
    expect(ship.transfer!.flybys!.map((f) => f.bodyId)).toEqual(FLYBYS);

    // Step to BETWEEN the two flybys: the ship must still be orbiting the PARENT (never the Sun)
    // and the first flyby must be done — the frame-leak guard for the parent-centric executor.
    const midFlybys = (tour.flybys[0]!.t + tour.flybys[1]!.t) / 2;
    sim.step(midFlybys - sim.world.t);
    expect(ship.primary).toBe("jupiter");
    expect(ship.transfer!.flybys![0]!.done).toBe(true);
    expect(ship.transfer!.flybys![1]!.done).toBe(false);

    // Finish the tour: it captures at Europa, having stayed in Jupiter's SOI throughout.
    sim.step(tour.tArrive + 30 * DAY - sim.world.t);
    expect(ship.primary).toBe("europa");
    expect(ship.transfer!.arrived).toBe(true);
    expect(ship.transfer!.flybys!.every((f) => f.done)).toBe(true);

    const el = shipOsculatingElements(ship, sim.world.t);
    expect(el.e).toBeLessThan(1); // captured (bound), not still hyperbolic
    const periAlt = el.a * (1 - el.e) - EUROPA.radius;
    expect(periAlt).toBeGreaterThan(0); // a real orbit ABOVE Europa's surface
    expect(el.a * (1 - el.e)).toBeLessThan(9.7e6); // a bound orbit inside Europa's SOI (~9.7·10³ km)
  });

  it("is chunk-invariant (one-step == chunked) and round-trips through serialize", () => {
    const run = (chunks: number): string => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, bigDesign());
      parkAtJupiter(sim, id);
      const tour = findTour(sim, id)!;
      planMoonTour(sim, id, FLYBYS, "europa", tour.times);
      const tEnd = tour.tArrive + 30 * DAY;
      for (let i = 0; i < chunks; i++) sim.step(tEnd / chunks);
      return hashWorld(sim.world);
    };
    expect(run(1)).toBe(run(9));

    // Mid-tour (after the first flyby) the active parent-centric tour transfer round-trips cleanly.
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    parkAtJupiter(sim, id);
    const tour = findTour(sim, id)!;
    planMoonTour(sim, id, FLYBYS, "europa", tour.times);
    sim.step(tour.flybys[0]!.t + DAY - sim.world.t);
    const restored = deserializeWorld(serializeWorld(sim.world));
    expect(restored.ships.get(id)!.transfer!.central).toBe("jupiter");
    expect(restored.ships.get(id)!.transfer!.flybys!.length).toBe(2);
    expect(hashWorld(restored)).toBe(hashWorld(sim.world));
  });

  it("rejects invalid tours without committing anything", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    parkAtJupiter(sim, id);
    const t0 = sim.world.t;
    expect(planMoonTour(sim, id, ["titan"], "europa", [t0, t0 + 1e6, t0 + 2e6])).toBeNull(); // wrong parent
    expect(planMoonTour(sim, id, ["ganymede", "europa"], "europa", [t0, t0 + 1e6, t0 + 2e6, t0 + 3e6])).toBeNull(); // final flyby == target
    expect(planMoonTour(sim, id, ["ganymede"], "europa", [t0, t0 + 2e6, t0 + 1e6])).toBeNull(); // out-of-order
    expect(planMoonTour(sim, id, ["ganymede"], "europa", [t0, t0 + 1e6])).toBeNull(); // wrong times length
    expect(planMoonTour(sim, id, ["ganymede"], "titan", [t0, t0 + 1e6, t0 + 2e6])).toBeNull(); // target not a Jovian moon
    expect(sim.world.ships.get(id)!.transfer).toBeUndefined(); // nothing committed
  });
});

// A loose, low-periapsis Jupiter ellipse whose Ganymede→Europa tour grid contains first legs whose
// parent-relative outbound conic dives BELOW Jupiter's surface (an unfavourable parking-orbit phase).
// Mirrors moonTransfer.test.ts's "never picks a window whose outbound conic dives into Earth": the
// single-moon injection is hardened the same way, and the same latent crash exists on the tour's
// parent-centric leg-1 Lambert. a = 2.5·10⁶ km, e = 0.4 (periapsis ~1.5·10⁶ km, above Jupiter; some
// phases still solve a leg-1 whose conic periapsis is sub-surface).
function parkLowEllipse(sim: Simulation, id: string, M: number): void {
  const ship = sim.world.ships.get(id)!;
  const el0 = bodyElements(EUROPA, sim.world.t)!;
  ship.primary = "jupiter";
  ship.elements = { a: 2.5e9, e: 0.4, i: el0.i, Omega: el0.Omega, omega: el0.omega, M };
  ship.epoch = sim.world.t;
  ship.r = undefined;
  ship.v = undefined;
  ship.mode = "coast";
}

/** Does the parent-relative leg-1 conic the ship is seeded on for a Ganymede-first tour schedule
 *  clear Jupiter's surface? The condition the departure crash-guard enforces. */
function leg1ClearsJupiter(sim: Simulation, id: string, times: number[]): boolean {
  const ship = sim.world.ships.get(id)!;
  const dep = shipRelativeState(ship, times[0]!);
  const ganR = bodyStateRelative(GANYMEDE, times[1]!).r;
  const leg1 = lambert(dep.r, ganR, times[1]! - times[0]!, JUPITER.mu, true)!;
  return outboundClearsParent(dep.r, leg1.v1, JUPITER.mu, JUPITER.radius);
}

describe("intra-system moon tour — parent-surface clearance at departure", () => {
  it("never picks a tour whose leg-1 conic dives into the parent (no departure crash)", () => {
    // Regression: a moon tour is flown about Jupiter, and a leg-1 injection solved only against the
    // first-flyby Lambert could — for an unfavourable parking-orbit phase — put the Jupiter-relative
    // outbound conic's periapsis BELOW Jupiter's surface, flying the ship into the planet at
    // departure. searchMoonTour must reject those, picking only first legs that clear the surface.
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    parkLowEllipse(sim, id, 0);
    const ship = sim.world.ships.get(id)!;

    const tour = searchMoonTour("jupiter", ["ganymede"], "europa",
      { tDepart: sim.world.t, shipState: (t) => shipRelativeState(ship, t), steps: 5, phaseSteps: 32 })!;
    expect(tour).toBeTruthy();

    // The chosen tour's leg-1 outbound conic clears Jupiter's surface.
    const dep = shipRelativeState(ship, tour.times[0]!);
    const ganR = bodyStateRelative(GANYMEDE, tour.times[1]!).r;
    const leg1 = lambert(dep.r, ganR, tour.times[1]! - tour.times[0]!, JUPITER.mu, true)!;
    expect(outboundClearsParent(dep.r, leg1.v1, JUPITER.mu, JUPITER.radius)).toBe(true);

    // And flying it, the ship survives departure (Jupiter-relative periapsis clears the surface)…
    expect(planMoonTour(sim, id, ["ganymede"], "europa", tour.times)).toBeTruthy();
    sim.step(tour.tDepart + 60 - sim.world.t);
    expect(ship.status ?? "ok").toBe("ok");
    const elOut = shipOsculatingElements(ship, sim.world.t);
    expect(elOut.a * (1 - elOut.e)).toBeGreaterThanOrEqual(JUPITER.radius);

    // …and completes the tour, captured at Europa, never lost.
    sim.step(tour.tArrive + 30 * DAY - sim.world.t);
    expect(ship.status ?? "ok").toBe("ok");
    expect(ship.primary).toBe("europa");
    expect(ship.transfer!.arrived).toBe(true);
  });

  it("rejects a directly-specified tour whose leg-1 would crash into the parent (no doomed launch)", () => {
    // A directly-specified schedule (not from searchMoonTour) can carry an unsafe first leg whose
    // outbound conic dives below Jupiter's surface. planMoonTour must reject it up front — never
    // committing a transfer that is doomed to crash at departure — rather than leaving a launch
    // the player has committed to already lost. This schedule's leg-1 conic passes through Jupiter
    // (periapsis ≈ 0); its ~9 km/s injection is well within budget, so only the surface guard —
    // not affordability — rejects it.
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    parkLowEllipse(sim, id, 0);
    const ship = sim.world.ships.get(id)!;

    const tDep = 1861823, tof1 = 447311, tof2 = 225558;
    const times = [tDep, tDep + tof1, tDep + tof1 + tof2];

    // Sanity: this schedule's leg-1 outbound conic really does dive below Jupiter's surface.
    expect(leg1ClearsJupiter(sim, id, times)).toBe(false);

    expect(planMoonTour(sim, id, ["ganymede"], "europa", times)).toBeNull();
    expect(ship.transfer).toBeUndefined(); // nothing committed
  });

  it("safety net: the executor still refuses an unsafe tour transfer reached by other means", () => {
    // Defense-in-depth behind planMoonTour's up-front reject: should an unsafe tour transfer arise
    // by other means (a hand-built / deserialized transfer), executeMoonTourDeparture must still
    // refuse the injection and leave it un-departed rather than burning into the parent. Build the
    // transfer planMoonTour now rejects, to exercise the in-flight guard directly.
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    parkLowEllipse(sim, id, 0);
    const ship = sim.world.ships.get(id)!;

    const tDep = 1861823, tof1 = 447311, tof2 = 225558;
    ship.transfer = {
      targetId: "europa", tDepart: tDep, tArrive: tDep + tof1 + tof2,
      dvDepart: 0, dvArrive: 0, departed: false, inSoi: false, arrived: false, central: "jupiter",
      flybys: [{ bodyId: "ganymede", tFlyby: tDep + tof1, dvBurn: 0, done: false }],
    };
    sim.events.push({ t: tDep, kind: "transfer-depart", entityId: id });

    sim.step(tDep + 5 * DAY - sim.world.t);
    expect(ship.status ?? "ok").toBe("ok");
    expect(ship.primary).toBe("jupiter");
    expect(ship.transfer!.departed).toBe(false); // refused — never burned into Jupiter
  });
});
