import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import {
  spawnShip, planAssist, planChainAssist, assistCapturePreview, looseCaptureApoAlt, type ShipDesign,
} from "./commands.ts";
import { searchAssist } from "@lightlag/engine/maneuver/assist";
import { shipOsculatingElements } from "@lightlag/engine/ships";
import { serializeWorld, deserializeWorld, hashWorld } from "@lightlag/engine/serialize";
import { BODY_BY_ID, JULIAN_YEAR, DAY } from "@lightlag/engine/constants";

// A high-Δv craft so injection + flyby never mask the capture comparison.
function bigDesign(): ShipDesign {
  return {
    name: "Orbiter", payloadMass: 500, altitudeKm: 400, inclinationDeg: 28.5,
    stages: [{ name: "Core", dryMass: 1500, propMass: 80000, isp: 460, thrust: 5e5 }],
  };
}

const window = {
  tDepart: 30 * JULIAN_YEAR,
  flybyWindow: [31.5 * JULIAN_YEAR, 34 * JULIAN_YEAR] as [number, number],
  arriveWindow: [36 * JULIAN_YEAR, 42 * JULIAN_YEAR] as [number, number],
  steps: 24,
};

describe("gravity-assist arrival capture geometry (Earth → Jupiter → Saturn)", () => {
  it("an elliptical SOI insertion costs far less than a low-circular capture", () => {
    const best = searchAssist("earth", "jupiter", "saturn", window)!;
    expect(best).toBeTruthy();
    const circular = assistCapturePreview("saturn", best.vInfArrive, "propulsive")!;
    const apoAlt = looseCaptureApoAlt("saturn", best.tArrive);
    const ellipse = assistCapturePreview("saturn", best.vInfArrive, "propulsive", apoAlt)!;
    // Real Saturn orbit insertion is a few km/s into a loose ellipse, NOT the ~10+ km/s
    // a low circular capture from a fast assist arrival demands.
    expect(circular.dvArrive).toBeGreaterThan(8000);
    expect(ellipse.dvArrive).toBeLessThan(0.25 * circular.dvArrive);
    expect(ellipse.aero).toBe(false);
  });

  it("flies the elliptical capture in-sim: bound, low periapsis, high apoapsis", () => {
    const best = searchAssist("earth", "jupiter", "saturn", window)!;
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    const apoAlt = looseCaptureApoAlt("saturn", best.tArrive);
    const plan = planAssist(sim, id, "jupiter", "saturn", best.tDepart, best.tFlyby, best.tArrive, "propulsive", apoAlt)!;
    expect(plan).toBeTruthy();
    const ship = sim.world.ships.get(id)!;
    expect(ship.transfer!.captureApoAlt).toBeCloseTo(apoAlt, 0);

    // Fly the whole mission.
    sim.step(best.tArrive + 30 * DAY);
    expect(ship.primary).toBe("saturn");
    expect(ship.transfer!.arrived).toBe(true);

    const el = shipOsculatingElements(ship, sim.world.t);
    const saturn = BODY_BY_ID.get("saturn")!;
    expect(el.e).toBeGreaterThan(0.8); // a genuinely eccentric capture ellipse
    expect(el.e).toBeLessThan(1); // bound, not still hyperbolic
    const periAltKm = (el.a * (1 - el.e) - saturn.radius) / 1000;
    const apoAltKm = (el.a * (1 + el.e) - saturn.radius) / 1000;
    expect(periAltKm).toBeGreaterThan(0); // periapsis clear of the surface
    expect(periAltKm).toBeLessThan(5000); // and low (Oberth-efficient)
    expect(apoAltKm).toBeGreaterThan(1e6); // a vast, loose ellipse
  });

  it("the captureApoAlt transfer round-trips through serialize with a stable hash", () => {
    const best = searchAssist("earth", "jupiter", "saturn", window)!;
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    const apoAlt = looseCaptureApoAlt("saturn", best.tArrive);
    planAssist(sim, id, "jupiter", "saturn", best.tDepart, best.tFlyby, best.tArrive, "propulsive", apoAlt);
    sim.step(window.tDepart + 100 * DAY);
    const restored = deserializeWorld(serializeWorld(sim.world));
    expect(restored.ships.get(id)!.transfer!.captureApoAlt).toBeCloseTo(apoAlt, 0);
    expect(hashWorld(restored)).toBe(hashWorld(sim.world));
  });

  it("an elliptical capture is exactly chunk-invariant (one-step == chunked)", () => {
    const best = searchAssist("earth", "jupiter", "saturn", window)!;
    const apoAlt = looseCaptureApoAlt("saturn", best.tArrive);
    const run = (chunks: number): string => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, bigDesign());
      planAssist(sim, id, "jupiter", "saturn", best.tDepart, best.tFlyby, best.tArrive, "propulsive", apoAlt);
      const total = best.tArrive + 30 * DAY;
      for (let i = 0; i < chunks; i++) sim.step(total / chunks);
      return hashWorld(sim.world);
    };
    expect(run(1)).toBe(run(7));
  });

  it("aerocapture via assist: feasible at an atmosphere, rejected at an airless target", () => {
    const best = searchAssist("earth", "jupiter", "saturn", window)!;
    // Saturn has an atmosphere — but a fast assist arrival is far too hot to aerocapture,
    // so the corridor solver honestly rejects it.
    const aeroSaturn = assistCapturePreview("saturn", best.vInfArrive, "aerocapture");
    expect(aeroSaturn).toBeNull();
    // A modest arrival speed at Mars aerocaptures for a small trim.
    const aeroMars = assistCapturePreview("mars", 2600, "aerocapture");
    expect(aeroMars).toBeTruthy();
    expect(aeroMars!.aero).toBe(true);
    expect(aeroMars!.dvArrive).toBeLessThan(500); // just a periapsis-raise trim
    // Airless body: aerocapture is impossible.
    expect(assistCapturePreview("mercury", 2600, "aerocapture")).toBeNull();
  });

  it("planChainAssist threads the capture choice too", () => {
    const best = searchAssist("earth", "jupiter", "saturn", window)!;
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    const apoAlt = looseCaptureApoAlt("saturn", best.tArrive);
    const res = planChainAssist(sim, id, ["earth", "jupiter", "saturn"],
      [best.tDepart, best.tFlyby, best.tArrive], "propulsive", apoAlt);
    expect(res).toBeTruthy();
    expect(sim.world.ships.get(id)!.transfer!.captureApoAlt).toBeCloseTo(apoAlt, 0);
  });
});
