/**
 * Gas/ice-giant cloud-map regression. The painter is pure (no THREE, no DOM), so
 * we can render the actual RGBA buffers in node and assert the structural
 * properties the look depends on:
 *   - the map tiles in longitude (no meridian seam) — the texture wraps, so a seam
 *     would show as a scar down the planet;
 *   - it is deterministic (seeded per id) — the same world every reload;
 *   - the giants are banded and Uranus is bland, the way the real planets read;
 *   - the rings carry the C/B/Cassini/A structure (a near-empty Cassini Division
 *     between a bright dense B ring and the A ring).
 */

import { describe, it, expect } from "vitest";
import { paintGiant, paintGiantRing, isGiantId } from "./gasGiant.ts";

const GIANTS = ["jupiter", "saturn", "uranus", "neptune"] as const;

/** Mean per-channel luminance of an equirectangular row. */
function rowLuma(buf: Uint8ClampedArray, w: number, y: number): number {
  let s = 0;
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    s += 0.3 * buf[i]! + 0.59 * buf[i + 1]! + 0.11 * buf[i + 2]!;
  }
  return s / w;
}

/** Total variation Σ|x[i+1]−x[i]| — large when a signal alternates (banding),
 *  small for a smooth monotonic ramp (a featureless pole-ward gradient). */
function totalVariation(xs: number[]): number {
  let s = 0;
  for (let i = 1; i < xs.length; i++) s += Math.abs(xs[i]! - xs[i - 1]!);
  return s;
}

describe("gas-giant cloud maps", () => {
  it("classifies the four giants and nothing else", () => {
    for (const id of GIANTS) expect(isGiantId(id)).toBe(true);
    for (const id of ["earth", "mars", "io", "sun", "pluto"]) expect(isGiantId(id)).toBe(false);
    expect(() => paintGiant("earth", 16, 8)).toThrow();
  });

  it("returns a fully-opaque RGBA buffer of the requested size", () => {
    const w = 64, h = 32;
    for (const id of GIANTS) {
      const buf = paintGiant(id, w, h);
      expect(buf.length).toBe(w * h * 4);
      for (let i = 3; i < buf.length; i += 4) expect(buf[i]).toBe(255);
    }
  });

  it("is deterministic — identical id+size paints byte-for-byte the same", () => {
    for (const id of GIANTS) {
      const a = paintGiant(id, 128, 64);
      const b = paintGiant(id, 128, 64);
      expect(a).toEqual(b);
    }
  });

  it("tiles in longitude — the first and last columns match (no meridian seam)", () => {
    const w = 256, h = 128;
    for (const id of GIANTS) {
      const buf = paintGiant(id, w, h);
      let diff = 0;
      for (let y = 0; y < h; y++) {
        const a = (y * w + 0) * 4;
        const b = (y * w + (w - 1)) * 4;
        diff += Math.abs(buf[a]! - buf[b]!) + Math.abs(buf[a + 1]! - buf[b + 1]!) + Math.abs(buf[a + 2]! - buf[b + 2]!);
      }
      const perPixel = diff / (h * 3);
      // Adjacent columns across the wrap differ only by tileable noise — a real
      // seam (a hard colour step) would be many tens of levels.
      expect(perPixel, `${id} seam`).toBeLessThan(8);
    }
  });

  it("paints banded giants but a bland Uranus", () => {
    const w = 128, h = 256; // tall: plenty of latitude rows to measure banding
    const banding = (id: string) => {
      const buf = paintGiant(id, w, h);
      const lumas: number[] = [];
      // Skip the polar caps (top/bottom 15%) so we measure the belt/zone region.
      // Per-row luminance averages the longitudinal noise away, leaving the bands.
      for (let y = Math.floor(h * 0.15); y < h * 0.85; y++) lumas.push(rowLuma(buf, w, y));
      return totalVariation(lumas);
    };
    const jup = banding("jupiter");
    const sat = banding("saturn");
    const ura = banding("uranus");
    // Jupiter is the most strongly banded; Saturn clearly banded; Uranus is a near
    // featureless ramp, whose total variation is a small fraction of the giants'.
    expect(jup, "Jupiter most banded").toBeGreaterThan(sat);
    expect(sat, "Saturn more banded than Uranus").toBeGreaterThan(ura * 2);
    expect(jup, "Jupiter far more banded than bland Uranus").toBeGreaterThan(ura * 4);
  });
});

describe("Saturn ring profile", () => {
  const w = 1024, h = 4;
  const ring = paintGiantRing(w, h);
  /** Mean alpha (optical density) over a ±span window centred on radius fraction r. */
  const alphaAt = (r: number, span = 12): number => {
    const c = Math.round(r * w);
    let s = 0, n = 0;
    for (let x = Math.max(0, c - span); x <= Math.min(w - 1, c + span); x++) { s += ring[x * 4 + 3]!; n++; }
    return s / n;
  };

  it("makes the B ring the densest, the Cassini Division a near-gap", () => {
    const cRing = alphaAt(0.12);
    const bRing = alphaAt(0.45);
    const cassini = alphaAt(0.725);
    const aRing = alphaAt(0.86);
    expect(bRing, "B ring densest").toBeGreaterThan(cRing);
    expect(bRing, "B ring > A ring").toBeGreaterThan(aRing);
    expect(cassini, "Cassini is a near-gap").toBeLessThan(bRing * 0.4);
    expect(cassini, "Cassini emptier than the A ring").toBeLessThan(aRing);
  });

  it("feathers both rims to transparent", () => {
    expect(ring[0 * 4 + 3]!, "inner rim fades").toBeLessThan(40);
    expect(ring[(w - 1) * 4 + 3]!, "outer rim fades").toBeLessThan(40);
  });
});
