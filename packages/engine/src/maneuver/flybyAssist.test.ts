import { describe, it, expect } from "vitest";
import {
  flybyEccentricity, flybyTurnAngle, maxTurnAngle, flybyOutgoing, poweredFlybyVInfOut,
  impactParameter, bPlaneAim,
} from "./flyby.ts";
import { assistTransfer, chainAssist, searchAssist, minFlybyRadius, flybyManeuver } from "./assist.ts";
import { entryInterfaceAlt } from "./entry.ts";
import { BODY_BY_ID, JULIAN_YEAR } from "../constants.ts";
import { type Vec3, length, sub, dot } from "../math/vec3.ts";

const JUP = BODY_BY_ID.get("jupiter")!;

describe("flyby physics", () => {
  it("a deeper or slower pass bends more", () => {
    const deep = flybyTurnAngle(6000, JUP.mu, 2 * JUP.radius);
    const shallow = flybyTurnAngle(6000, JUP.mu, 20 * JUP.radius);
    expect(deep).toBeGreaterThan(shallow);
    const slow = flybyTurnAngle(4000, JUP.mu, 2 * JUP.radius);
    const fast = flybyTurnAngle(12000, JUP.mu, 2 * JUP.radius);
    expect(slow).toBeGreaterThan(fast);
    expect(flybyEccentricity(6000, JUP.mu, 2 * JUP.radius)).toBeGreaterThan(1); // hyperbolic
  });

  it("an unpowered flyby preserves |v∞| but rotates it, buying a free heliocentric Δv", () => {
    const vBody = { x: 0, y: 13000, z: 0 }; // ~Jupiter's orbital speed
    const vHelioIn = { x: 6000, y: 13000, z: 0 }; // v∞ = 6 km/s relative to Jupiter
    const out = flybyOutgoing(vBody, vHelioIn, JUP.mu, 2 * JUP.radius, { x: 0, y: 0, z: 1 });
    // |v∞| is preserved across an unpowered pass.
    expect(length(sub(out.vHelioOut, vBody))).toBeCloseTo(length(sub(vHelioIn, vBody)), 3);
    // A deep, slow Jupiter pass bends ~150° and imparts a multi-km/s free assist.
    expect((out.turn * 180) / Math.PI).toBeGreaterThan(120);
    expect(out.assistDv).toBeGreaterThan(8000); // ~11 km/s, for free
  });

  it("a powered (Oberth) periapsis burn raises the outgoing v∞ more than its own size", () => {
    const vInfOut = poweredFlybyVInfOut(6000, JUP.mu, 2 * JUP.radius, 1000);
    expect(vInfOut).toBeGreaterThan(6000 + 1000); // Oberth leverage deep in the well
  });

  it("the max turn is the closest safe pass", () => {
    expect(maxTurnAngle(6000, JUP.mu, minFlybyRadius(JUP)))
      .toBeCloseTo(flybyTurnAngle(6000, JUP.mu, minFlybyRadius(JUP)), 9);
  });

  it("the closest safe pass is a 10% margin for airless bodies and clears any modeled atmosphere", () => {
    // Airless ⇒ the pure 10% altitude margin.
    for (const id of ["moon", "ceres", "europa", "ganymede", "callisto"]) {
      const b = BODY_BY_ID.get(id)!;
      expect(b.atmosphere).toBeUndefined();
      expect(minFlybyRadius(b)).toBeCloseTo(b.radius * 1.1, 6);
    }
    // With an atmosphere ⇒ the safe pass is never below the atmospheric interface (a clean
    // slingshot isn't braking). For every body modeled today the 10% margin already exceeds
    // the interface, so the honest floor is a no-op and minFlybyRadius is still 1.1·radius —
    // the assertion that would flag a future thick-atmosphere body where it no longer is.
    for (const id of ["venus", "earth", "mars", "titan"]) {
      const b = BODY_BY_ID.get(id)!;
      expect(b.atmosphere).toBeDefined();
      expect(minFlybyRadius(b)).toBeGreaterThanOrEqual(b.radius + entryInterfaceAlt(b));
      expect(minFlybyRadius(b)).toBeCloseTo(b.radius * 1.1, 6);
    }
  });
});

describe("B-plane aim geometry", () => {
  it("impact parameter exceeds periapsis and grows with a wider miss", () => {
    const rpDeep = 2 * JUP.radius, rpShallow = 20 * JUP.radius;
    expect(impactParameter(6000, JUP.mu, rpDeep)).toBeGreaterThan(rpDeep); // b = rp·√((e+1)/(e−1)) > rp
    expect(impactParameter(6000, JUP.mu, rpShallow)).toBeGreaterThan(impactParameter(6000, JUP.mu, rpDeep));
  });

  it("solves the free-bend hyperbola that rotates v∞_in into v∞_out's direction", () => {
    const vIn = 6000, ang = (40 * Math.PI) / 180;
    const vInfInVec: Vec3 = { x: vIn, y: 0, z: 0 };
    const vInfOutVec: Vec3 = { x: vIn * Math.cos(ang), y: vIn * Math.sin(ang), z: 0 };
    const aim = bPlaneAim(vInfInVec, vInfOutVec, JUP.mu);

    // The bend matches the in/out angle, and e = 1/sin(δ/2), rp = (e−1)μ/v∞².
    expect(aim.turn).toBeCloseTo(ang, 9);
    expect(aim.e).toBeCloseTo(1 / Math.sin(ang / 2), 9);
    expect(aim.rp).toBeCloseTo(((aim.e - 1) * JUP.mu) / (vIn * vIn), 3);
    expect(aim.b).toBeCloseTo(impactParameter(vIn, JUP.mu, aim.rp), 3);
  });

  it("the B-plane aim and the flyby maneuver agree on the free-pass periapsis (the targeting handle)", () => {
    // Matched excess speeds + a shallow bend ⇒ a feasible FREE flyby: the geometry supplies
    // the whole turn (no residual, ~no burn), so the in-sim executor's recorded periapsis
    // (flybyManeuver.rp, stored as FlybyLeg.rpAchieved) equals the B-plane aim's rp — the
    // same e = 1/sin(δ/2) law — and impactParameter(v∞, μ, rp) equals the aim's b.
    const vIn = 6000, ang = (25 * Math.PI) / 180;
    const vInfInVec: Vec3 = { x: vIn, y: 0, z: 0 };
    const vInfOutVec: Vec3 = { x: vIn * Math.cos(ang), y: vIn * Math.sin(ang), z: 0 };
    const aim = bPlaneAim(vInfInVec, vInfOutVec, JUP.mu);
    const man = flybyManeuver(vInfInVec, vInfOutVec, JUP);
    expect(man.residualTurn).toBe(0); // the shallow bend is achievable for free
    expect(man.dvFlyby).toBeLessThan(1); // matched speeds ⇒ ~no periapsis burn
    expect(man.rp).toBeCloseTo(aim.rp, 0); // identical periapsis
    expect(impactParameter(vIn, JUP.mu, man.rp)).toBeCloseTo(aim.b, 0); // and impact parameter
  });

  it("the B-vector lies in the B-plane (⊥ v∞_in) and in the bend plane", () => {
    const vInfInVec: Vec3 = { x: 5000, y: 1000, z: -2000 };
    const vInfOutVec: Vec3 = { x: 3000, y: 4000, z: 1200 }; // different direction
    const aim = bPlaneAim(vInfInVec, vInfOutVec, JUP.mu);
    const inHat = { x: vInfInVec.x, y: vInfInVec.y, z: vInfInVec.z };
    // bHat is a unit vector, perpendicular to the incoming asymptote…
    expect(length(aim.bHat)).toBeCloseTo(1, 9);
    expect(dot(aim.bHat, inHat) / length(inHat)).toBeCloseTo(0, 9);
    // …and lies in the bend plane (perpendicular to its normal).
    expect(dot(aim.bHat, aim.planeNormal)).toBeCloseTo(0, 9);
    // The plane normal is ⊥ to both excess velocities.
    expect(dot(aim.planeNormal, vInfInVec)).toBeCloseTo(0, 6);
    expect(dot(aim.planeNormal, vInfOutVec)).toBeCloseTo(0, 6);
  });
});

describe("multi-flyby assist chains", () => {
  it("a single-flyby chain reproduces assistTransfer exactly (the n=1 case)", () => {
    const td = 30 * JULIAN_YEAR, tf = 32.5 * JULIAN_YEAR, ta = 39 * JULIAN_YEAR;
    const single = assistTransfer("earth", "jupiter", "saturn", td, tf, ta);
    const chain = chainAssist(["earth", "jupiter", "saturn"], [td, tf, ta]);
    expect(single).not.toBeNull();
    expect(chain).not.toBeNull();
    const s = single!, c = chain!;
    expect(c.flybys).toHaveLength(1);
    expect(c.dvDepart).toBeCloseTo(s.dvDepart, 6);
    expect(c.dvArrive).toBeCloseTo(s.dvArrive, 6);
    expect(c.dvFlybyTotal).toBeCloseTo(s.dvFlyby, 6);
    expect(c.dvTotal).toBeCloseTo(s.dvTotal, 6);
    expect(c.flybys[0]!.rp).toBeCloseTo(s.flybyRadius, 3);
    expect(c.flybys[0]!.vInfIn).toBeCloseTo(s.vInfIn, 6);
    expect(c.flybys[0]!.turnRequired).toBeCloseTo(s.turnRequired, 9);
  });

  it("solves a two-flyby tour (V-E-E-G-A-shaped) with a consistent ledger", () => {
    const ys = [30, 30.8, 32.4, 35.5].map((y) => y * JULIAN_YEAR);
    const r = chainAssist(["earth", "venus", "earth", "jupiter"], ys);
    expect(r).not.toBeNull();
    const c = r!;
    // Two intermediate flybys, in time order, each a real hyperbolic pass.
    expect(c.flybys).toHaveLength(2);
    expect(c.flybys[0]!.t).toBeLessThan(c.flybys[1]!.t);
    for (const f of c.flybys) {
      expect(f.vInfIn).toBeGreaterThan(0);
      expect(f.vInfOut).toBeGreaterThan(0);
      expect(f.rp).toBeGreaterThanOrEqual(minFlybyRadius(BODY_BY_ID.get(f.bodyId)!) - 1);
    }
    // The ledger is internally consistent.
    expect(c.dvTotal).toBeCloseTo(c.dvDepart + c.dvFlybyTotal + c.dvArrive, 3);
    expect(c.dvFlybyTotal).toBeCloseTo(c.flybys.reduce((s, f) => s + f.dvFlyby, 0), 6);
  });

  it("rejects too-few bodies, mismatched lengths, and out-of-order times", () => {
    expect(chainAssist(["earth", "jupiter"], [0, JULIAN_YEAR])).toBeNull(); // no flyby
    expect(chainAssist(["earth", "jupiter", "saturn"], [0, JULIAN_YEAR])).toBeNull(); // length mismatch
    expect(chainAssist(["earth", "jupiter", "saturn"], [0, 2 * JULIAN_YEAR, JULIAN_YEAR])).toBeNull(); // unordered
    expect(chainAssist(["earth", "nope", "saturn"], [0, JULIAN_YEAR, 2 * JULIAN_YEAR])).toBeNull(); // bad body
  });
});

describe("gravity-assist trajectory solver", () => {
  it("produces a consistent, safe single-flyby plan (Earth→Jupiter→Saturn)", () => {
    const tDepart = 30 * JULIAN_YEAR; // ~2030
    const r = searchAssist("earth", "jupiter", "saturn", {
      tDepart,
      flybyWindow: [31.5 * JULIAN_YEAR, 34 * JULIAN_YEAR],
      arriveWindow: [36 * JULIAN_YEAR, 42 * JULIAN_YEAR],
      steps: 24,
    });
    expect(r).not.toBeNull();
    const a = r!;
    // Ledger adds up; times ordered; flyby is a safe pass.
    expect(a.dvTotal).toBeCloseTo(a.dvDepart + a.dvFlyby + a.dvArrive, 3);
    expect(a.tFlyby).toBeGreaterThan(a.tDepart);
    expect(a.tArrive).toBeGreaterThan(a.tFlyby);
    expect(a.flybyRadius).toBeGreaterThanOrEqual(minFlybyRadius(JUP) - 1);
    // The excess speeds in and out roughly match (that's what makes it an assist),
    // and the flyby burn is a small fraction of the launch injection.
    expect(Math.abs(a.vInfIn - a.vInfOut) / a.vInfIn).toBeLessThan(0.5);
    expect(a.dvFlyby).toBeLessThan(a.dvDepart);
    expect(a.vInfIn).toBeGreaterThan(0);
  });

  it("rejects degenerate timings", () => {
    expect(assistTransfer("earth", "jupiter", "saturn", 100, 100, 200)).toBeNull(); // tFlyby == tDepart
  });
});
