import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import { spawnShip, defaultDesign, dispatchInterstellar, interstellarFleet, interstellarStarList } from "./commands.ts";
import { hashWorld } from "@lightlag/engine/serialize";
import { G0 } from "@lightlag/engine/constants";

/** A default design with a custom name, for ordering assertions. */
const named = (name: string) => ({ ...defaultDesign(), name });

describe("interstellarFleet — the interstellar FOLLOW selector source", () => {
  it("is empty when no ship is on a leg", () => {
    const sim = new Simulation(createWorld(1, 0));
    spawnShip(sim, defaultDesign()); // coasting in LEO, never dispatched
    expect(interstellarFleet(sim.world)).toEqual([]);
  });

  it("lists a dispatched ship by id and name", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, named("Voyager"));
    dispatchInterstellar(sim, id, "proxima", G0);
    expect(interstellarFleet(sim.world)).toEqual([{ id, name: "Voyager" }]);
  });

  it("excludes ships not on an interstellar leg", () => {
    const sim = new Simulation(createWorld(1, 0));
    const coasting = spawnShip(sim, named("Parked"));
    const flying = spawnShip(sim, named("Crossing"));
    dispatchInterstellar(sim, flying, "proxima", G0);

    const fleet = interstellarFleet(sim.world);
    expect(fleet.map((f) => f.id)).toEqual([flying]);
    expect(fleet.some((f) => f.id === coasting)).toBe(false);
  });

  it("drops a ship marked lost even if a leg lingers on the record", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, named("Doomed"));
    dispatchInterstellar(sim, id, "proxima", G0);
    expect(interstellarFleet(sim.world).length).toBe(1);

    sim.world.ships.get(id)!.status = "lost";
    expect(interstellarFleet(sim.world)).toEqual([]);
  });

  it("orders the fleet deterministically by name", () => {
    const sim = new Simulation(createWorld(1, 0));
    const zeta = spawnShip(sim, named("Zeta"));
    const alpha = spawnShip(sim, named("Alpha"));
    dispatchInterstellar(sim, zeta, "proxima", G0);
    dispatchInterstellar(sim, alpha, "barnard", G0);

    expect(interstellarFleet(sim.world).map((f) => f.name)).toEqual(["Alpha", "Zeta"]);
  });

  it("is a read-only query — the world hash is unmoved by listing the fleet", () => {
    // The whole follow feature is render/UI; nothing it touches reaches WorldState,
    // so the golden-state determinism oracle stays put. Guard that here.
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, named("Pathfinder"));
    dispatchInterstellar(sim, id, "proxima", G0);

    const before = hashWorld(sim.world);
    interstellarFleet(sim.world);
    interstellarFleet(sim.world);
    expect(hashWorld(sim.world)).toBe(before);
  });
});

describe("interstellarStarList — the interstellar STARS picker source", () => {
  it("lists the navigable systems with the display fields", () => {
    const list = interstellarStarList();
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) {
      expect(typeof s.id).toBe("string");
      expect(typeof s.name).toBe("string");
      expect(Number.isFinite(s.distanceLy)).toBe(true);
      expect(typeof s.spectralType).toBe("string");
    }
  });

  it("is sorted nearest-first, ties broken by id", () => {
    const list = interstellarStarList();
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!;
      const b = list[i]!;
      expect(a.distanceLy < b.distanceLy || (a.distanceLy === b.distanceLy && a.id <= b.id)).toBe(true);
    }
  });

  it("includes a known nearby system and is deterministic", () => {
    const list = interstellarStarList();
    expect(list.some((s) => s.id === "proxima")).toBe(true);
    // Pure catalog query: repeated calls return identical data (stable menu order).
    expect(interstellarStarList()).toEqual(list);
  });
});
