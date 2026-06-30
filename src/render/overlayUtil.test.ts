import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { dopplerTint, overlayPalette, pickNearest, smoothstep, easedFollowTarget } from "./overlayUtil.ts";

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

/** The pure core of the eased camera transitions (the in-system fly-to and the
 *  interstellar follow glide). The offset-preserving shift that keeps zoom invariant
 *  needs a live camera and is verified manually; this convergence math is testable. */
describe("smoothstep — eased 0..1 progress", () => {
  it("pins the endpoints and the symmetric midpoint", () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 12); // 0.5²·(3−1) = 0.5
  });

  it("clamps out-of-range progress (no overshoot before lift-off or after arrival)", () => {
    expect(smoothstep(-1)).toBe(0);
    expect(smoothstep(2)).toBe(1);
  });

  it("has zero slope at both ends (eases in and out, not a linear ramp)", () => {
    expect(smoothstep(0.01)).toBeLessThan(0.01); // below the y=x line near 0
    expect(smoothstep(0.99)).toBeGreaterThan(0.99); // above it near 1
  });

  it("is monotonically increasing across the interval", () => {
    let prev = -1;
    for (let p = 0; p <= 1.0001; p += 0.1) {
      const s = smoothstep(p);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });
});

describe("easedFollowTarget — glide look-at from start toward the live focus", () => {
  const start = new THREE.Vector3(0, 0, 0);
  const focus = new THREE.Vector3(10, -4, 6);

  it("returns the start at p=0 and the focus at p=1", () => {
    expect(easedFollowTarget(start, focus, 0).equals(start)).toBe(true);
    expect(easedFollowTarget(start, focus, 1).equals(focus)).toBe(true);
  });

  it("sits on the start→focus segment at the smoothstep fraction", () => {
    const mid = easedFollowTarget(start, focus, 0.5);
    expect(mid.x).toBeCloseTo(5, 12); // smoothstep(0.5)=0.5 ⇒ halfway
    expect(mid.y).toBeCloseTo(-2, 12);
    expect(mid.z).toBeCloseTo(3, 12);
  });

  it("advances monotonically toward the focus along each axis", () => {
    let prev = -Infinity;
    for (let p = 0; p <= 1.0001; p += 0.2) {
      const d = easedFollowTarget(start, focus, p).x; // focus.x > start.x ⇒ increasing
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it("writes into a provided out vector (no per-frame allocation)", () => {
    const out = new THREE.Vector3(99, 99, 99);
    const r = easedFollowTarget(start, focus, 1, out);
    expect(r).toBe(out);
    expect(out.equals(focus)).toBe(true);
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

  it("prefers a more prominent (lower-priority) marker over a nearer one in range", () => {
    const pts = [
      { id: "sat", x: 2, y: 0, priority: 6 }, // nearer, but a satellite
      { id: "earth", x: 12, y: 0, priority: 1 }, // farther, but a planet
    ];
    expect(pickNearest(pts, 0, 0, 18)?.id).toBe("earth");
  });

  it("falls back to nearest among equally prominent markers", () => {
    const pts = [
      { id: "a", x: 12, y: 0, priority: 3 },
      { id: "b", x: 4, y: 0, priority: 3 },
    ];
    expect(pickNearest(pts, 0, 0, 18)?.id).toBe("b");
  });

  it("only ranks prominence among in-range markers (a far prominent one loses to a near one)", () => {
    const pts = [
      { id: "earth", x: 40, y: 0, priority: 1 }, // prominent but beyond threshold
      { id: "sat", x: 3, y: 0, priority: 6 }, // less prominent but in range
    ];
    expect(pickNearest(pts, 0, 0, 18)?.id).toBe("sat");
  });
});
