/**
 * Integration / invariant suite — the physics subsystems verified TOGETHER.
 *
 * Every other test file checks one module in isolation. These drive the real
 * `Simulation` end-to-end and assert a physical law holds ACROSS the seams:
 * conservation on coast arcs, state continuity across an SOI patch, the capture
 * energy budget, the end-to-end propellant ledger, golden-state determinism, a
 * staging-crossing injection, and a light-lag command applied in a new frame.
 */

import { describe, it, expect } from "vitest";
import { createWorld, type Ship } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import { spawnShip, defaultDesign, planTransfer } from "../app/commands.ts";
import { shipRelativeState, shipWorldState, shipOsculatingElements, dvRemaining } from "@lightlag/engine/ships";
import { orbitalPeriod, specificEnergy, soiRadius } from "@lightlag/engine/orbit";
import { bodyState, bodyElements } from "@lightlag/engine/ephemeris";
import { stateToElements } from "@lightlag/engine/math/kepler";
import { length, cross, add, distance } from "@lightlag/engine/math/vec3";
import { BODY_BY_ID, DAY, MU_SUN, DEFAULT_CAPTURE_ALT } from "@lightlag/engine/constants";
import { hashWorld, serializeWorld, deserializeWorld } from "@lightlag/engine/serialize";
import { marsWindow, buildGoldenScenario, flyUntilCoast } from "./test-helpers.ts";

const MU_EARTH = BODY_BY_ID.get("earth")!.mu;
const MU_MARS = BODY_BY_ID.get("mars")!.mu;
const R_MARS = BODY_BY_ID.get("mars")!.radius;

const totalProp = (stages: { propMass: number }[]) => stages.reduce((s, st) => s + st.propMass, 0);
const relSpread = (xs: number[]) => (Math.max(...xs) - Math.min(...xs)) / Math.abs(xs[0]!);

/** Fly a fresh courier through the whole Earth→Mars transfer to capture. */
function flyToMars(): { sim: Simulation; id: string } {
  const sim = new Simulation(createWorld(1, 0));
  const id = spawnShip(sim, defaultDesign());
  const win = marsWindow();
  planTransfer(sim, id, "mars", win.depT, win.arrT);
  sim.step(win.arrT + 5 * DAY - sim.world.t);
  return { sim, id };
}

describe("B1 — conservation on coast arcs", () => {
  it("specific energy and angular momentum are constant around an Earth parking orbit", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    const el = shipOsculatingElements(ship, 0);
    const P = orbitalPeriod(el.a, MU_EARTH);

    const energy: number[] = [];
    const h: number[] = [];
    for (let k = 0; k <= 16; k++) {
      const st = shipRelativeState(ship, (k / 16) * P);
      const r = length(st.r);
      energy.push(length(st.v) ** 2 / 2 - MU_EARTH / r);
      h.push(length(cross(st.r, st.v)));
    }
    expect(relSpread(energy)).toBeLessThan(1e-12);
    expect(relSpread(h)).toBeLessThan(1e-12);
  });

  it("specific energy and angular momentum are constant along the heliocentric cruise", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    const win = marsWindow();
    planTransfer(sim, id, "mars", win.depT, win.arrT);
    sim.step(win.depT + DAY - sim.world.t); // on the heliocentric leg now
    expect(ship.primary).toBe("sun");

    const t0 = sim.world.t;
    const energy: number[] = [];
    const h: number[] = [];
    for (let k = 0; k <= 16; k++) {
      const st = shipRelativeState(ship, t0 + (k / 16) * 100 * DAY); // sampled before SOI
      const r = length(st.r);
      energy.push(length(st.v) ** 2 / 2 - MU_SUN / r);
      h.push(length(cross(st.r, st.v)));
    }
    expect(relSpread(energy)).toBeLessThan(1e-12);
    expect(relSpread(h)).toBeLessThan(1e-12);
  });
});

describe("B2 — SOI patch continuity", () => {
  it("world position and velocity are continuous across the primary switch", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    const win = marsWindow();
    planTransfer(sim, id, "mars", win.depT, win.arrT);
    sim.step(win.depT + DAY - sim.world.t);

    const soi = sim.events.toArray().find((e) => e.kind === "soi-crossing" && e.entityId === id);
    expect(soi).toBeTruthy();
    const tSoi = soi!.t;

    // Evaluate the world state AT tSoi from the heliocentric conic (before the
    // switch) and from the Mars-centred conic (after) — same instant, so any
    // difference is purely the frame-patch discontinuity, not physical motion.
    sim.step(tSoi - 1 - sim.world.t);
    expect(ship.primary).toBe("sun");
    const before = shipWorldState(ship, tSoi);

    sim.step(tSoi + 1 - sim.world.t);
    expect(ship.primary).toBe("mars");
    const after = shipWorldState(ship, tSoi);

    const dR = distance(before.r, after.r);
    const dV = distance(before.v, after.v);
    // eslint-disable-next-line no-console
    console.log(`B2 SOI patch discontinuity: Δr=${dR.toExponential(3)} m, Δv=${dV.toExponential(3)} m/s`);
    expect(dR).toBeLessThan(1e-3); // sub-millimetre (limited only by the elements round-trip)
    expect(dV).toBeLessThan(1e-9); // sub-nm/s
  });
});

describe("B2b — SOI egress for an uncaptured flyby", () => {
  it("a flyby exits the SOI and rejoins a heliocentric conic — continuous, not stranded about the target", () => {
    const sim = new Simulation(createWorld(1, 0));
    const mars = BODY_BY_ID.get("mars")!;
    const t0 = 100 * DAY;
    const m = bodyState(mars, t0);
    const rSoi = soiRadius(bodyElements(mars, t0)!.a, mars.mu, MU_SUN);

    // Enter the SOI boundary with a sub-escape relative velocity (mixed radial-in +
    // tangential) → a BOUND relative orbit → an off-nominal (uncaptured) arrival
    // that must fly back out rather than be propagated about Mars forever.
    const shipR = add(m.r, { x: rSoi, y: 0, z: 0 });
    const shipV = add(m.v, { x: -200, y: 200, z: 0 });
    const ship: Ship = {
      id: "fly", name: "Flyby", primary: "sun", mode: "coast",
      elements: stateToElements(shipR, shipV, MU_SUN), epoch: t0,
      payloadMass: 1000, stages: [{ name: "S", dryMass: 1000, propMass: 1000, isp: 300, thrust: 1e5 }],
      activeStage: 0, tau: 0,
      transfer: { targetId: "mars", tDepart: 0, tArrive: t0, dvDepart: 0, dvArrive: 0, departed: true, inSoi: false, arrived: false },
    };
    sim.world.ships.set(ship.id, ship);
    sim.events.push({ t: t0, kind: "soi-crossing", entityId: ship.id });

    // Fire the SOI entry: it enters Mars's frame but is NOT captured.
    sim.step(t0 + 1 - sim.world.t);
    expect(ship.primary).toBe("mars");
    expect(ship.transfer!.inSoi).toBe(true);
    expect(ship.transfer!.arrived).toBe(false); // a flyby, not a capture
    const egress = sim.events.toArray().find((e) => e.kind === "soi-exit" && e.entityId === ship.id);
    expect(egress).toBeTruthy();
    const tExit = egress!.t;

    // World state continuity across the egress patch (same instant, both frames).
    sim.step(tExit - 1 - sim.world.t);
    const before = shipWorldState(ship, tExit);
    expect(ship.primary).toBe("mars");
    sim.step(tExit + 1 - sim.world.t);
    expect(ship.primary).toBe("sun"); // re-patched to heliocentric
    expect(ship.transfer!.inSoi).toBe(false);
    const after = shipWorldState(ship, tExit);
    expect(distance(before.r, after.r)).toBeLessThan(1e-3);
    expect(distance(before.v, after.v)).toBeLessThan(1e-9);

    // It is NOT stranded flying to infinity about Mars: the heliocentric orbit is a
    // sane inner-system conic and the ship stays at a planetary heliocentric range.
    expect(Number.isFinite(shipOsculatingElements(ship, sim.world.t).a)).toBe(true);
    const r = length(shipWorldState(ship, tExit + 50 * DAY).r);
    expect(r).toBeGreaterThan(1.2e11); // > 0.8 AU
    expect(r).toBeLessThan(4e11); // < 2.7 AU — bounded, not flung off about Mars
  });
});

describe("B3 — capture energy bookkeeping", () => {
  it("capture leaves a near-circular bound orbit with ε ≈ −μ/2r at the periapsis radius", () => {
    const { sim, id } = flyToMars();
    const ship = sim.world.ships.get(id)!;
    expect(ship.transfer!.arrived).toBe(true);
    expect(ship.primary).toBe("mars");

    const el = shipOsculatingElements(ship, sim.world.t);
    expect(el.e).toBeLessThan(0.02); // vector circularization → very nearly circular
    const r = el.a * (1 - el.e);
    const eps = specificEnergy(MU_MARS, el.a);
    // Near-circular: ε = −μ/2a and −μ/2r agree to within the (1−e) factor.
    expect(Math.abs(eps - -MU_MARS / (2 * r)) / Math.abs(eps)).toBeLessThan(0.03);
    expect(ship.transfer!.dvArrive).toBeGreaterThan(500); // a real capture burn
    expect(ship.transfer!.dvArrive).toBeLessThan(3000);
  });
});

describe("B4 — end-to-end Mars ledger", () => {
  it("the Δv budget drops by exactly the injection + capture impulses, and the orbit clears the surface", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    const win = marsWindow();
    const dvBefore = dvRemaining(ship);
    planTransfer(sim, id, "mars", win.depT, win.arrT);
    sim.step(win.arrT + 5 * DAY - sim.world.t);
    expect(ship.transfer!.arrived).toBe(true);

    const dvSpent = dvBefore - dvRemaining(ship);
    const dvPlanned = ship.transfer!.dvDepart + ship.transfer!.dvArrive;
    expect(Math.abs(dvSpent - dvPlanned) / dvPlanned).toBeLessThan(0.01); // ledger closes < 1%

    const el = shipOsculatingElements(ship, sim.world.t);
    const periAlt = el.a * (1 - el.e) - R_MARS;
    expect(periAlt).toBeGreaterThan(0); // clears the surface
    expect(periAlt).toBeLessThan(DEFAULT_CAPTURE_ALT + 3e6); // a low-ish Mars orbit near the aim
  });
});

describe("B5 — golden-state determinism", () => {
  // Re-baseline ONLY when a physics change legitimately moves the state, and say
  // so in the commit. A surprise change here means an unintended regression.
  // Re-baselined: the Mars arrival hyperbola now carries the planet's J2 SINGLE-PASS
  // periapsis perturbation (maneuver/approach.ts, flown as an ApproachLeg and aimed by
  // the same integrator), so the captured orbit's periapsis moves by O(km) at Mars
  // (hundreds of km at a giant). Determinism is unchanged — chunk-invariance (one-step ≡
  // chunked, above), the serialize round-trip, and the negative control all still hold;
  // only the recorded physical value moved.
  const GOLDEN_HASH = "11f2c9fc7a5876";

  it("the same scenario hashes identically whether run in one step or irregular chunks", () => {
    const oneStep = buildGoldenScenario((sim, tEnd) => sim.step(tEnd - sim.world.t));
    const chunked = buildGoldenScenario((sim, tEnd) => {
      const chunks = [86400, 1e6, 7, 250000, 0.5, 5e5, 3600];
      let i = 0;
      while (sim.world.t < tEnd) sim.step(Math.min(chunks[i++ % chunks.length]!, tEnd - sim.world.t));
    });
    expect(hashWorld(chunked.world)).toBe(hashWorld(oneStep.world));
  });

  it("matches the recorded golden hash (drift guard)", () => {
    const sim = buildGoldenScenario((s, tEnd) => s.step(tEnd - s.world.t));
    const h = hashWorld(sim.world);
    // eslint-disable-next-line no-console
    console.log(`B5 golden hash = ${h}`);
    expect(h).toBe(GOLDEN_HASH);
  });

  it("a state mutation changes the hash (negative control)", () => {
    const sim = buildGoldenScenario((s, tEnd) => s.step(tEnd - s.world.t));
    const h0 = hashWorld(sim.world);
    sim.world.ships.get("ship-1")!.tau += 1;
    expect(hashWorld(sim.world)).not.toBe(h0);
  });

  it("serialize → deserialize → serialize is hash-stable (round-trip)", () => {
    const sim = buildGoldenScenario((s, tEnd) => s.step(tEnd - s.world.t));
    const s1 = serializeWorld(sim.world);
    const w2 = deserializeWorld(s1);
    expect(serializeWorld(w2)).toBe(s1);
    expect(hashWorld(w2)).toBe(hashWorld(sim.world));
  });
});

describe("B6 — multi-stage interplanetary injection", () => {
  it("an injection that exceeds stage-1 capacity drops the stage mid-impulse, and the ledger still closes", () => {
    const sim = new Simulation(createWorld(1, 0));
    // Stage 1 alone gives only ~1.5 km/s — far short of a ~3.6 km/s Mars
    // injection — so executeDeparture's impulsive burn must cross into stage 2.
    const id = spawnShip(sim, {
      name: "TwoStage", payloadMass: 2000, altitudeKm: 400, inclinationDeg: 28.5,
      stages: [
        { name: "S1", dryMass: 3000, propMass: 4000, isp: 300, thrust: 6e5 },
        { name: "S2", dryMass: 1500, propMass: 9000, isp: 340, thrust: 2e5 },
      ],
    });
    const ship = sim.world.ships.get(id)!;
    const win = marsWindow();
    const dvBefore = dvRemaining(ship);
    planTransfer(sim, id, "mars", win.depT, win.arrT);
    sim.step(win.depT + DAY - sim.world.t);

    expect(ship.transfer!.departed).toBe(true);
    expect(ship.primary).toBe("sun"); // it could afford the injection across the stage drop
    expect(ship.activeStage).toBeGreaterThanOrEqual(1); // stage 1 was consumed
    const dvSpent = dvBefore - dvRemaining(ship);
    expect(Math.abs(dvSpent - ship.transfer!.dvDepart) / ship.transfer!.dvDepart).toBeLessThan(0.01);
  });
});

describe("B7 — light-lag command after an SOI change", () => {
  it("a burn ordered after capture is applied about the NEW primary, consumed, and acknowledged", () => {
    const { sim, id } = flyToMars();
    const ship = sim.world.ships.get(id)!;
    expect(ship.primary).toBe("mars"); // already captured at Mars

    const propBefore = totalProp(ship.stages);
    const res = sim.sendCommand(id, { type: "burn", dv: 80, dir: "prograde" });
    expect(res).not.toBeNull();
    // The control node is Earth; the order crawls at c across interplanetary
    // distance, so the delay is many minutes.
    expect(res!.delay).toBeGreaterThan(120);

    // Fly until the order is delivered and the burn completes — and stop there,
    // before the acknowledgement (which left at delivery) has time to crawl back.
    flyUntilCoast(sim, id);

    expect(ship.primary).toBe("mars"); // still bound at Mars — the burn applied here
    expect(totalProp(ship.stages)).toBeLessThan(propBefore); // propellant spent
    expect(sim.world.messages.some((m) => m.kind === "command")).toBe(false); // command consumed
    expect(sim.world.messages.some((m) => m.kind === "telemetry")).toBe(true); // ack crawling back to Earth
    const el = shipOsculatingElements(ship, sim.world.t);
    expect(el.e).toBeLessThan(1); // still a bound orbit about Mars
  });
});
