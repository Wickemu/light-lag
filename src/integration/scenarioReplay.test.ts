/**
 * Scenario replay across a full mission — the headline guarantee of the sandbox's
 * replay/scrub feature: snapshotting a live simulation and restoring it reproduces
 * the subsequent run BYTE-FOR-BYTE, including the event cascade (SOI crossing,
 * capture) that fires after the snapshot.
 *
 * This is an app↔engine integration test: it drives the kernel through the game's
 * command layer (`planTransfer`), so it lives on the app side (the engine package
 * stays free of any game dependency).
 */
import { describe, it, expect } from "vitest";
import { Simulation } from "@lightlag/engine/sim";
import { createWorld } from "@lightlag/engine/world";
import { hashWorld } from "@lightlag/engine/serialize";
import { snapshot, restore } from "@lightlag/engine/scenario";
import { DAY } from "@lightlag/engine/constants";
import { spawnShip, defaultDesign, planTransfer } from "../app/commands.ts";
import { marsWindow } from "./test-helpers.ts";

/** A ship committed to the cheapest Earth→Mars transfer (analytic + impulsive). */
function flownSim(): { sim: Simulation; shipId: string; win: { depT: number; arrT: number } } {
  const sim = new Simulation(createWorld(42, 0, "earth"));
  const shipId = spawnShip(sim, defaultDesign());
  const win = marsWindow();
  planTransfer(sim, shipId, "mars", win.depT, win.arrT);
  return { sim, shipId, win };
}

describe("scenario replay across mission events", () => {
  it("restoring mid-cruise reproduces the SOI-crossing + capture cascade byte-for-byte", () => {
    const { sim, win } = flownSim();
    sim.step((win.depT + win.arrT) / 2); // mid-cruise: departed, SOI/capture still ahead
    const snap = snapshot(sim);

    const tEnd = win.arrT + 5 * DAY;
    sim.step(tEnd - sim.world.t);
    const hUninterrupted = hashWorld(sim.world);

    const sim2 = restore(snap);
    sim2.step(tEnd - sim2.world.t);
    expect(hashWorld(sim2.world)).toBe(hUninterrupted);
  });

  it("restoring shortly before arrival still captures into the same Mars orbit", () => {
    const { sim, shipId, win } = flownSim();
    sim.step(win.arrT - 2 * DAY);
    const snap = snapshot(sim);

    const tEnd = win.arrT + 10 * DAY;
    sim.step(tEnd - sim.world.t);
    const hUninterrupted = hashWorld(sim.world);

    const sim2 = restore(snap);
    sim2.step(tEnd - sim2.world.t);
    expect(hashWorld(sim2.world)).toBe(hUninterrupted);

    // ...and the cascade genuinely happened: captured into orbit about Mars.
    const ship = sim.world.ships.get(shipId)!;
    expect(ship.primary).toBe("mars");
    expect(ship.transfer?.arrived).toBe(true);
  });
});
