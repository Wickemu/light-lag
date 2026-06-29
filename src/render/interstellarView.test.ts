import { describe, it, expect } from "vitest";
import { pickNearest } from "./interstellarView.ts";

/** The screen-space marker pick behind click-to-focus a star. Pure (no THREE / DOM),
 *  so the selection logic is testable even though the projection that feeds it needs
 *  a live camera and is verified manually. */
describe("pickNearest — interstellar marker picking", () => {
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

  it("preserves a null id (Sol's recentre sentinel)", () => {
    const pts: { id: string | null; x: number; y: number }[] = [{ id: null, x: 5, y: 5 }];
    expect(pickNearest(pts, 5, 5, 18)?.id).toBeNull();
  });
});
