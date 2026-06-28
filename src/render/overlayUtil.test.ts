import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { dopplerTint, overlayPalette } from "./overlayUtil.ts";

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
