import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import { spawnShip, type ShipDesign } from "./commands.ts";
import { serializeWorld, deserializeWorld, hashWorld } from "@lightlag/engine/serialize";
import { shipRelativeState } from "@lightlag/engine/ships";
import { lagrangeState } from "@lightlag/engine/maneuver/lagrange";
import { stateToElements } from "@lightlag/engine/math/kepler";
import { length, sub } from "@lightlag/engine/math/vec3";
import { BODY_BY_ID, MU_SUN, DAY } from "@lightlag/engine/constants";

function geoSat(): ShipDesign {
  return {
    name: "Comsat", payloadMass: 1000, altitudeKm: 35786, inclinationDeg: 0,
    stages: [{ name: "Bus", dryMass: 800, propMass: 2000, isp: 320, thrust: 4e3 }],
  };
}

describe("flown perturbed propagation — opt-in, hash-neutral by default", () => {
  it("a default (game-mode) ship serializes with no fidelity / perturbedLeg fields", () => {
    const sim = new Simulation(createWorld(1, 0));
    spawnShip(sim, geoSat());
    const json = serializeWorld(sim.world);
    expect(json).not.toContain("perturbedLeg");
    expect(json).not.toContain("fidelity");
  });

  it("flyPerturbed arms a leg and the ship keeps re-arming successive chunks (continuous perturbed flight)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, geoSat());
    expect(sim.flyPerturbed(id)).toBe(true);
    const ship = sim.world.ships.get(id)!;
    expect(ship.fidelity).toBe("perturbed");
    expect(ship.perturbedLeg?.bodyId).toBe("earth");
    // The Moon and Sun are the dominant perturbers selected for a GEO orbit.
    expect(ship.perturbedLeg!.perturbers.sort()).toContain("moon");

    const firstLegEnd = ship.perturbedLeg!.tEnd;
    sim.step(firstLegEnd + 5 * DAY - sim.world.t); // past the first finalize → a new leg armed
    expect(ship.status).not.toBe("lost");
    expect(ship.fidelity).toBe("perturbed");
    expect(ship.perturbedLeg).toBeDefined();
    expect(ship.perturbedLeg!.tStart).toBeGreaterThan(firstLegEnd - 1); // a fresh chunk
  });

  it("is chunk-invariant: one step ≡ many irregular chunks across several leg re-arms", () => {
    const run = (chunks: number): string => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, geoSat());
      sim.flyPerturbed(id);
      const tEnd = 80 * DAY; // spans ~2 leg horizons + re-arms
      for (let i = 0; i < chunks; i++) sim.step(tEnd / chunks);
      return hashWorld(sim.world);
    };
    expect(run(1)).toBe(run(7));
  });

  it("round-trips mid-leg through serialize with a stable hash", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, geoSat());
    sim.flyPerturbed(id);
    sim.step(10 * DAY);
    expect(sim.world.ships.get(id)!.perturbedLeg?.bodyId).toBe("earth");
    const restored = deserializeWorld(serializeWorld(sim.world));
    expect(restored.ships.get(id)!.perturbedLeg?.bodyId).toBe("earth");
    expect(restored.ships.get(id)!.perturbedLeg!.perturbers.length).toBeGreaterThan(0);
    expect(hashWorld(restored)).toBe(hashWorld(sim.world));
  });

  it("stopPerturbed reverts a ship to a plain game-mode coast", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, geoSat());
    sim.flyPerturbed(id);
    sim.step(10 * DAY);
    sim.stopPerturbed(id);
    const ship = sim.world.ships.get(id)!;
    expect(ship.fidelity).toBeUndefined();
    expect(ship.perturbedLeg).toBeUndefined();
    expect(ship.elements).toBeDefined(); // re-osculated onto a conic
  });
});

describe("flown perturbed propagation — the Lagrange-point gap", () => {
  it("a craft at Sun–Earth L2 flown perturbed drifts off where a game-mode craft stays pinned to the conic", () => {
    const earth = BODY_BY_ID.get("earth")!;
    const t0 = 50 * DAY;
    const l2 = lagrangeState(earth, "L2", t0); // heliocentric absolute state of Sun–Earth L2

    // Two identical ships parked at L2, one game-mode, one perturbed.
    const setup = (perturbed: boolean) => {
      const sim = new Simulation(createWorld(1, t0));
      const id = spawnShip(sim, geoSat());
      const ship = sim.world.ships.get(id)!;
      ship.primary = "sun";
      ship.mode = "coast";
      ship.r = undefined;
      ship.v = undefined;
      ship.elements = stateToElements(l2.r, l2.v, MU_SUN);
      ship.epoch = t0;
      if (perturbed) sim.flyPerturbed(id, { perturbers: [{ id: "earth", mu: earth.mu }] });
      return { sim, id };
    };

    const game = setup(false);
    const pert = setup(true);
    const span = 40 * DAY;
    game.sim.step(span);
    pert.sim.step(span);

    const t = t0 + span;
    const gameR = shipRelativeState(game.sim.world.ships.get(game.id)!, t).r;
    const pertR = shipRelativeState(pert.sim.world.ships.get(pert.id)!, t).r;
    const drift = length(sub(pertR, gameR));
    // eslint-disable-next-line no-console
    console.log(`L2 flown drift (perturbed − game-mode) after ${span / DAY}d ≈ ${(drift / 1e6).toFixed(1)} Mm`);
    expect(drift).toBeGreaterThan(1e6); // the perturbed craft truly leaves the kinematic point
    expect(pert.sim.world.ships.get(pert.id)!.status).not.toBe("lost");
  });
});
