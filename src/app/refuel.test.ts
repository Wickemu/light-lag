import { describe, it, expect } from "vitest";
import { createWorld, type Ship } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import {
  spawnShip, defaultDesign, transferPropellant, assembleShips, dockCandidates, shipPropStatus,
} from "./commands.ts";
import { dvRemaining, totalMass, applyImpulsiveDv } from "@lightlag/engine/ships";
import { dockState, shipPropHeadroom, DOCK_DISTANCE } from "@lightlag/engine/refuel";
import { serializeWorld, deserializeWorld, hashWorld } from "@lightlag/engine/serialize";

/** Total propellant aboard a ship (all stages). */
function totalProp(ship: Ship): number {
  return ship.stages.reduce((s, st) => s + st.propMass, 0);
}

/** Two ships spawned from the same design share an identical orbit ⇒ an exact
 *  (zero-distance) rendezvous, the cleanest way to put a depot and a client docked. */
function dockedPair(sim: Simulation): [string, string] {
  return [spawnShip(sim, defaultDesign()), spawnShip(sim, defaultDesign())];
}

describe("tank capacity", () => {
  it("spawnShip records each stage's capacity as its as-built full load", () => {
    const sim = new Simulation(createWorld(1, 0));
    const ship = sim.world.ships.get(spawnShip(sim, defaultDesign()))!;
    for (const st of ship.stages) expect(st.propCapacity).toBe(st.propMass);
    expect(shipPropHeadroom(ship)).toBe(0); // freshly fuelled ⇒ no headroom
  });

  it("a burn opens headroom equal to the propellant spent", () => {
    const sim = new Simulation(createWorld(1, 0));
    const ship = sim.world.ships.get(spawnShip(sim, defaultDesign()))!;
    const propBefore = totalProp(ship);
    applyImpulsiveDv(ship, 1000);
    expect(shipPropHeadroom(ship)).toBeCloseTo(propBefore - totalProp(ship), 3);
  });
});

describe("rendezvous gate", () => {
  it("two ships on the same orbit are docked (0 distance, 0 relative speed)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const [a, b] = dockedPair(sim);
    const d = dockState(sim.world.ships.get(a)!, sim.world.ships.get(b)!, sim.world.t);
    expect(d.distance).toBeCloseTo(0, 3);
    expect(d.relSpeed).toBeCloseTo(0, 3);
    expect(d.docked).toBe(true);
    expect(dockCandidates(sim, a).map((c) => c.id)).toContain(b);
  });

  it("ships on different orbits are NOT docked", () => {
    const sim = new Simulation(createWorld(1, 0));
    const a = spawnShip(sim, defaultDesign());
    const c = spawnShip(sim, { ...defaultDesign(), altitudeKm: 800 });
    const d = dockState(sim.world.ships.get(a)!, sim.world.ships.get(c)!, sim.world.t);
    expect(d.distance).toBeGreaterThan(DOCK_DISTANCE);
    expect(dockCandidates(sim, a).map((x) => x.id)).not.toContain(c);
    expect(transferPropellant(sim, a, c)).toBeNull();
  });

  it("a busy ship (thrusting / on a leg) is not a dock candidate", () => {
    const sim = new Simulation(createWorld(1, 0));
    const [a, b] = dockedPair(sim);
    sim.world.ships.get(b)!.mode = "thrust"; // mid-burn ⇒ not free to dock
    expect(dockCandidates(sim, a)).toHaveLength(0);
    expect(transferPropellant(sim, a, b)).toBeNull();
  });

  it("ships about different primaries cannot transfer", () => {
    const sim = new Simulation(createWorld(1, 0));
    const [a, b] = dockedPair(sim);
    sim.world.ships.get(b)!.primary = "moon";
    expect(transferPropellant(sim, a, b)).toBeNull();
  });
});

describe("propellant transfer", () => {
  it("conserves mass: the receiver gains exactly what the donor loses", () => {
    const sim = new Simulation(createWorld(1, 0));
    const [a, b] = dockedPair(sim);
    const donor = sim.world.ships.get(a)!;
    const receiver = sim.world.ships.get(b)!;
    applyImpulsiveDv(receiver, 1500); // open headroom on the receiver

    const donorBefore = totalProp(donor);
    const receiverBefore = totalProp(receiver);
    const dvReceiverBefore = dvRemaining(receiver);
    const dvDonorBefore = dvRemaining(donor);

    const res = transferPropellant(sim, a, b)!; // default ⇒ fill the receiver
    expect(res.moved).toBeGreaterThan(0);

    // Total propellant unchanged; the deltas mirror across the two hulls.
    expect(totalProp(donor) + totalProp(receiver)).toBeCloseTo(donorBefore + receiverBefore, 2);
    expect(totalProp(receiver) - receiverBefore).toBeCloseTo(res.moved, 2);
    expect(donorBefore - totalProp(donor)).toBeCloseTo(res.moved, 2);

    // Δv shifts the right way: receiver up, donor down.
    expect(dvRemaining(receiver)).toBeGreaterThan(dvReceiverBefore);
    expect(dvRemaining(donor)).toBeLessThan(dvDonorBefore);
    expect(res.receiverDvAfter).toBeCloseTo(dvRemaining(receiver), 6);

    // The donor had ample propellant, so the receiver tops back up to capacity.
    expect(shipPropHeadroom(receiver)).toBeLessThan(1);
  });

  it("never over-fills the receiver beyond tank capacity", () => {
    const sim = new Simulation(createWorld(1, 0));
    const [a, b] = dockedPair(sim);
    applyImpulsiveDv(sim.world.ships.get(b)!, 2000);
    transferPropellant(sim, a, b, 1e12); // absurd request
    const receiver = sim.world.ships.get(b)!;
    for (const st of receiver.stages) {
      expect(st.propMass).toBeLessThanOrEqual((st.propCapacity ?? st.propMass) + 1e-6);
    }
    expect(shipPropHeadroom(receiver)).toBeLessThan(1);
  });

  it("never overdraws the donor below empty", () => {
    const sim = new Simulation(createWorld(1, 0));
    const [a, b] = dockedPair(sim);
    const donor = sim.world.ships.get(a)!;
    applyImpulsiveDv(donor, 5000); // run the donor down
    applyImpulsiveDv(sim.world.ships.get(b)!, 6000); // big headroom on the receiver
    const donorAvail = shipPropStatus(sim, a)!.available;

    const res = transferPropellant(sim, a, b, 1e12)!;
    expect(res.moved).toBeCloseTo(donorAvail, 2); // gave all it had, no more
    for (const st of donor.stages) expect(st.propMass).toBeGreaterThanOrEqual(0);
    expect(shipPropStatus(sim, a)!.available).toBeLessThan(1); // donor drained
  });
});

describe("in-orbit assembly", () => {
  it("merges stacks and payload, conserves mass, consumes the added ship", () => {
    const sim = new Simulation(createWorld(1, 0));
    const [a, b] = dockedPair(sim);
    const base = sim.world.ships.get(a)!;
    const add = sim.world.ships.get(b)!;

    const wetBefore = totalMass(base) + totalMass(add);
    const baseStages = base.stages.length;
    const addStages = add.stages.length;
    const basePayload = base.payloadMass;
    const addPayload = add.payloadMass;

    const res = assembleShips(sim, a, b)!;

    expect(sim.world.ships.has(b)).toBe(false); // the added ship is consumed
    expect(base.stages.length).toBe(baseStages + addStages); // stacks concatenated
    expect(base.activeStage).toBe(0);
    expect(base.payloadMass).toBeCloseTo(basePayload + addPayload, 6);
    expect(res.wetMass).toBeCloseTo(wetBefore, 2); // mass conserved
    expect(res.dvAfter).toBeGreaterThan(0);
  });

  it("assembling a fuel module onto a ship raises its Δv", () => {
    const sim = new Simulation(createWorld(1, 0));
    const [a, b] = dockedPair(sim);
    const base = sim.world.ships.get(a)!;
    const dvBefore = dvRemaining(base);
    const res = assembleShips(sim, a, b)!;
    expect(res.dvAfter).toBeGreaterThan(dvBefore); // more stages → more Δv
  });

  it("cannot assemble a ship with itself or an undocked partner", () => {
    const sim = new Simulation(createWorld(1, 0));
    const a = spawnShip(sim, defaultDesign());
    const c = spawnShip(sim, { ...defaultDesign(), altitudeKm: 800 });
    expect(assembleShips(sim, a, a)).toBeNull();
    expect(assembleShips(sim, a, c)).toBeNull();
  });
});

describe("determinism", () => {
  it("a refuelled world serializes, round-trips, and stays hash-stable", () => {
    const sim = new Simulation(createWorld(1, 0));
    const [a, b] = dockedPair(sim);
    applyImpulsiveDv(sim.world.ships.get(b)!, 1200);
    transferPropellant(sim, a, b);

    const s1 = serializeWorld(sim.world);
    const w2 = deserializeWorld(s1);
    expect(serializeWorld(w2)).toBe(s1);
    expect(hashWorld(w2)).toBe(hashWorld(sim.world));
    expect(w2.ships.get(a)!.stages[0]!.propCapacity).toBeGreaterThan(0); // capacity survives
  });
});
