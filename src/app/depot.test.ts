import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import {
  spawnShip, defaultDesign, deployDepot, depotTransfer, depotCandidates, stationDepotStatus,
  DEFAULT_DEPOT_CAPACITY,
} from "./commands.ts";
import { dvRemaining, applyImpulsiveDv } from "@lightlag/engine/ships";
import { stationDockState } from "@lightlag/engine/depot";
import { shipPropAvailable, shipPropHeadroom } from "@lightlag/engine/refuel";
import { serializeWorld, deserializeWorld, hashWorld } from "@lightlag/engine/serialize";

/** Core-stage propellant a ship can give (active → tip). */
function avail(sim: Simulation, id: string): number {
  return shipPropAvailable(sim.world.ships.get(id)!);
}

describe("deployDepot", () => {
  it("anchors a depot, seeds it from the ship, and drains the ship by exactly that", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const before = avail(sim, id);

    const res = deployDepot(sim, id)!;
    expect(res.stationId).toBe("depot-1");
    expect(res.seededKg).toBeGreaterThan(0);

    const st = sim.world.stations.get("depot-1")!;
    expect(st.primary).toBe(sim.world.ships.get(id)!.primary);
    expect(st.depot!.propMass).toBeCloseTo(res.seededKg, 6);
    expect(st.depot!.propCapacity).toBe(DEFAULT_DEPOT_CAPACITY);
    expect(before - avail(sim, id)).toBeCloseTo(res.seededKg, 6); // mass conserved

    // The depot sits on the ship's live conic ⇒ an immediate rendezvous.
    expect(stationDockState(sim.world.ships.get(id)!, st, sim.world.t).docked).toBe(true);
    expect(depotCandidates(sim, id).map((c) => c.id)).toContain("depot-1");
  });

  it("rejects a ship that cannot dock (landed / lost / on a leg)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    sim.world.ships.get(id)!.landed = { bodyId: "earth", surfaceDir: { x: 1, y: 0, z: 0 } };
    expect(deployDepot(sim, id)).toBeNull();
    expect(sim.world.stations.size).toBe(0);
  });
});

describe("depotTransfer", () => {
  it("loads ship → depot and unloads depot → ship, conserving mass", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    deployDepot(sim, id); // drains the ship, opening headroom, and banks the propellant
    const depotFill = stationDepotStatus(sim, "depot-1")!.fill;
    const shipRoom = shipPropHeadroom(sim.world.ships.get(id)!);
    expect(shipRoom).toBeGreaterThan(0);

    // Unload back a chunk and confirm the mass moved and Δv rose.
    const dvBefore = dvRemaining(sim.world.ships.get(id)!);
    const un = depotTransfer(sim, id, "depot-1", "unload", 1000)!;
    expect(un.moved).toBeCloseTo(1000, 6);
    expect(un.depotFillAfter).toBeCloseTo(depotFill - 1000, 6);
    expect(dvRemaining(sim.world.ships.get(id)!)).toBeGreaterThan(dvBefore);

    // Load some of it back into the depot.
    const ld = depotTransfer(sim, id, "depot-1", "load", 500)!;
    expect(ld.moved).toBeCloseTo(500, 6);
    expect(ld.depotFillAfter).toBeCloseTo(depotFill - 1000 + 500, 6);
  });

  it("defaults the amount to the direction's cap", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    deployDepot(sim, id);
    const room = shipPropHeadroom(sim.world.ships.get(id)!);
    const un = depotTransfer(sim, id, "depot-1", "unload")!; // no amount ⇒ fill to capacity
    expect(un.moved).toBeCloseTo(room, 3);
    expect(shipPropHeadroom(sim.world.ships.get(id)!)).toBeCloseTo(0, 3);
  });

  it("is gated: not docked / different primary / missing depot ⇒ null", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    deployDepot(sim, id);

    // A ship on a different orbit is not docked with the depot.
    const far = spawnShip(sim, { ...defaultDesign(), altitudeKm: 1200 });
    applyImpulsiveDv(sim.world.ships.get(far)!, 800); // open some headroom
    expect(depotTransfer(sim, far, "depot-1", "unload")).toBeNull();

    // A ship about a different primary cannot use the depot.
    sim.world.ships.get(far)!.primary = "moon";
    expect(depotTransfer(sim, far, "depot-1", "unload")).toBeNull();

    // Unknown station / non-depot station.
    expect(depotTransfer(sim, id, "nope", "unload")).toBeNull();
  });
});

describe("depot — determinism", () => {
  it("a deploy + transfer world is chunk-invariant (one step ≡ irregular chunks)", () => {
    const build = (): Simulation => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, defaultDesign());
      deployDepot(sim, id);
      depotTransfer(sim, id, "depot-1", "unload", 1200);
      return sim;
    };
    const tEnd = 3e5;

    const one = build();
    one.step(tEnd);

    const chunked = build();
    const chunks = [86400, 1e6, 7, 250000, 0.5, 5e5, 3600];
    let i = 0;
    while (chunked.world.t < tEnd) chunked.step(Math.min(chunks[i++ % chunks.length]!, tEnd - chunked.world.t));

    expect(hashWorld(chunked.world)).toBe(hashWorld(one.world));
  });

  it("survives a serialize round-trip with a depot present, hash stable", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    deployDepot(sim, id);
    sim.step(1e4);

    const s1 = serializeWorld(sim.world);
    const w2 = deserializeWorld(s1);
    expect(serializeWorld(w2)).toBe(s1);
    expect(hashWorld(w2)).toBe(hashWorld(sim.world));
    const d = w2.stations.get("depot-1")!.depot!;
    expect(d.propCapacity).toBe(DEFAULT_DEPOT_CAPACITY);
    expect(d.propMass).toBeGreaterThan(0);
  });

  it("is golden-hash-neutral: an inert station serializes with no depot key", () => {
    const sim = new Simulation(createWorld(1, 0));
    sim.world.stations.set("gw", {
      id: "gw", name: "Gateway", primary: "earth",
      elements: { a: 7e6, e: 0.001, i: 0, Omega: 0, omega: 0, M: 0 },
    });
    const s = serializeWorld(sim.world);
    expect(s).not.toContain("depot");
    const station = JSON.parse(s).stations.gw;
    expect(Object.keys(station).sort()).toEqual(["elements", "id", "name", "primary"]);
  });
});
