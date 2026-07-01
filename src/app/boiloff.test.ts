import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import { spawnShip, defaultDesign, type ShipDesign } from "./commands.ts";
import { dvRemaining } from "@lightlag/engine/ships";
import { shipPropAvailable } from "@lightlag/engine/refuel";
import { circularOrbit } from "@lightlag/engine/orbit";
import { serializeWorld, deserializeWorld, hashWorld } from "@lightlag/engine/serialize";
import { AU, BODY_BY_ID } from "@lightlag/engine/constants";

const DAY = 86400;

/** A cryogenic in-space tug (a single LH₂/LOX stage that boils off). */
function cryoDesign(): ShipDesign {
  return {
    name: "Cryo Tug", payloadMass: 2000, altitudeKm: 400, inclinationDeg: 28.5,
    stages: [{ name: "Cryo", dryMass: 3000, propMass: 20_000, isp: 450, thrust: 2e5, boiloff: 0.02 }],
  };
}

describe("boiloff — a parked cryo stage bleeds propellant and Δv", () => {
  it("loses propellant over days in LEO (≈2 %/day) and lowers Δv", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, cryoDesign());
    const ship = sim.world.ships.get(id)!;
    const prop0 = shipPropAvailable(ship);
    const dv0 = dvRemaining(ship);

    sim.step(10 * DAY); // ~10 daily boil-off ticks
    const frac = shipPropAvailable(ship) / prop0;
    expect(frac).toBeLessThan(1); // propellant fell
    expect(frac).toBeGreaterThan(0.79); // ~exp(−0.2·~1.03) ≈ 0.81 near perihelion
    expect(frac).toBeLessThan(0.84);
    expect(dvRemaining(ship)).toBeLessThan(dv0); // less m₀ ⇒ less Δv
  });

  it("leaves a storable design (defaultDesign) untouched — no boil-off key, Δv unchanged", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign()); // Isp 300/340 — storable
    const ship = sim.world.ships.get(id)!;
    const dv0 = dvRemaining(ship);
    sim.step(30 * DAY);
    expect(dvRemaining(ship)).toBe(dv0); // nothing boiled off
    expect(serializeWorld(sim.world)).not.toContain("boiloff");
  });
});

describe("boiloff — determinism", () => {
  it("is chunk-invariant: one big step ≡ irregular chunks (identical hash)", () => {
    const build = (): Simulation => {
      const sim = new Simulation(createWorld(1, 0));
      spawnShip(sim, cryoDesign());
      return sim;
    };
    const tEnd = 40 * DAY;

    const one = build();
    one.step(tEnd);

    const chunked = build();
    const chunks = [DAY, 1e6, 7, 250_000, 0.5, 5e5, 3600];
    let i = 0;
    while (chunked.world.t < tEnd) chunked.step(Math.min(chunks[i++ % chunks.length]!, tEnd - chunked.world.t));

    expect(hashWorld(chunked.world)).toBe(hashWorld(one.world));
  });

  it("survives a serialize round-trip with a stable hash", () => {
    const sim = new Simulation(createWorld(1, 0));
    spawnShip(sim, cryoDesign());
    sim.step(5 * DAY);
    const restored = deserializeWorld(serializeWorld(sim.world));
    expect(hashWorld(restored)).toBe(hashWorld(sim.world));
    expect(serializeWorld(sim.world)).toContain("boiloff"); // the tag round-trips
  });
});

describe("boiloff — physical behaviour", () => {
  it("a cryo stage far from the Sun boils off far slower than the same stage in LEO", () => {
    const near = new Simulation(createWorld(1, 0));
    const nId = spawnShip(near, cryoDesign()); // ~1 AU (LEO about Earth)
    const nShip = near.world.ships.get(nId)!;
    const nProp0 = shipPropAvailable(nShip);

    const far = new Simulation(createWorld(1, 0));
    const fId = spawnShip(far, cryoDesign()); // tick already armed at spawn…
    const fShip = far.world.ships.get(fId)!;
    fShip.primary = "sun"; // …now relocate it to a ~5 AU heliocentric orbit
    fShip.elements = circularOrbit(5 * AU, 0, 0, 0);
    fShip.epoch = far.world.t;
    const fProp0 = shipPropAvailable(fShip);

    near.step(20 * DAY);
    far.step(20 * DAY);

    const nearLost = 1 - shipPropAvailable(nShip) / nProp0;
    const farLost = 1 - shipPropAvailable(fShip) / fProp0;
    expect(farLost).toBeGreaterThan(0); // still some loss
    expect(farLost).toBeLessThan(nearLost / 10); // ~1/25 the rate at 5 AU
  });

  it("a lost ship (wreck) stops boiling off", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, cryoDesign());
    const ship = sim.world.ships.get(id)!;
    ship.status = "lost";
    const prop0 = shipPropAvailable(ship);
    sim.step(30 * DAY);
    expect(shipPropAvailable(ship)).toBe(prop0); // frozen — no boil-off ticks applied
  });
});

describe("boiloff — golden-hash neutrality", () => {
  it("a world of only storable ships hashes independent of the boil-off model", () => {
    // The golden scenario uses storable designs (Isp 300/320/340); a storable ship here
    // carries no boiloff field and no tick, so its serialization is byte-for-byte unchanged.
    const sim = new Simulation(createWorld(1, 0));
    spawnShip(sim, defaultDesign());
    const s = serializeWorld(sim.world);
    expect(s).not.toContain("boiloff");
    expect(BODY_BY_ID.get("earth")).toBeDefined(); // sanity: catalog intact
  });
});
