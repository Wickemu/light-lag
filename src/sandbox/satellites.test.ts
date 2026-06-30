import { describe, it, expect } from "vitest";
import { Simulation } from "@lightlag/engine/sim";
import { createWorld, type Ship } from "@lightlag/engine/world";
import { coastElements } from "@lightlag/engine/ships";
import { tleToElements, tleToElementsAtEpoch, dateToWorldTime, spawnSatellite, spawnSatellites, parseTleText, isSatelliteId } from "./satellites.ts";
import { TLE_SNAPSHOT } from "./data/tleSnapshot.ts";

const ISS = TLE_SNAPSHOT[0]!;
const RAD2DEG = 180 / Math.PI;
const YEAR_S = 365.25 * 86400;

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

  // Regression: loading a live group at the sandbox's default sim time (world
  // t=0 ≈ J2000) propagates current-epoch TLEs decades before their epoch. Far
  // enough out, satellite.js returns a bare `[false, false]` ARRAY (sgp4 errors
  // 1–4) instead of the documented `{ position: false }` object — its `.position`
  // is `undefined`, which the old guard let through, dereferencing `undefined.x`
  // ("Cannot read properties of undefined (reading 'x')") and aborting the whole
  // load. Every off-epoch failure shape must now be a clean null.
  it("returns null (no throw) when SGP4 fails — both the object- and array-form sentinels", () => {
    // ~100 y before the ISS set's 2008 epoch → array-form `[false, false]` (error 1):
    // the exact shape that crashed live ingestion.
    expect(() => tleToElements(ISS, -100 * YEAR_S)).not.toThrow();
    expect(tleToElements(ISS, -100 * YEAR_S)).toBeNull();
    // ~50 y before epoch → object-form `{ position: false }` (decay, error 6).
    expect(tleToElements(ISS, -50 * YEAR_S)).toBeNull();
  });

  it("a TLE that cannot be propagated is skipped, not fatal, so the batch survives", () => {
    const sim = new Simulation(createWorld(1, -100 * YEAR_S, "earth"));
    // The whole group propagates far before epoch here: each one is skipped and
    // the loop completes with an empty result instead of throwing mid-batch.
    expect(() => spawnSatellites(sim, TLE_SNAPSHOT)).not.toThrow();
    expect(spawnSatellites(sim, TLE_SNAPSHOT)).toEqual([]);
    expect(spawnSatellite(sim, ISS)).toBeNull();
  });

  it("dateToWorldTime anchors the clock so a TLE loaded at its epoch stays in SGP4's window", () => {
    // The ISS set's own epoch: 2008, day 264.51782528 (J2000 = 2000-01-01T12:00Z).
    const epochMs = Date.UTC(2008, 0, 1) + (264.51782528 - 1) * 86400 * 1000;
    const worldT = dateToWorldTime(new Date(epochMs));
    // Matches the s-since-J2000 the other tests compute by hand — it's the inverse
    // of the internal worldTime→Date mapping the propagator uses.
    expect(worldT).toBeCloseTo((epochMs - Date.UTC(2000, 0, 1, 12)) / 1000, 3);
    // Propagated at (essentially) the epoch, the orbit matches the epoch-anchored
    // elements — the point of starting the app clock at the present date/time.
    const atNow = tleToElements(ISS, worldT)!;
    const atEpoch = tleToElementsAtEpoch(ISS)!;
    expect(atNow).not.toBeNull();
    expect(atNow.a).toBeCloseTo(atEpoch.a, 0);
    expect(atNow.e).toBeCloseTo(atEpoch.e, 6);
    expect(atNow.i).toBeCloseTo(atEpoch.i, 6);
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

  it("records the natural decay rate (rung-1 ṅ) and marks the satellite station-kept", () => {
    const epochMs = Date.UTC(2008, 0, 1) + (264.51782528 - 1) * 86400 * 1000;
    const tEpoch = (epochMs - Date.UTC(2000, 0, 1, 12)) / 1000;
    const sim = new Simulation(createWorld(1, tEpoch, "earth"));
    const ship = sim.world.ships.get(spawnSatellite(sim, ISS)!)!;

    // Real catalog sats are maintained ⇒ station-kept (no spiral-in / balloon-out).
    expect(ship.stationKept).toBe(true);
    // The natural decay rate is still recorded (the basis for future station-keeping
    // Δv). This archival ISS set has a NEGATIVE ṅ/2 (-.00002182 rev/day², a post-reboost
    // fit artifact) — carried faithfully. SI magnitude |·2·2π/86400²| ≈ 3.7e-14 rad/s².
    expect(ship.drag).toBeDefined();
    expect(ship.drag!.nDot).toBeLessThan(0);
    expect(Math.abs(ship.drag!.nDot)).toBeGreaterThan(1e-14);
    expect(Math.abs(ship.drag!.nDot)).toBeLessThan(1e-13);
  });

  it("station-kept satellite HOLDS its orbit — no secular decay even years on", () => {
    const epochMs = Date.UTC(2008, 0, 1) + (264.51782528 - 1) * 86400 * 1000;
    const tEpoch = (epochMs - Date.UTC(2000, 0, 1, 12)) / 1000;
    const sim = new Simulation(createWorld(1, tEpoch, "earth"));
    const ship = sim.world.ships.get(spawnSatellite(sim, ISS)!)!;
    const a0 = ship.elements!.a;

    // Kepler + J2 leave the semi-major axis untouched, and station-keeping suppresses
    // the drag decay — so the SMA is unchanged 5 years out (no crash, no balloon).
    const a5y = coastElements(ship, tEpoch + 5 * 365.25 * 86400).a;
    expect(a5y).toBeCloseTo(a0, 3);
  });

  it("the un-kept drag primitive still advances ½·ṅ·dt² along-track and decays the SMA", () => {
    const epochMs = Date.UTC(2008, 0, 1) + (264.51782528 - 1) * 86400 * 1000;
    const tEpoch = (epochMs - Date.UTC(2000, 0, 1, 12)) / 1000;
    const sim = new Simulation(createWorld(1, tEpoch, "earth"));
    const base = sim.world.ships.get(spawnSatellite(sim, ISS)!)!;
    // Exercise the engine drag model directly: an object that is NOT station-kept
    // (e.g. debris) — same TLE rate, station-keeping off.
    const active: Ship = { ...base, stationKept: false };
    const dragFree: Ship = { ...active, drag: undefined };

    const dt = 2 * 86400; // 2 days
    const withDrag = coastElements(active, tEpoch + dt);
    const without = coastElements(dragFree, tEpoch + dt);

    // Mean anomaly leads/lags the drag-free conic by exactly ½·ṅ·dt² (mod 2π).
    const nDot = active.drag!.nDot;
    const dMexpected = 0.5 * nDot * dt * dt;
    const dM = Math.atan2(
      Math.sin(withDrag.M - without.M),
      Math.cos(withDrag.M - without.M),
    );
    expect(dM).toBeCloseTo(dMexpected, 6);

    // SMA moves with the sign of ṅ (here ṅ<0 ⇒ n falls ⇒ a rises), and the conic
    // stays self-consistent: n²a³ = μ to the same ½·ṅ·dt² along-track.
    expect(Math.sign(without.a - withDrag.a)).toBe(Math.sign(nDot));
    expect(withDrag.a).not.toBeCloseTo(without.a, 0);
  });
});
