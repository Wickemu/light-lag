import { describe, it, expect } from "vitest";
import { j2Approach, approachSampleAt, type J2ApproachParams } from "./approach.ts";
import { buildApproachLeg, approachLegState, spinAxis } from "../ships.ts";
import { serializeWorld, deserializeWorld, hashWorld } from "../serialize.ts";
import { createWorld, type Ship } from "../world.ts";
import { BODY_BY_ID, MU_SUN, AU, j2RefRadius } from "../constants.ts";
import { soiRadius } from "../orbit.ts";
import { length, sub, type Vec3 } from "../math/vec3.ts";

const DEG = Math.PI / 180;
const SMA_AU: Record<string, number> = { mars: 1.524, jupiter: 5.203, saturn: 9.537 };

/** Inbound hyperbola SOI-entry state with two-body periapsis rp0, excess speed vinf,
 *  and orbit-normal inclination `incl` to the equatorial pole (ẑ). */
function entryState(mu: number, rp0: number, vinf: number, r0: number, incl: number): { r0: Vec3; v0: Vec3 } {
  const a = -mu / (vinf * vinf), e = 1 - rp0 / a, p = a * (1 - e * e);
  const nu = -Math.acos(Math.max(-1, Math.min(1, (p / r0 - 1) / e)));
  const r = p / (1 + e * Math.cos(nu)), h = Math.sqrt(mu * p);
  const rp = { x: r * Math.cos(nu), y: r * Math.sin(nu), z: 0 };
  const vp = { x: -mu / h * Math.sin(nu), y: (mu / h) * (e + Math.cos(nu)), z: 0 };
  const c = Math.cos(incl), s = Math.sin(incl);
  const Rx = (vv: Vec3): Vec3 => ({ x: vv.x, y: c * vv.y - s * vv.z, z: s * vv.y + c * vv.z });
  return { r0: Rx(rp), v0: Rx(vp) };
}

function params(id: string, vinf: number, rpAltKm: number, inclDeg: number, J2override?: number): { p: J2ApproachParams; rp0: number } {
  const b = BODY_BY_ID.get(id)!;
  const rp0 = b.radius + rpAltKm * 1000;
  const r0 = soiRadius(SMA_AU[id]! * AU, b.mu, MU_SUN);
  const { r0: R0, v0: V0 } = entryState(b.mu, rp0, vinf, r0, inclDeg * DEG);
  return { p: { mu: b.mu, J2: J2override ?? b.J2!, Req: j2RefRadius(b), pole: { x: 0, y: 0, z: 1 }, r0: R0, v0: V0 }, rp0 };
}

describe("J2-perturbed approach integrator", () => {
  it("recovers the two-body periapsis when J2 = 0 (the oracle)", () => {
    for (const id of ["mars", "jupiter", "saturn"]) {
      for (const inc of [0, 45, 60]) {
        const { p, rp0 } = params(id, 5000, 800, inc, 0);
        const res = j2Approach(p);
        expect(Math.abs(res.periR - rp0)).toBeLessThan(1000); // < 1 km integration error
      }
    }
  });

  it("shifts the periapsis by hundreds of km at an oblate giant, sign set by inclination", () => {
    // Equatorial pass (i=0): periapsis DROPS at a giant; high inclination (i=60°): it RISES;
    // near the ~55° critical inclination it nearly vanishes (sign change).
    const eq = j2Approach(params("saturn", 5500, 400, 0).p);
    const hi = j2Approach(params("saturn", 5500, 400, 60).p);
    const crit = j2Approach(params("saturn", 5500, 400, 45).p);
    const rp0 = params("saturn", 5500, 400, 0).rp0;
    expect(eq.periR - rp0).toBeLessThan(-200_000); // drops > 200 km
    expect(eq.periR - rp0).toBeGreaterThan(-800_000); // but bounded (~ -486 km)
    expect(hi.periR - rp0).toBeGreaterThan(100_000); // rises > 100 km
    expect(Math.abs(crit.periR - rp0)).toBeLessThan(60_000); // near-zero at the critical inclination
  });

  it("is deterministic — identical params give a byte-identical result", () => {
    const { p } = params("jupiter", 5600, 2000, 30);
    const a = j2Approach(p), b = j2Approach(p);
    expect(a.periR).toBe(b.periR);
    expect(a.tPeri).toBe(b.tPeri);
    expect(a.samples.length).toBe(b.samples.length);
  });

  it("samples a usable arc that interpolates continuously to the pinned periapsis", () => {
    const { p } = params("saturn", 5500, 400, 30);
    const res = j2Approach(p);
    expect(res.samples.length).toBeGreaterThan(20);
    // First sample is the SOI-entry state; last is the periapsis.
    expect(length(sub(res.samples[0]!.r, p.r0))).toBeLessThan(1);
    expect(res.samples[res.samples.length - 1]!.r).toEqual(res.peri.r);
    // A mid-arc query lies between the bracketing radii (monotone inbound until periapsis).
    const mid = approachSampleAt(res.samples, res.tPeri / 2);
    expect(length(mid.r)).toBeLessThan(length(p.r0));
    expect(length(mid.r)).toBeGreaterThan(res.periR);
    // Past the end clamps to the periapsis.
    expect(approachSampleAt(res.samples, res.tPeri * 2).r).toEqual(res.peri.r);
  });
});

describe("ApproachLeg (build + read + serialize)", () => {
  it("builds for an oblate body and pins the periapsis; null for a spherical body", () => {
    const saturn = BODY_BY_ID.get("saturn")!;
    const r0 = soiRadius(SMA_AU.saturn! * AU, saturn.mu, MU_SUN);
    const { r0: R0, v0: V0 } = entryState(saturn.mu, saturn.radius + 4e5, 5500, r0, 20 * DEG);
    const leg = buildApproachLeg(saturn, R0, V0, 1000)!;
    expect(leg).toBeTruthy();
    expect(leg.bodyId).toBe("saturn");
    // At SOI entry the leg reads the entry state; at tEnd, the pinned periapsis.
    const atStart = approachLegState(leg, leg.tStart);
    expect(length(sub(atStart.r, R0))).toBeLessThan(1);
    const atEnd = approachLegState(leg, leg.tEnd + 10);
    expect(atEnd.r).toEqual(leg.exitR);
    // The flown periapsis matches the integrator (consistency the aim will rely on).
    const ref = j2Approach({ mu: saturn.mu, J2: saturn.J2!, Req: j2RefRadius(saturn), pole: spinAxis(saturn), r0: R0, v0: V0 });
    expect(length(leg.exitR)).toBeCloseTo(ref.periR, 0);

    // Ceres has no J2 ⇒ no approach leg (spherical bodies stay a pure-Kepler coast).
    const ceres = BODY_BY_ID.get("ceres")!;
    expect(ceres.J2).toBeUndefined();
    expect(buildApproachLeg(ceres, R0, V0, 1000)).toBeNull();
  });

  it("round-trips through serialize with a stable hash", () => {
    const saturn = BODY_BY_ID.get("saturn")!;
    const r0 = soiRadius(SMA_AU.saturn! * AU, saturn.mu, MU_SUN);
    const { r0: R0, v0: V0 } = entryState(saturn.mu, saturn.radius + 4e5, 5500, r0, 20 * DEG);
    const leg = buildApproachLeg(saturn, R0, V0, 1000)!;
    const ship: Ship = {
      id: "probe", name: "Probe", primary: "saturn", mode: "coast",
      payloadMass: 1000, stages: [], activeStage: 0, tau: 0, approachLeg: leg,
    };
    const w = createWorld(1, 0);
    w.ships.set("probe", ship);
    const restored = deserializeWorld(serializeWorld(w));
    const rl = restored.ships.get("probe")!.approachLeg!;
    expect(rl.samples.length).toBe(leg.samples.length);
    expect(rl.bodyId).toBe("saturn");
    expect(hashWorld(restored)).toBe(hashWorld(w));
  });
});
