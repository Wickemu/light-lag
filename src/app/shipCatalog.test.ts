/**
 * Guards on the preset fleet. These are invariants, not balance knobs: they fail
 * loudly if a future preset is physically nonsensical OR quietly relativistic
 * (which the classical engine would silently mis-model). Adding a craft whose
 * exhaust velocity or total Δv creeps toward c should break the build, not ship.
 */

import { describe, it, expect } from "vitest";
import { SHIP_PRESETS, PRESETS_BY_ID, presetToDesign } from "./shipCatalog.ts";
import { deltaVBudget, exhaustVelocity } from "../core/propulsion.ts";
import { C } from "../core/constants.ts";

/** Faithfulness ceiling: classical Tsiolkovsky is only honest well below c. Every
 *  real/inferred craft in the fleet sits comfortably under these; the relativistic
 *  ones are deliberately excluded (PENDING_RELATIVISTIC). */
const MAX_VE = 0.02 * C; // ~5994 km/s — exhaust velocity
const MAX_DV = 0.05 * C; // ~14990 km/s — whole-stack Δv

describe("ship catalog", () => {
  it("has a broad, unique fleet", () => {
    expect(SHIP_PRESETS.length).toBeGreaterThanOrEqual(30);
    const ids = new Set(SHIP_PRESETS.map((p) => p.id));
    expect(ids.size).toBe(SHIP_PRESETS.length); // ids unique
    expect(PRESETS_BY_ID.size).toBe(SHIP_PRESETS.length);
  });

  for (const p of SHIP_PRESETS) {
    describe(p.name, () => {
      it("has well-formed, positive stage data", () => {
        expect(p.design.stages.length).toBeGreaterThan(0);
        expect(p.design.payloadMass).toBeGreaterThanOrEqual(0);
        for (const s of p.design.stages) {
          expect(s.dryMass).toBeGreaterThanOrEqual(0);
          expect(s.propMass).toBeGreaterThan(0);
          expect(s.isp).toBeGreaterThan(0);
          expect(s.thrust).toBeGreaterThan(0);
        }
      });

      it("is sub-relativistic (classical engine stays honest)", () => {
        for (const s of p.design.stages) {
          expect(exhaustVelocity(s.isp)).toBeLessThan(MAX_VE);
        }
        const b = deltaVBudget(p.design.stages, p.design.payloadMass);
        expect(b.total).toBeGreaterThan(0);
        expect(Number.isFinite(b.total)).toBe(true);
        expect(b.total).toBeLessThan(MAX_DV);
        expect(b.finalMass).toBeGreaterThan(0); // no stage burns into negative mass
      });

      it("deep-copies cleanly (no aliasing the catalog)", () => {
        const d = presetToDesign(p);
        d.stages[0]!.propMass = -999;
        expect(p.design.stages[0]!.propMass).toBeGreaterThan(0);
      });
    });
  }
});

/** Dev aid: a readable performance table for eyeballing the whole fleet at once
 *  (run `npm test -- shipCatalog` and read the console). Asserts nothing. */
describe("ship catalog — performance table", () => {
  it("prints Δv / mass / T·W⁻¹ / max-Isp per preset", () => {
    const G0 = 9.80665;
    const rows = SHIP_PRESETS.map((p) => {
      const b = deltaVBudget(p.design.stages, p.design.payloadMass);
      const s0 = p.design.stages[0]!;
      const twr = s0.thrust / (b.wetMass * G0);
      const maxIsp = Math.max(...p.design.stages.map((s) => s.isp));
      return {
        name: p.name,
        cat: p.category,
        dv_kms: (b.total / 1000).toFixed(2),
        wet_t: (b.wetMass / 1000).toFixed(1),
        twr: twr.toFixed(twr < 0.01 ? 5 : 2),
        maxIsp,
      };
    });
    // eslint-disable-next-line no-console
    console.table(rows);
    expect(rows.length).toBe(SHIP_PRESETS.length);
  });
});
