import { describe, it, expect } from "vitest";
import { Simulation } from "@lightlag/engine/sim";
import { createWorld } from "@lightlag/engine/world";
import { tleToElementsAtEpoch, spawnSatellite, parseTleText, isSatelliteId } from "./satellites.ts";
import { TLE_SNAPSHOT } from "./data/tleSnapshot.ts";

const ISS = TLE_SNAPSHOT[0]!;
const RAD2DEG = 180 / Math.PI;

describe("TLE → engine elements", () => {
  it("ingests the ISS element set into a plausible LEO orbit at the right inclination", () => {
    const el = tleToElementsAtEpoch(ISS);
    expect(el).not.toBeNull();
    // Equatorial inclination used directly (no ecliptic rotation), matching the
    // hardcoded ISS body — so it lands at the real ~51.64°.
    expect(el!.i * RAD2DEG).toBeGreaterThan(51.3);
    expect(el!.i * RAD2DEG).toBeLessThan(52.0);
    // ~415 km LEO: semi-major axis ~6.79e6 m, near-circular.
    expect(el!.a).toBeGreaterThan(6.6e6);
    expect(el!.a).toBeLessThan(7.0e6);
    expect(el!.e).toBeLessThan(0.01);
  });

  it("parses 3-line (name + 2 lines) TLE text", () => {
    const tles = parseTleText(`${ISS.name}\n${ISS.line1}\n${ISS.line2}\n`);
    expect(tles.length).toBe(1);
    expect(tles[0]!.line1.startsWith("1 25544")).toBe(true);
    expect(tles[0]!.name).toBe(ISS.name);
  });
});

describe("spawnSatellite", () => {
  it("injects a read-only coasting ship about Earth", () => {
    // Start the sim near the TLE epoch (2008 day 264.518) so SGP4 propagation is
    // in its valid window.
    const epochMs = Date.UTC(2008, 0, 1) + (264.51782528 - 1) * 86400 * 1000;
    const tEpoch = (epochMs - Date.UTC(2000, 0, 1, 12)) / 1000;
    const sim = new Simulation(createWorld(1, tEpoch, "earth"));

    const id = spawnSatellite(sim, ISS);
    expect(id).toBe("sat-25544");
    expect(isSatelliteId(id!)).toBe(true);

    const ship = sim.world.ships.get(id!)!;
    expect(ship.primary).toBe("earth");
    expect(ship.mode).toBe("coast");
    expect(ship.stages).toEqual([]); // passive marker — no staged stack
    expect(ship.elements!.i * RAD2DEG).toBeGreaterThan(51.3);
    expect(ship.elements!.i * RAD2DEG).toBeLessThan(52.0);
  });
});
