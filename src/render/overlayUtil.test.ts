import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { dopplerTint, overlayPalette, pickNearest } from "./overlayUtil.ts";

const PAL = overlayPalette("dark");
const BASE = 0x6fe0ff; // the coasting-ship cyan

const redness = (hex: number) => new THREE.Color().setHex(hex).r;
const blueness = (hex: number) => new THREE.Color().setHex(hex).b;

describe("dopplerTint", () => {
  it("returns the base colour at zero and within the dead-zone", () => {
    expect(dopplerTint(BASE, 0, PAL)).toBe(BASE);
    expect(dopplerTint(BASE, 1e-6, PAL)).toBe(BASE); // planetary speeds ⇒ invisible
    expect(dopplerTint(BASE, -1e-6, PAL)).toBe(BASE);
  });

  it("saturates to the redshift endpoint receding and blueshift approaching at β≈0.95", () => {
    expect(dopplerTint(BASE, 5, PAL)).toBe(PAL.redshift); // z≈5.25 ⇒ full red
    expect(dopplerTint(BASE, -5, PAL)).toBe(PAL.blueshift);
  });

  it("partially tints between the dead-zone and saturation", () => {
    const mid = dopplerTint(BASE, 0.5, PAL);
    expect(mid).not.toBe(BASE);
    expect(mid).not.toBe(PAL.redshift);
  });

  it("is monotonic in |z| (more shift ⇒ closer to the endpoint)", () => {
    expect(redness(dopplerTint(BASE, 2, PAL))).toBeGreaterThan(redness(dopplerTint(BASE, 0.3, PAL)));
    expect(blueness(dopplerTint(BASE, -2, PAL))).toBeGreaterThanOrEqual(blueness(dopplerTint(BASE, -0.3, PAL)));
  });

  it("ignores non-finite z (returns base)", () => {
    expect(dopplerTint(BASE, NaN, PAL)).toBe(BASE);
    expect(dopplerTint(BASE, Infinity, PAL)).toBe(BASE);
  });
});

/** The screen-space marker pick behind click-to-focus (a star in the interstellar
 *  view, any body in the system view). Pure (no THREE / DOM), so the selection
 *  logic is testable even though the projection that feeds it needs a live camera
 *  and is verified manually. */
describe("pickNearest — screen-space marker picking", () => {
  it("returns the nearest entry within the threshold", () => {
    const pts = [
      { id: "near", x: 10, y: 10 },
      { id: "far", x: 200, y: 200 },
    ];
    expect(pickNearest(pts, 12, 10, 18)?.id).toBe("near");
  });

  it("returns undefined when every marker is beyond the threshold", () => {
    const pts = [{ id: "a", x: 100, y: 100 }];
    expect(pickNearest(pts, 0, 0, 18)).toBeUndefined();
  });

  it("includes a marker exactly at the threshold distance (inclusive)", () => {
    const pts = [{ id: "edge", x: 18, y: 0 }];
    expect(pickNearest(pts, 0, 0, 18)?.id).toBe("edge");
  });

  it("breaks an exact distance tie by array order (deterministic)", () => {
    const pts = [
      { id: "first", x: 0, y: 0 },
      { id: "second", x: 20, y: 0 },
    ];
    expect(pickNearest(pts, 10, 0, 18)?.id).toBe("first");
  });

  it("returns undefined for an empty list", () => {
    expect(pickNearest([] as { x: number; y: number }[], 0, 0, 18)).toBeUndefined();
  });

  it("preserves a null id (the recentre sentinel)", () => {
    const pts: { id: string | null; x: number; y: number }[] = [{ id: null, x: 5, y: 5 }];
    expect(pickNearest(pts, 5, 5, 18)?.id).toBeNull();
  });
});
