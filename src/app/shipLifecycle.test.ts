import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import { spawnShip, defaultDesign, deleteShip, planTransfer, sendBurn } from "./commands.ts";
import { flyUntilCoast, marsWindow } from "../integration/test-helpers.ts";
import { orbitalPeriod } from "@lightlag/engine/orbit";
import { shipRelativeState } from "@lightlag/engine/ships";
import { serializeWorld, deserializeWorld, hashWorld } from "@lightlag/engine/serialize";
import { BODY_BY_ID, DAY } from "@lightlag/engine/constants";
import { length } from "@lightlag/engine/math/vec3";

const EARTH = BODY_BY_ID.get("earth")!;

describe("surface impact — ships crash and are lost (#6)", () => {
  it("a coasting orbit whose periapsis is below the surface destroys the ship", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    const R = EARTH.radius;
    const rp = R - 500_000; // periapsis 500 km UNDER the surface
    const ra = R + 2_000_000; // apoapsis 2000 km up
    const a = (rp + ra) / 2;
    const e = (ra - rp) / (ra + rp);
    ship.elements = { a, e, i: 0, Omega: 0, omega: 0, M: Math.PI }; // start at apoapsis (safe right now)
    ship.epoch = 0;

    const period = orbitalPeriod(a, EARTH.mu);
    sim.step(0.25 * period); // not yet down to the surface from apoapsis
    expect(ship.status).toBeUndefined();
    sim.step(0.75 * period); // ride it down: it must meet the surface on the way to periapsis
    expect(ship.status).toBe("lost");
    expect(ship.landed?.bodyId).toBe("earth");
    // The wreck sits on the surface (≈ one Earth radius from the centre).
    expect(length(shipRelativeState(ship, sim.world.t).r) / R).toBeCloseTo(1, 2);
  });

  it("a real retrograde burn that drops periapsis underground is fatal", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign()); // ~400 km LEO
    sendBurn(sim, id, 600, "retrograde"); // enough to push periapsis below the surface
    flyUntilCoast(sim, id);
    const ship = sim.world.ships.get(id)!;
    expect(ship.status).toBeUndefined(); // still alive at apoapsis right after the burn
    sim.step(5 * 3600); // coast around to the new (sub-surface) periapsis
    expect(ship.status).toBe("lost");
  });

  it("a normal LEO orbit is never falsely destroyed", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    sim.step(30 * DAY);
    expect(ship.status).toBeUndefined();
    expect(ship.landed).toBeUndefined();
  });

  it("crash detection is chunk-invariant (one big step == many small steps)", () => {
    const make = (): Simulation => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, defaultDesign());
      const ship = sim.world.ships.get(id)!;
      const R = EARTH.radius;
      const a = (R - 5e5 + R + 2e6) / 2;
      const e = (R + 2e6 - (R - 5e5)) / (R + 2e6 + (R - 5e5));
      ship.elements = { a, e, i: 0.3, Omega: 0.2, omega: 0.1, M: Math.PI };
      ship.epoch = 0;
      return sim;
    };
    const big = make();
    big.step(6000);
    const small = make();
    for (let i = 0; i < 600; i++) small.step(10);
    expect(hashWorld(small.world)).toBe(hashWorld(big.world));
  });

  it("a ship thrusting INTO the surface is destroyed mid-burn (not only on the next coast)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    const R = EARTH.radius;
    // Poised just above the surface (apoapsis 10 km up) on a plunging arc, then a hard
    // radial-IN burn drives it straight down through the surface. It meets the ground
    // ~30 s in, long before this large burn (well within the ship's Δv budget) could
    // finish — so the loss can only come from the in-burn surface check, since the
    // coast-only impactTime never runs while thrusting.
    const ra = R + 10e3, rp = R - 1000e3;
    ship.elements = { a: (ra + rp) / 2, e: (ra - rp) / (ra + rp), i: 0, Omega: 0, omega: 0, M: Math.PI + 0.05 };
    ship.epoch = 0;
    sendBurn(sim, id, 5000, "radial-in"); // within the ~7.85 km/s budget, so not NACKed

    // Step a window far shorter than a 5 km/s burn takes; while it lasts the ship is
    // continuously thrusting, so being lost here proves the powered-impact path.
    let guard = 0;
    while (ship.status === undefined && guard++ < 200) sim.step(1);
    expect(guard).toBeLessThan(120); // died quickly, mid-burn — not after a long coast
    expect(ship.status).toBe("lost");
    expect(ship.landed?.bodyId).toBe("earth");
    expect(ship.burn).toBeUndefined();
    expect(ship.mode).toBe("coast");
    expect(length(shipRelativeState(ship, sim.world.t).r) / R).toBeCloseTo(1, 1);
  });

  it("a lost ship survives a serialize round-trip", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    const R = EARTH.radius;
    ship.elements = { a: (R - 5e5 + R + 2e6) / 2, e: (R + 2e6 - (R - 5e5)) / (R + 2e6 + (R - 5e5)), i: 0, Omega: 0, omega: 0, M: Math.PI };
    ship.epoch = 0;
    sim.step(6000);
    expect(ship.status).toBe("lost");
    const restored = deserializeWorld(serializeWorld(sim.world));
    expect(restored.ships.get(id)!.status).toBe("lost");
    expect(hashWorld(restored)).toBe(hashWorld(sim.world));
  });
});

describe("deleting a ship (#7)", () => {
  it("removes the ship and purges its scheduled events and in-flight orders", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const win = marsWindow();
    planTransfer(sim, id, "mars", win.depT, win.arrT); // schedules a transfer-depart event
    sendBurn(sim, id, 50, "prograde"); // a command message crawling out to the ship
    expect(sim.events.toArray().some((e) => e.entityId === id)).toBe(true);
    expect(sim.world.messages.some((m) => m.targetId === id)).toBe(true);

    expect(deleteShip(sim, id)).toBe(true);
    expect(sim.world.ships.has(id)).toBe(false);
    expect(sim.events.toArray().some((e) => e.entityId === id)).toBe(false);
    expect(sim.world.messages.some((m) => m.targetId === id)).toBe(false);
    expect(deleteShip(sim, id)).toBe(false); // already gone
  });

  it("the sim still steps cleanly after a delete (no dangling events)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const win = marsWindow();
    planTransfer(sim, id, "mars", win.depT, win.arrT);
    deleteShip(sim, id);
    expect(() => sim.step(win.arrT + 10 * DAY)).not.toThrow();
  });
});

describe("warp to departure (#8 jumpToTime)", () => {
  it("leaps the clock to just before a scheduled departure without departing", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const win = marsWindow();
    planTransfer(sim, id, "mars", win.depT, win.arrT);

    sim.jumpToTime(win.depT - 300);
    expect(sim.world.t).toBeCloseTo(win.depT - 300, 3);
    expect(sim.world.ships.get(id)!.transfer!.departed).toBe(false); // departs at tDepart, not before
  });

  it("a no-op for a time that is not in the future", () => {
    const sim = new Simulation(createWorld(1, 0));
    sim.step(1000);
    const t0 = sim.world.t;
    sim.jumpToTime(t0 - 500);
    expect(sim.world.t).toBe(t0);
  });

  it("refuses to leap while a burn is running (never skips powered flight)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    sendBurn(sim, id, 100, "prograde");
    let guard = 0;
    while (!sim.anyThrust() && guard++ < 100_000) sim.step(0.05); // wait for the order to arrive
    expect(sim.anyThrust()).toBe(true);
    const t0 = sim.world.t;
    sim.jumpToTime(t0 + 1e7); // a 10-million-second leap request, mid-burn
    expect(sim.world.t).toBe(t0); // refused: the clock did not move
  });
});
