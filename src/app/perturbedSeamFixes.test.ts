/**
 * Regression tests for the perturbed-leg / fidelity / station-keeping seam fixes —
 * the cohesion holes a full-playtest audit surfaced where the opt-in perturbed tier
 * (Ship.fidelity / perturbedLeg / stationKeep) met the older burn, transfer, and
 * lifecycle subsystems. Each test fails on the pre-fix code and passes after.
 */
import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import { spawnShip, sendBurn, planMoonTransfer, searchMoonWindow, type ShipDesign } from "./commands.ts";
import { shipRelativeState, shipOsculatingElements } from "@lightlag/engine/ships";
import { hashWorld } from "@lightlag/engine/serialize";
import { circularOrbit } from "@lightlag/engine/orbit";
import { BODY_BY_ID, DAY, DEFAULT_CAPTURE_ALT } from "@lightlag/engine/constants";

function leoSat(): ShipDesign {
  return {
    name: "LEOsat", payloadMass: 1000, altitudeKm: 400, inclinationDeg: 28.5,
    stages: [{ name: "Bus", dryMass: 800, propMass: 4000, isp: 320, thrust: 4e3 }],
  };
}
function geoSat(): ShipDesign {
  return {
    name: "GEOsat", payloadMass: 1000, altitudeKm: 35786, inclinationDeg: 5,
    stages: [{ name: "Bus", dryMass: 800, propMass: 4000, isp: 320, thrust: 4e3 }],
  };
}

describe("perturbed / fidelity / station-keeping seam fixes", () => {
  it("H1: a flyPerturbed that can't arm (LEO — no significant perturbers) leaks no fidelity flag and is hash-neutral", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, leoSat());
    const before = hashWorld(sim.world);
    const armed = sim.flyPerturbed(id); // deep in Earth's well the lunisolar tide is below threshold
    const ship = sim.world.ships.get(id)!;
    expect(armed).toBe(false);
    expect(ship.fidelity).toBeUndefined(); // the "perturbed" flag must not survive a failed arm
    expect(ship.perturbedLeg).toBeUndefined();
    expect(hashWorld(sim.world)).toBe(before); // an opt-in field that leaked would move the golden hash
  });

  it("H1: a holdStation that can't arm reverts BOTH the hold and the fidelity flag", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, leoSat());
    const armed = sim.holdStation(id, { kind: "orbit" });
    const ship = sim.world.ships.get(id)!;
    expect(armed).toBe(false);
    expect(ship.stationKeep).toBeUndefined();
    expect(ship.fidelity).toBeUndefined();
  });

  it("H2: a delivered burn command cannot resurrect a crashed (lost) ship", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, leoSat());
    sim.commandPolicy = "binding";
    sendBurn(sim, id, 50, "prograde"); // queue a burn that the light-lag delivers a moment later
    const ship = sim.world.ships.get(id)!;
    ship.status = "lost"; // the ship crashes before the order arrives
    sim.step(1 * DAY); // advance well past delivery
    const after = sim.world.ships.get(id)!;
    expect(after.status).toBe("lost");
    expect(after.mode).not.toBe("thrust"); // the wreck stays a wreck — no resurrection
  });

  it("C2: a burn delivered to a perturbed ship takes control of the leg instead of being silently discarded", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, geoSat());
    const armed = sim.flyPerturbed(id); // GEO feels the Moon + Sun
    expect(armed).toBe(true);
    expect(sim.world.ships.get(id)!.perturbedLeg).toBeDefined();
    sim.commandPolicy = "informative";
    sendBurn(sim, id, 100, "prograde"); // applies immediately under the informative policy
    const ship = sim.world.ships.get(id)!;
    expect(ship.perturbedLeg).toBeUndefined(); // the perturbed leg (and its pending finalize) was cleared
    expect(ship.mode).toBe("thrust"); // the burn actually started rather than being clobbered
    expect(ship.burn).toBeDefined();
  });

  it("H4/C3: a station-kept hold ends cleanly once a transfer is pending and the correction window can't re-arm", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, geoSat());
    const armed = sim.holdStation(id, { kind: "orbit" }, { windowS: 1 * DAY });
    expect(armed).toBe(true);
    const ship = sim.world.ships.get(id)!;
    // A pending transfer now owns the path, so armPerturbedLeg refuses the next window's re-arm.
    ship.transfer = {
      targetId: "mars", tDepart: sim.world.t + 400 * DAY, tArrive: sim.world.t + 600 * DAY,
      departed: false, arrived: false,
    } as NonNullable<typeof ship.transfer>;
    sim.step(1.5 * DAY); // step past the correction window's finalize
    const after = sim.world.ships.get(id)!;
    expect(after.perturbedLeg).toBeUndefined();
    expect(after.fidelity).toBeUndefined(); // hold ended cleanly — no dangling perturbed flag
    expect(after.stationKeep).toBeUndefined();
  });

  it("C1: a perturbed ship at the SOI edge does not hang the sim on a degenerate-leg re-arm", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, leoSat());
    const ship = sim.world.ships.get(id)!;
    // Place the state just OUTSIDE Earth's SOI (~9.24e8 m): buildPerturbedLeg clamps to zero length,
    // which pre-fix re-armed a same-time finalize forever (drainEvents never returned).
    ship.elements = { a: 9.3e8, e: 0.001, i: 0.1, Omega: 0, omega: 0, M: 0 };
    ship.epoch = sim.world.t;
    sim.flyPerturbed(id);
    const t0 = sim.world.t;
    sim.step(1 * DAY); // would never return if the degenerate leg re-armed in an infinite loop
    expect(sim.world.t).toBeGreaterThan(t0); // the step completed and advanced time
  });

  it("M1: a lunar capture lands at the aimed 400 km periapsis (J2-aware moon aim ≡ the J2 flight)", () => {
    const earth = BODY_BY_ID.get("earth")!;
    const moon = BODY_BY_ID.get("moon")!;
    expect(moon.J2).toBeTruthy(); // the Moon is oblate, so enterSoi flies a J2 approach leg the aim must match
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, {
      name: "Lunar", payloadMass: 500, altitudeKm: 400, inclinationDeg: 5,
      stages: [{ name: "Core", dryMass: 1200, propMass: 9000, isp: 360, thrust: 2e5 }],
    });
    const ship = sim.world.ships.get(id)!;
    ship.primary = "earth";
    ship.elements = circularOrbit(earth.radius + 400e3, 0.09, 0, 0);
    ship.epoch = sim.world.t;
    const win = searchMoonWindow("earth", "moon", 0, (t) => shipRelativeState(ship, t), shipOsculatingElements(ship, 0).a)!;
    expect(win).not.toBeNull();
    planMoonTransfer(sim, id, "moon", win.tDepart, win.tArrive); // aims for DEFAULT_CAPTURE_ALT
    sim.step(win.tArrive + 2 * DAY - sim.world.t);
    expect(ship.transfer!.arrived).toBe(true);
    expect(ship.primary).toBe("moon");
    const el = shipOsculatingElements(ship, sim.world.t);
    const periAlt = el.a * (1 - el.e) - moon.radius;
    // The capture fires at the J2 approach leg's pinned periapsis; the J2-aware aim sizes the offset
    // so that periapsis equals the requested DEFAULT_CAPTURE_ALT. The pre-fix two-body aim missed
    // the flown J2 periapsis by O(100 m), so a tight tolerance here is the M1 regression lock.
    expect(Math.abs(periAlt - DEFAULT_CAPTURE_ALT)).toBeLessThan(50);
  });
});
