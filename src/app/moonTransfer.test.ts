import { describe, it, expect } from "vitest";
import { createWorld } from "../core/world.ts";
import { Simulation } from "../core/sim.ts";
import { spawnShip, planMoonTransfer, searchMoonWindow, type ShipDesign } from "./commands.ts";
import { shipRelativeState, shipOsculatingElements, dvRemaining } from "../core/ships.ts";
import { serializeWorld, deserializeWorld, hashWorld } from "../core/serialize.ts";
import { circularOrbit } from "../core/orbit.ts";
import { BODY_BY_ID, DAY } from "../core/constants.ts";

const EARTH = BODY_BY_ID.get("earth")!;
const MOON = BODY_BY_ID.get("moon")!;

function design(): ShipDesign {
  return {
    name: "Lunar", payloadMass: 500, altitudeKm: 400, inclinationDeg: 5,
    stages: [{ name: "Core", dryMass: 1200, propMass: 9000, isp: 360, thrust: 2e5 }],
  };
}
/** A ship in a ~400 km parking orbit about Earth. */
function leoShip(sim: Simulation): string {
  const id = spawnShip(sim, design());
  const ship = sim.world.ships.get(id)!;
  ship.primary = "earth";
  ship.elements = circularOrbit(EARTH.radius + 400e3, 0.09, 0, 0);
  ship.epoch = sim.world.t;
  return id;
}

describe("intra-system (moon) transfers", () => {
  it("flies LEO → a real lunar parking orbit for an Apollo-class Δv", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = leoShip(sim);
    const ship = sim.world.ships.get(id)!;
    const dv0 = dvRemaining(ship);

    const win = searchMoonWindow("earth", "moon", 0, (t) => shipRelativeState(ship, t), shipOsculatingElements(ship, 0).a)!;
    expect(win).not.toBeNull();
    const plan = planMoonTransfer(sim, id, "moon", win.tDepart, win.tArrive)!;
    expect(plan).not.toBeNull();
    expect(ship.transfer!.central).toBe("earth"); // cruises about Earth, not the Sun
    expect(plan.dvDepart / 1000).toBeGreaterThan(2.5); // a real translunar injection
    expect(plan.dvDepart / 1000).toBeLessThan(4);

    // Fly departure → moon SOI → capture.
    sim.step(win.tArrive + 2 * DAY - sim.world.t);
    expect(ship.transfer!.arrived).toBe(true);
    expect(ship.primary).toBe("moon");
    const el = shipOsculatingElements(ship, sim.world.t);
    expect(el.e).toBeLessThan(1); // captured (bound)
    const periAlt = el.a * (1 - el.e) - MOON.radius;
    expect(periAlt).toBeGreaterThan(0); // a real orbit ABOVE the lunar surface, not through it
    expect(periAlt).toBeLessThan(2000e3);

    // Total spent is injection + capture — a few km/s, well under the ship's budget.
    const spent = dv0 - dvRemaining(ship);
    expect(spent / 1000).toBeGreaterThan(3);
    expect(spent / 1000).toBeLessThan(6);
  });

  it("is deterministic across time-chunkings and round-trips through serialization", () => {
    const window = () => {
      const s = new Simulation(createWorld(1, 0));
      const id = leoShip(s);
      const ship = s.world.ships.get(id)!;
      return searchMoonWindow("earth", "moon", 0, (t) => shipRelativeState(ship, t), shipOsculatingElements(ship, 0).a)!;
    };
    const win = window();
    const runToHash = (chunks: number[]): string => {
      const sim = new Simulation(createWorld(1, 0));
      const id = leoShip(sim);
      planMoonTransfer(sim, id, "moon", win.tDepart, win.tArrive);
      const tEnd = win.tArrive + 3 * DAY;
      let i = 0;
      while (sim.world.t < tEnd) sim.step(Math.min(chunks[i++ % chunks.length]!, tEnd - sim.world.t));
      return hashWorld(sim.world);
    };
    expect(runToHash([1e10])).toBe(runToHash([7, 1e5, 0.5, 3600, 5e4]));

    // Mid-cruise the transfer (with central="earth") round-trips with a stable hash.
    const sim = new Simulation(createWorld(1, 0));
    const id = leoShip(sim);
    planMoonTransfer(sim, id, "moon", win.tDepart, win.tArrive);
    sim.step(win.tDepart + 2 * DAY - sim.world.t);
    expect(sim.world.ships.get(id)!.transfer!.central).toBe("earth");
    const ser = serializeWorld(sim.world);
    expect(serializeWorld(deserializeWorld(ser))).toBe(ser);
    expect(hashWorld(deserializeWorld(ser))).toBe(hashWorld(sim.world));
  });

  it("never picks a window whose outbound conic dives into Earth (no departure crash)", () => {
    // Regression: a moon transfer is flown about Earth, and an injection solved only against the
    // moon-relative arrival could — for an unfavourable parking-orbit phase — put the Earth-relative
    // outbound conic's periapsis BELOW Earth's surface, so the ship flew straight into Earth at
    // departure. searchMoonWindow must now reject those, picking only windows that clear the surface.
    // This 400 km / 28.5° parking orbit is exactly the geometry that used to crash (Falcon-Heavy-class).
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, design());
    const ship = sim.world.ships.get(id)!;
    ship.primary = "earth";
    ship.elements = circularOrbit(EARTH.radius + 400e3, 28.5 * (Math.PI / 180), 0, 0);
    ship.epoch = sim.world.t;

    const win = searchMoonWindow("earth", "moon", 0, (t) => shipRelativeState(ship, t), shipOsculatingElements(ship, 0).a)!;
    expect(win).not.toBeNull();

    const plan = planMoonTransfer(sim, id, "moon", win.tDepart, win.tArrive);
    expect(plan).not.toBeNull();

    // Just after departure the ship is on the outbound conic — its Earth-relative periapsis must
    // clear the surface (else the sim's impact guard destroys it).
    sim.step(win.tDepart + 60 - sim.world.t);
    const elOut = shipOsculatingElements(ship, sim.world.t);
    expect(ship.status ?? "ok").toBe("ok");
    expect(elOut.a * (1 - elOut.e)).toBeGreaterThanOrEqual(EARTH.radius);

    // And it completes the transfer: captured at the Moon, never lost.
    sim.step(win.tArrive + 3 * DAY - sim.world.t);
    expect(ship.status ?? "ok").toBe("ok");
    expect(ship.primary).toBe("moon");
    expect(ship.transfer!.arrived).toBe(true);
  });

  it("rejects a moon whose parent isn't the ship's current primary", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = leoShip(sim); // at Earth
    // Europa orbits Jupiter, not Earth — not directly reachable.
    expect(planMoonTransfer(sim, id, "europa", 0, 5 * DAY)).toBeNull();
    expect(searchMoonWindow("earth", "europa", 0, (t) => shipRelativeState(sim.world.ships.get(id)!, t), 1e7)).toBeNull();
  });
});
