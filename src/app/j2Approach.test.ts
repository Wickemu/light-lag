import { describe, it, expect } from "vitest";
import { createWorld } from "../core/world.ts";
import { Simulation } from "../core/sim.ts";
import { spawnShip, planAssist, looseCaptureApoAlt, type ShipDesign } from "./commands.ts";
import { searchAssist } from "../core/maneuver/assist.ts";
import { shipOsculatingElements } from "../core/ships.ts";
import { serializeWorld, deserializeWorld, hashWorld } from "../core/serialize.ts";
import { BODY_BY_ID, JULIAN_YEAR, DAY, DEFAULT_CAPTURE_ALT } from "../core/constants.ts";

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

describe("J2-perturbed approach, flown in-sim (Saturn capture)", () => {
  it("flies the approach as a J2 ApproachLeg and captures where the aim targeted (aim ≡ flight)", () => {
    const best = searchAssist("earth", "jupiter", "saturn", window)!;
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    const apoAlt = looseCaptureApoAlt("saturn", best.tArrive);
    planAssist(sim, id, "jupiter", "saturn", best.tDepart, best.tFlyby, best.tArrive, "propulsive", apoAlt);
    const ship = sim.world.ships.get(id)!;

    // Coarse-jump to before the Saturn approach, then step finely until capture, so we can
    // observe the J2 leg in flight (it owns the ship's state from SOI entry to periapsis —
    // a ~190-day arc at this arrival, well before the nominal arrival epoch).
    sim.step(best.tArrive - 250 * DAY - sim.world.t);
    let sawApproach = false;
    while (sim.world.t < best.tArrive + 400 * DAY && !ship.transfer!.arrived) {
      sim.step(3 * DAY);
      if (ship.approachLeg?.bodyId === "saturn") sawApproach = true;
    }

    expect(sawApproach).toBe(true); // the J2-perturbed approach flew as a read-time leg
    expect(ship.approachLeg).toBeUndefined(); // cleared at capture
    expect(ship.primary).toBe("saturn");
    expect(ship.transfer!.arrived).toBe(true);

    // The captured periapsis lands at the AIMED altitude despite Saturn's J2 single-pass
    // shift (~hundreds of km): the aim integrates the same j2Approach the flight does, so the
    // two agree. A two-body aim would miss the target periapsis by the shift.
    const el = shipOsculatingElements(ship, sim.world.t);
    const saturn = BODY_BY_ID.get("saturn")!;
    const periAltKm = (el.a * (1 - el.e) - saturn.radius) / 1000;
    expect(periAltKm).toBeGreaterThan(0); // above the surface (a two-body aim could go sub-surface)
    expect(Math.abs(periAltKm - DEFAULT_CAPTURE_ALT / 1000)).toBeLessThan(150); // == the aim, not off by the shift
  });

  it("is chunk-invariant (one-step ≡ chunked) and round-trips mid-approach", () => {
    const best = searchAssist("earth", "jupiter", "saturn", window)!;
    const apoAlt = looseCaptureApoAlt("saturn", best.tArrive);
    const run = (chunks: number): string => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, bigDesign());
      planAssist(sim, id, "jupiter", "saturn", best.tDepart, best.tFlyby, best.tArrive, "propulsive", apoAlt);
      const tEnd = best.tArrive + 60 * DAY;
      for (let i = 0; i < chunks; i++) sim.step(tEnd / chunks);
      return hashWorld(sim.world);
    };
    expect(run(1)).toBe(run(9));

    // Mid-approach (the active ApproachLeg) round-trips through serialize with a stable hash.
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, bigDesign());
    planAssist(sim, id, "jupiter", "saturn", best.tDepart, best.tFlyby, best.tArrive, "propulsive", apoAlt);
    sim.step(best.tArrive - 150 * DAY - sim.world.t);
    while (sim.world.t < best.tArrive + 60 * DAY && sim.world.ships.get(id)!.approachLeg === undefined) {
      sim.step(3 * DAY);
    }
    expect(sim.world.ships.get(id)!.approachLeg?.bodyId).toBe("saturn"); // caught mid-approach
    const restored = deserializeWorld(serializeWorld(sim.world));
    expect(restored.ships.get(id)!.approachLeg!.bodyId).toBe("saturn");
    expect(hashWorld(restored)).toBe(hashWorld(sim.world));
  });
});
