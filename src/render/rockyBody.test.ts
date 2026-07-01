/**
 * Rocky-body terrain + crater regression. The painter is pure (no THREE, no DOM),
 * so we render the actual RGBA buffers in node and assert the structural properties
 * the look depends on:
 *   - it is deterministic (seeded per id) — the same world every reload;
 *   - the surface is opaque and correctly sized, and a bump buffer rides alongside;
 *   - the map tiles in longitude (no meridian seam) even with the crater field, whose
 *     craters wrap via great-circle distance rather than smearing at u=0/1;
 *   - heavily-cratered worlds (Mercury) carry far more relief than a regolith-buried
 *     one (Deimos), and trimming the crater scale flattens a world out;
 *   - Mars's dusky mare field gives it a distinct dark-region population.
 *
 * Named surface features (maria, Caloris, Valles Marineris, Stickney) are stamped by
 * the DOM wrapper (bodyTextures) via canvas, so they are deliberately NOT exercised
 * here — this module paints only the terrain base + impact population.
 */

import { describe, it, expect } from "vitest";
import { paintRockySurface, hasRockyProfile, type RockyParams } from "./rockyBody.ts";
import { BODY_BY_ID, type BodyKind } from "@lightlag/engine/constants";

function params(id: string, over: Partial<RockyParams> = {}): RockyParams {
  const def = BODY_BY_ID.get(id);
  return {
    id,
    color: def?.color ?? 0x888888,
    kind: (def?.kind ?? "moon") as BodyKind,
    w: 128, h: 64,
    ...over,
  };
}

/** Mean per-channel luminance of an equirectangular column. */
function colLuma(buf: Uint8ClampedArray, w: number, h: number, x: number): number {
  let s = 0;
  for (let y = 0; y < h; y++) {
    const i = (y * w + x) * 4;
    s += 0.3 * buf[i]! + 0.59 * buf[i + 1]! + 0.11 * buf[i + 2]!;
  }
  return s / h;
}

/** Variance of the bump channel — a proxy for how much relief a body carries. */
function bumpVariance(bump: Uint8ClampedArray): number {
  let sum = 0, sum2 = 0, n = 0;
  for (let i = 0; i < bump.length; i += 4) { const v = bump[i]!; sum += v; sum2 += v * v; n++; }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

describe("rocky-body surfaces", () => {
  it("classifies the tuned inner-world profiles and nothing else", () => {
    for (const id of ["mercury", "moon", "mars", "phobos", "deimos"]) expect(hasRockyProfile(id)).toBe(true);
    for (const id of ["ceres", "earth", "jupiter", "eros", "callisto"]) expect(hasRockyProfile(id)).toBe(false);
  });

  it("is deterministic — identical params paint byte-for-byte the same", () => {
    for (const id of ["mercury", "moon", "mars", "ceres", "phobos"]) {
      const a = paintRockySurface(params(id));
      const b = paintRockySurface(params(id));
      expect(a.surface).toEqual(b.surface);
      expect(a.bump).toEqual(b.bump);
    }
  });

  it("returns an opaque, correctly-sized surface and a bump buffer", () => {
    const w = 96, h = 48;
    for (const id of ["mercury", "mars", "ceres", "deimos"]) {
      const { surface, bump } = paintRockySurface(params(id, { w, h }));
      expect(surface.length).toBe(w * h * 4);
      expect(bump.length).toBe(w * h * 4);
      for (let i = 3; i < surface.length; i += 4) expect(surface[i]).toBe(255);
    }
  });

  it("tiles in longitude — the first and last columns stay close (no meridian seam)", () => {
    const w = 256, h = 128;
    for (const id of ["mercury", "moon", "mars", "ceres"]) {
      const { surface } = paintRockySurface(params(id, { w, h }));
      let diff = 0;
      for (let y = 0; y < h; y++) {
        const a = (y * w + 0) * 4;
        const b = (y * w + (w - 1)) * 4;
        diff += Math.abs(surface[a]! - surface[b]!) + Math.abs(surface[a + 1]! - surface[b + 1]!) + Math.abs(surface[a + 2]! - surface[b + 2]!);
      }
      const perPixel = diff / (h * 3);
      // Adjacent wrap columns differ only by tileable noise + wrapped crater edges
      // (a dense crater field lifts this to ~10 on Mercury/Moon) — a real seam, a
      // hard step down the meridian, would be many tens of levels.
      expect(perPixel, `${id} seam`).toBeLessThan(18);
    }
  });

  it("gives a heavily-cratered world far more relief than a regolith-buried one", () => {
    const mercury = paintRockySurface(params("mercury"));
    const deimos = paintRockySurface(params("deimos"));
    // Deimos's sparse, soft, buried craters leave a much flatter bump field.
    expect(bumpVariance(mercury.bump)).toBeGreaterThan(bumpVariance(deimos.bump) * 2.5);
  });

  it("flattens a world when the crater scale is trimmed (young/hidden surfaces)", () => {
    const full = paintRockySurface(params("mercury", { craterScale: 1 }));
    const trimmed = paintRockySurface(params("mercury", { craterScale: 0.05 }));
    expect(bumpVariance(full.bump)).toBeGreaterThan(bumpVariance(trimmed.bump));
  });

  it("varies column luminance (a real cratered population, not a flat wash)", () => {
    const w = 256, h = 128;
    const { surface } = paintRockySurface(params("moon", { w, h }));
    const lumas: number[] = [];
    for (let x = 0; x < w; x += 4) lumas.push(colLuma(surface, w, h, x));
    const mean = lumas.reduce((a, b) => a + b, 0) / lumas.length;
    const varc = lumas.reduce((a, b) => a + (b - mean) ** 2, 0) / lumas.length;
    expect(varc).toBeGreaterThan(1); // craters + terrain break the wash up
  });

  it("paints Mars with a distinct dark mare population (broad basaltic bands)", () => {
    // The mare field lays down broad low-frequency dark swaths, which show up as
    // strong column-to-column luminance variation — far more than a craters-only body
    // (Ceres) of the same size, whose small craters average away per column.
    const w = 256, h = 128;
    const colVar = (buf: Uint8ClampedArray): number => {
      const l: number[] = [];
      for (let x = 0; x < w; x++) l.push(colLuma(buf, w, h, x));
      const m = l.reduce((a, b) => a + b, 0) / l.length;
      return l.reduce((a, b) => a + (b - m) ** 2, 0) / l.length;
    };
    const mars = colVar(paintRockySurface(params("mars", { w, h })).surface);
    const ceres = colVar(paintRockySurface(params("ceres", { w, h })).surface);
    expect(mars).toBeGreaterThan(ceres * 1.5);
  });
});
