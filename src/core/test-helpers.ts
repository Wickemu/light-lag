/**
 * Shared helpers for the core test suites. Not shipped — imported only by *.test.ts.
 */

import { createWorld } from "./world.ts";
import { Simulation } from "./sim.ts";
import { spawnShip, defaultDesign, planTransfer } from "../app/commands.ts";
import { computePorkchop } from "./maneuver/porkchop.ts";
import { circularOrbit } from "./orbit.ts";
import { BODY_BY_ID, DAY, DEG } from "./constants.ts";

const R_EARTH = BODY_BY_ID.get("earth")!.radius;
const R_MARS = BODY_BY_ID.get("mars")!.radius;

/** Run the sim until a (light-lagged) burn order is delivered and completes.
 *  Burns are commands that propagate at c, so for a LEO ship there is a tiny
 *  (~0.02 s) delivery delay before thrust begins; wait that out too. */
export function flyUntilCoast(sim: Simulation, shipId: string): void {
  const ship = sim.world.ships.get(shipId)!;
  const commandInFlight = (): boolean =>
    sim.world.messages.some((m) => m.kind === "command" && m.targetId === shipId);
  let guard = 0;
  while ((ship.mode === "thrust" || commandInFlight()) && guard++ < 200000) sim.step(10);
  if (ship.mode === "thrust") throw new Error("burn never completed");
}

/** The cheapest Earth→Mars window over one synodic period — the same porkchop
 *  search the sim tests use, factored out so every test flies the same transfer.
 *  Deterministic (a fixed grid search). */
export function marsWindow(): { depT: number; arrT: number } {
  const pork = computePorkchop({
    fromId: "earth", toId: "mars",
    depStart: 0, depEnd: 800 * DAY, depN: 60,
    tofMin: 120 * DAY, tofMax: 330 * DAY, tofN: 44,
    rParkFrom: R_EARTH + 4e5,
    rParkTo: R_MARS + 4e5,
  });
  const best = pork.best!;
  return { depT: best.depT, arrT: best.arrT };
}

/**
 * A fixed, scripted multi-system scenario for the golden-state determinism guard.
 * Everything in it is ANALYTIC + IMPULSIVE (Keplerian coast, impulsive injection
 * and capture, scheduled events) — there is NO finite-thrust integration — so the
 * final state is reached EXACTLY regardless of how the caller chunks time. `advance`
 * is the stepping strategy under test; it must drive the sim to the given tEnd.
 */
export function buildGoldenScenario(advance: (sim: Simulation, tEnd: number) => void): Simulation {
  const sim = new Simulation(createWorld(42, 0, "earth"));
  const win = marsWindow();

  // Ship A — a courier flying the full Earth→Mars transfer (impulsive injection at
  // departure, impulsive capture at periapsis; analytic coast between).
  const a = spawnShip(sim, defaultDesign());
  planTransfer(sim, a, "mars", win.depT, win.arrT);

  // Ship B — a hauler parked in a different LEO, left coasting (a second body in
  // the state, exercising multi-ship serialization & Map ordering).
  spawnShip(sim, {
    name: "Hauler", payloadMass: 8000, altitudeKm: 700, inclinationDeg: 51.6,
    stages: [{ name: "Core", dryMass: 6000, propMass: 40000, isp: 320, thrust: 8e5 }],
  });

  // Two stations (static analytic elements) to exercise the stations Map.
  sim.world.stations.set("leo-gw", {
    id: "leo-gw", name: "LEO Gateway", primary: "earth",
    elements: circularOrbit(R_EARTH + 4.2e5, 51.6 * DEG, 0, 0),
  });
  sim.world.stations.set("mars-gw", {
    id: "mars-gw", name: "Mars Gateway", primary: "mars",
    elements: circularOrbit(R_MARS + 5e5, 25 * DEG, 30 * DEG, 1),
  });

  // Advance past Mars arrival; the depart → SOI-crossing → capture cascade all
  // fires from the event queue along the way.
  advance(sim, win.arrT + 5 * DAY);
  return sim;
}
