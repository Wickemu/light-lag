import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import {
  spawnShip, spawnOnPad, expressToOrbit, launchShip, planTransfer, defaultDesign, type ShipDesign,
} from "./commands.ts";
import { SHIP_PRESETS, presetToDesign } from "./shipCatalog.ts";
import { marsWindow } from "../integration/test-helpers.ts";
import { dvRemaining, totalMass } from "@lightlag/engine/ships";
import { deltaVBudget } from "@lightlag/engine/propulsion";
import { BODY_BY_ID, DEG } from "@lightlag/engine/constants";

const EARTH = BODY_BY_ID.get("earth")!;
const launchers = SHIP_PRESETS.filter((p) => p.role === "launcher");
const inSpace = SHIP_PRESETS.filter((p) => p.role === "in-space");

/** Full propellant aboard a ship across the still-active stages. */
function liveProp(ship: { stages: { propMass: number }[]; activeStage: number }): number {
  return ship.stages.slice(ship.activeStage).reduce((s, st) => s + st.propMass, 0);
}

describe("express-to-LEO ascent", () => {
  it("a Saturn V expended its boost stages — only the survivor reaches LEO", () => {
    const sim = new Simulation(createWorld(1, 0));
    const design = presetToDesign(SHIP_PRESETS.find((p) => p.id === "saturn-v")!);
    const fullStackMass = totalMass(sim.world.ships.get(spawnShip(sim, { ...design, fromSurface: false }))!);

    const { id, op } = expressToOrbit(sim, design);
    expect(id).not.toBeNull();
    expect(op.feasible).toBe(true);
    const ship = sim.world.ships.get(id!)!;

    // The S-IC (and most of S-II) are spent: the active stage has advanced, and the
    // survivor is a small fraction of the full ground stack.
    expect(ship.activeStage).toBeGreaterThanOrEqual(1);
    expect(totalMass(ship)).toBeLessThan(fullStackMass * 0.25);
    // It reached a circular LEO at the design altitude/inclination (no leg pending).
    expect(ship.elements).toBeDefined();
    expect(ship.landed).toBeUndefined();
    expect(ship.launchLeg).toBeUndefined();
    expect((ship.elements!.a - EARTH.radius) / 1000).toBeCloseTo(185, -1);
    expect(ship.elements!.i).toBeCloseTo(32.5 * DEG, 2);
    // The S-IVB remnant keeps a real trans-lunar-injection-class Δv budget.
    expect(dvRemaining(ship) / 1000).toBeGreaterThan(0.5);
    expect(dvRemaining(ship) / 1000).toBeLessThan(6);
  });

  it("every launch-vehicle preset can reach LEO, leaving a sane survivor", () => {
    const rows: string[] = [];
    const failed: string[] = [];
    for (const p of launchers) {
      const sim = new Simulation(createWorld(1, 0));
      const design = presetToDesign(p);
      const fullDv = deltaVBudget(design.stages, design.payloadMass).total;
      const { id, op } = expressToOrbit(sim, design);
      if (!id) {
        failed.push(`${p.name.padEnd(22)} full Δv ${(fullDv / 1000).toFixed(2)} km/s · ascent ${(op.dv / 1000).toFixed(2)} — INFEASIBLE`);
        continue;
      }
      const ship = sim.world.ships.get(id)!;
      rows.push(
        `${p.name.padEnd(22)} full Δv ${(fullDv / 1000).toFixed(2)} km/s · ascent ${(op.dv / 1000).toFixed(2)}` +
        ` → LEO survivor ${(totalMass(ship) / 1000).toFixed(1)} t, ${(dvRemaining(ship) / 1000).toFixed(2)} km/s left`,
      );
      expect(dvRemaining(ship)).toBeGreaterThanOrEqual(0);
      expect(dvRemaining(ship)).toBeLessThan(fullDv);
    }
    // eslint-disable-next-line no-console
    console.log("Launch-vehicle LEO survivors:\n" + rows.join("\n") + (failed.length ? "\nINFEASIBLE:\n" + failed.join("\n") : ""));
    expect(failed, `these launchers cannot reach LEO: ${failed.join("; ")}`).toHaveLength(0);
  });

  it("flying the ascent from the pad yields the same survivor as the express path", () => {
    const design = presetToDesign(SHIP_PRESETS.find((p) => p.id === "falcon-9")!);

    // Express path.
    const simX = new Simulation(createWorld(1, 0));
    const x = simX.world.ships.get(expressToOrbit(simX, design).id!)!;

    // Flown path: stand on the pad, launch (animated or snapped), step past the leg.
    const simF = new Simulation(createWorld(1, 0));
    const fid = spawnOnPad(simF, design);
    const op = launchShip(simF, fid, design.altitudeKm)!;
    expect(op.feasible).toBe(true);
    simF.step(10_000); // settle past any ascent leg
    const f = simF.world.ships.get(fid)!;
    expect(f.landed).toBeUndefined();
    expect(f.launchLeg).toBeUndefined();

    // The Δv charged is identical (same ascent budget), so mass and Δv match exactly.
    expect(totalMass(f)).toBeCloseTo(totalMass(x), 3);
    expect(dvRemaining(f)).toBeCloseTo(dvRemaining(x), 3);
  });
});

describe("spawn placement by role", () => {
  it("spawnOnPad stands a launcher on Earth at its target-inclination latitude", () => {
    const sim = new Simulation(createWorld(1, 0));
    const design = presetToDesign(SHIP_PRESETS.find((p) => p.id === "saturn-v")!); // incl 32.5°
    const ship = sim.world.ships.get(spawnOnPad(sim, design))!;
    expect(ship.landed?.bodyId).toBe("earth");
    expect(ship.landed!.surfaceDir.z).toBeCloseTo(Math.sin(32.5 * DEG), 6);
    expect(liveProp(ship)).toBeCloseTo(deltaVBudget(design.stages, design.payloadMass).wetMass - design.payloadMass - design.stages.reduce((s, st) => s + st.dryMass, 0), -2);
    expect(ship.elements).toBeUndefined(); // on the pad, not on an orbit
  });

  it("seats the pad at a real launch-site longitude — a 28.5° design rolls out at Cape Canaveral, not mid-Sahara", () => {
    const sim = new Simulation(createWorld(1, 0));
    const design: ShipDesign = { ...defaultDesign(), inclinationDeg: 28.5, fromSurface: true };
    const ship = sim.world.ships.get(spawnOnPad(sim, design))!;
    const d = ship.landed!.surfaceDir;
    // Body-fixed direction → geographic lat/lon (east-positive), the same convention the
    // procedural Earth texture uses (render/bodyTextures lonLatToPx, render/earthLand).
    const latDeg = Math.asin(d.z) / DEG;
    const lonDeg = Math.atan2(d.y, d.x) / DEG;
    expect(latDeg).toBeCloseTo(28.5, 4); // latitude still = inclination (orbit unchanged)
    expect(lonDeg).toBeCloseTo(-80.6, 1); // Cape Canaveral longitude, NOT 0° (the Sahara)
    expect(Math.abs(lonDeg)).toBeGreaterThan(10); // guards against regressing to the prime meridian
  });

  it("in-space craft still deploy directly in LEO with full propellant", () => {
    const sim = new Simulation(createWorld(1, 0));
    for (const p of inSpace) {
      const design = presetToDesign(p);
      const ship = sim.world.ships.get(spawnShip(sim, design))!;
      expect(ship.landed).toBeUndefined();
      expect(ship.elements).toBeDefined();
      // Full tanks: every active stage sits at its capacity.
      for (const st of ship.stages) expect(st.propMass).toBeCloseTo(st.propCapacity ?? st.propMass, 6);
    }
  });

  it("the default design is in-space (unchanged: full propellant in LEO)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const d = defaultDesign();
    expect(d.fromSurface).toBeFalsy();
    const ship = sim.world.ships.get(spawnShip(sim, d))!;
    expect(ship.elements).toBeDefined();
    expect(ship.landed).toBeUndefined();
  });

  it("a drag-stalled (non-converged) ascent is infeasible — the ship is NOT teleported into orbit", () => {
    const sim = new Simulation(createWorld(1, 0));
    // A high-mass-ratio stack that can AFFORD a huge Δv but drag-stalls in Venus's thick
    // lower atmosphere (never reaches orbital velocity within the integrator cap).
    const id = spawnShip(sim, {
      name: "Venus climber", payloadMass: 1000, altitudeKm: 300, inclinationDeg: 0,
      stages: [{ name: "S1", dryMass: 1000, propMass: 50_000, isp: 700, thrust: 5e6 }],
    });
    const ship = sim.world.ships.get(id)!;
    ship.primary = "venus";
    ship.elements = undefined;
    ship.landed = { bodyId: "venus", surfaceDir: { x: 1, y: 0, z: 0 } };
    ship.epoch = sim.world.t;

    const op = launchShip(sim, id, 300)!;
    expect(op.feasible).toBe(false); // non-converged ⇒ rejected
    expect(ship.landed).toBeDefined(); // still on the surface
    expect(ship.elements).toBeUndefined(); // NOT placed in orbit
    expect(dvRemaining(ship)).toBeGreaterThan(0); // and nothing was charged
  });

  it("a landed launch vehicle cannot plan a heliocentric transfer 'from the surface'", () => {
    const sim = new Simulation(createWorld(1, 0));
    const win = marsWindow();
    const design = presetToDesign(SHIP_PRESETS.find((p) => p.id === "saturn-v")!);

    // On the pad: planTransfer must refuse (no parking orbit to inject from).
    const padId = spawnOnPad(sim, design);
    expect(planTransfer(sim, padId, "mars", win.depT, win.arrT)).toBeNull();
    expect(sim.world.ships.get(padId)!.transfer).toBeUndefined();

    // Once in LEO (express), the same transfer plans fine.
    const { id } = expressToOrbit(sim, design);
    expect(planTransfer(sim, id!, "mars", win.depT, win.arrT)).not.toBeNull();
  });

  it("a design too weak to reach LEO is reported infeasible and spawns nothing", () => {
    const sim = new Simulation(createWorld(1, 0));
    // ~3 km/s stack — far below the ~9.4 km/s Earth ascent budget.
    const weak: ShipDesign = {
      name: "Weakling", payloadMass: 1000, altitudeKm: 300, inclinationDeg: 0,
      stages: [{ name: "S1", dryMass: 2000, propMass: 3000, isp: 300, thrust: 4e5 }],
      fromSurface: true,
    };
    const { id, op } = expressToOrbit(sim, weak);
    expect(id).toBeNull();
    expect(op.feasible).toBe(false);
    expect(sim.world.ships.size).toBe(0); // nothing left behind
  });
});
