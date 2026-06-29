import { describe, it, expect } from "vitest";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
import { spawnShip, sendBurn, defaultDesign, planTransfer, type ShipDesign } from "../app/commands.ts";
import { shipOsculatingElements, totalMass, shipWorldState, shipRelativeState, applyImpulsiveDv, dvRemaining, shipThermalState } from "@lightlag/engine/ships";
import { summarizeOrbit, circularOrbit, apoapsisRadius } from "@lightlag/engine/orbit";
import { serializeWorld, deserializeWorld, hashWorld } from "@lightlag/engine/serialize";
import { exhaustVelocity, propellantForDv, thrustAt, velocityFromRapidity, rapidity } from "@lightlag/engine/propulsion";
import { computePorkchop } from "@lightlag/engine/maneuver/porkchop";
import { bodyState } from "@lightlag/engine/ephemeris";
import { distance, length } from "@lightlag/engine/math/vec3";
import { BODY_BY_ID, DAY, AU, C } from "@lightlag/engine/constants";
import { flyUntilCoast } from "./test-helpers.ts";

const MU_EARTH = BODY_BY_ID.get("earth")!.mu;
const R_EARTH = BODY_BY_ID.get("earth")!.radius;

describe("finite-thrust prograde burn", () => {
  it("raises apoapsis, keeps the burn point as periapsis, and spends propellant per Tsiolkovsky", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;

    const before = summarizeOrbit(shipOsculatingElements(ship, 0), MU_EARTH, R_EARTH);
    const m0 = totalMass(ship);
    const propBefore = ship.stages[0]!.propMass;
    const ve = exhaustVelocity(ship.stages[0]!.isp);

    sendBurn(sim, id, 1000, "prograde");
    flyUntilCoast(sim, id);

    const after = summarizeOrbit(shipOsculatingElements(ship, sim.world.t), MU_EARTH, R_EARTH);

    // A prograde burn from a circular LEO dumps energy into the far side.
    expect(after.apoapsisAlt).toBeGreaterThan(before.apoapsisAlt + 3e6);
    // The burn point stays roughly the periapsis.
    expect(Math.abs(after.periapsisAlt - before.periapsisAlt)).toBeLessThan(1.5e5);

    // Propellant spent matches the rocket equation for the delivered engine Δv.
    // With exact event-detected cutoff this is tight (well under 0.5%).
    const propConsumed = propBefore - ship.stages[0]!.propMass;
    const expected = propellantForDv(ve, m0, 1000);
    expect(Math.abs(propConsumed - expected) / expected).toBeLessThan(0.005);

    // Orbital energy increased.
    expect(after.period).toBeGreaterThan(before.period);
  });

  it("ends in a stable, still-bound orbit (no integrator blow-up)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    sendBurn(sim, id, 800, "prograde");
    flyUntilCoast(sim, id);
    const el = shipOsculatingElements(sim.world.ships.get(id)!, sim.world.t);
    expect(el.e).toBeLessThan(1); // still bound
    expect(el.a).toBeGreaterThan(0);
    expect(Number.isFinite(el.a)).toBe(true);
  });
});

describe("relativistic finite-thrust burn", () => {
  // A synthetic torchship: exhaust at 0.5c and a mass ratio of e² (rapidity
  // capacity = ve·ln(e²) = c). The classical integrator would add velocity
  // linearly and sail past c; the relativistic one composes rapidities and caps
  // below c. ve = 0.5c → isp = 0.5c/g₀. Huge thrust ⇒ a ~10 s burn, so gravity
  // loss is negligible and the final speed is a clean rapidity check.
  const VE = 0.5 * C;
  const torchDesign = () => ({
    name: "Torch",
    payloadMass: 1000,
    altitudeKm: 400,
    inclinationDeg: 0,
    stages: [{ name: "S1", dryMass: 0, propMass: 6389, isp: VE / 9.80665, thrust: 1e11 }],
  });

  it("composes rapidity, caps below c, and never crosses c mid-burn", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, torchDesign());
    const ship = sim.world.ships.get(id)!;
    const m0 = totalMass(ship);
    const propBefore = ship.stages[0]!.propMass;
    const v0 = length(shipRelativeState(ship, 0).v); // primary-relative orbital speed

    const target = 2e8; // m/s of RAPIDITY (< the c capacity, so it cuts cleanly)
    expect(target).toBeLessThan(dvRemaining(ship)); // affordable → ACK, not NACK
    sendBurn(sim, id, target, "prograde");

    // Step through the (light-lagged) command delivery and the whole burn, sampling
    // the primary-relative speed at each integrator boundary. (Sub-luminality is
    // guaranteed by the |v|<c clamp inside properToCoordinateAccel, not by sampling
    // density; this just confirms it at the boundaries.)
    const inFlight = () => sim.world.messages.some((m) => m.kind === "command" && m.targetId === id);
    let maxSpeed = 0, guard = 0;
    while ((ship.mode === "thrust" || inFlight()) && guard++ < 1_000_000) {
      sim.step(1);
      maxSpeed = Math.max(maxSpeed, length(shipRelativeState(ship, sim.world.t).v));
    }
    const vFinal = length(shipRelativeState(ship, sim.world.t).v);

    // Never reached c at any point, and the classical Δv (≈ v0 + 2e8 ≈ 0.67c added
    // linearly) would have, so this is a real relativistic difference.
    expect(maxSpeed).toBeLessThan(C);
    expect(vFinal).toBeLessThan(C);

    // Final speed = the rapidity sum mapped back to velocity (prograde thrust stays
    // along v, so rapidities add along the path). Gravity loss is ~0 at this thrust.
    const expected = velocityFromRapidity(rapidity(v0) + target);
    expect(vFinal).toBeCloseTo(expected, -6); // within ~1e6 m/s of ~1.75e8 (<1%)
    expect(vFinal / C).toBeGreaterThan(0.57);
    expect(vFinal / C).toBeLessThan(0.60);

    // Propellant matches the relativistic rocket equation for the delivered
    // rapidity: m₀/m_f = exp(Δφ/ve) ⇒ consumed = m₀(1 − e^(−Δφ/ve)).
    const propConsumed = propBefore - ship.stages[0]!.propMass;
    const expectedProp = m0 * (1 - Math.exp(-target / VE));
    expect(Math.abs(propConsumed - expectedProp) / expectedProp).toBeLessThan(0.005);
  });

  it("handles a non-prograde (radial-out) relativistic burn without exceeding c or blowing up", () => {
    // Prograde burns are longitudinal (α/γ³). A 'radial-out' burn starts transverse
    // to the orbital velocity — exercising the α/γ² channel and the curving-path
    // integration — while still speeding the ship up to relativistic β. It must stay
    // sub-luminal and finite throughout.
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, torchDesign());
    const ship = sim.world.ships.get(id)!;
    sendBurn(sim, id, 2e8, "radial-out");
    const inFlight = () => sim.world.messages.some((m) => m.kind === "command" && m.targetId === id);
    let maxSpeed = 0, guard = 0;
    while ((ship.mode === "thrust" || inFlight()) && guard++ < 1_000_000) {
      sim.step(1);
      const s = length(shipRelativeState(ship, sim.world.t).v);
      expect(Number.isFinite(s)).toBe(true);
      maxSpeed = Math.max(maxSpeed, s);
    }
    expect(maxSpeed).toBeLessThan(C);
    expect(maxSpeed).toBeGreaterThan(0.3 * C); // the burn actually reached relativistic speed
  });

  it("a sub-relativistic burn is identical to the classical result (reduction)", () => {
    // The same engine, but a small target: must match plain Tsiolkovsky to f64,
    // proving the relativistic path reduces to the classical one at v ≪ c.
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, torchDesign());
    const ship = sim.world.ships.get(id)!;
    const m0 = totalMass(ship);
    const propBefore = ship.stages[0]!.propMass;

    sendBurn(sim, id, 1000, "prograde"); // 1 km/s ≈ rapidity to 12 sig figs
    flyUntilCoast(sim, id);

    const propConsumed = propBefore - ship.stages[0]!.propMass;
    const expected = propellantForDv(VE, m0, 1000); // classical Tsiolkovsky
    expect(Math.abs(propConsumed - expected) / expected).toBeLessThan(1e-6);
  });

  it("is chunk-invariant for grid-aligned stepping (the warp loop's absolute grid)", () => {
    // The finite-thrust integrator sub-steps on a fixed 2 s ABSOLUTE grid, and the
    // propellant ledger is an integral (split-invariant), so any grid-multiple
    // chunking visits identical segment boundaries → identical state. (Sub-2 s
    // chunking introduces off-grid boundaries and so differs at the truncation
    // level, exactly as different RK4 step sizes do — not asserted here.)
    const run = (chunk: number) => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, torchDesign());
      const ship = sim.world.ships.get(id)!;
      sendBurn(sim, id, 2e8, "prograde");
      const inFlight = () => sim.world.messages.some((m) => m.kind === "command" && m.targetId === id);
      let guard = 0;
      while ((ship.mode === "thrust" || inFlight()) && guard++ < 1_000_000) sim.step(chunk);
      return length(shipRelativeState(ship, sim.world.t).v);
    };
    const a = run(2), b = run(10); // both multiples of the 2 s grid
    expect(Math.abs(a - b) / b).toBeLessThan(1e-9);
  });
});

describe("burn cutoff precision (event-detected, no overshoot)", () => {
  it("a small 50 m/s burn consumes propellant within 0.5% of Tsiolkovsky", () => {
    // Pre-fix, a sub-step-boundary cutoff overshot a small burn badly (tens of
    // m/s on a ~16 m/s² stage). Event detection must land it on target.
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    const m0 = totalMass(ship);
    const ve = exhaustVelocity(ship.stages[0]!.isp);
    const propBefore = ship.stages[0]!.propMass;

    sendBurn(sim, id, 50, "prograde");
    flyUntilCoast(sim, id);

    const propConsumed = propBefore - ship.stages[0]!.propMass;
    const expected = propellantForDv(ve, m0, 50);
    expect(Math.abs(propConsumed - expected) / expected).toBeLessThan(0.005);
  });
});

describe("determinism of powered flight", () => {
  it("grid-aligned chunking is reproducible: step(600) == step(300)+step(300)", () => {
    const run = (chunks: number[]) => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, defaultDesign());
      sendBurn(sim, id, 1200, "prograde");
      for (const c of chunks) sim.step(c);
      return shipOsculatingElements(sim.world.ships.get(id)!, sim.world.t);
    };
    const one = run([600]);
    const split = run([300, 300]);
    expect(Math.abs(one.a - split.a)).toBeLessThan(1e-3);
    expect(Math.abs(one.e - split.e)).toBeLessThan(1e-12);
    expect(Math.abs(one.M - split.M)).toBeLessThan(1e-12);
  });

  it("the Δv cutoff lands at the same absolute time regardless of chunk size", () => {
    // Coarse vs fine chunking must agree closely (events are analytic; only RK4
    // truncation differs, ~sub-metre — the old km-scale divergence is gone).
    const run = (chunk: number) => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, defaultDesign());
      sendBurn(sim, id, 1200, "prograde");
      while (sim.world.t < 600) sim.step(chunk);
      return shipOsculatingElements(sim.world.ships.get(id)!, sim.world.t);
    };
    const coarse = run(7); // non-grid-aligned chunk
    const fine = run(0.5);
    expect(Math.abs(coarse.a - fine.a)).toBeLessThan(50); // metres
  });
});

describe("solar-electric thrust derating in a finite burn", () => {
  it("derates an electric burn by 1/r² with heliocentric distance", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, {
      name: "Tug", payloadMass: 1000, altitudeKm: 400, inclinationDeg: 0,
      stages: [{
        name: "Hall", dryMass: 4000, propMass: 2500, isp: 2600, thrust: 0.6,
        electric: { powerW: (0.6 * 2600 * 9.80665) / 1.2, eta: 0.6, solar: true },
      }],
    });
    const ship = sim.world.ships.get(id)!;

    // Relocate to a 3 AU heliocentric circular orbit — well outside 1 AU, where
    // the solar array is power-starved and the electric thruster must derate. At
    // 1 AU (Earth) the array is at rated power, so the bug would be invisible.
    const r = 3 * AU;
    ship.primary = "sun"; // a freshly spawned ship is already coasting
    ship.elements = circularOrbit(r);
    ship.epoch = 0;
    ship.r = undefined;
    ship.v = undefined;

    const stage = ship.stages[0]!;
    const ve = exhaustVelocity(stage.isp);

    // Commanded Δv far exceeds what the window delivers, so the burn stays active.
    sendBurn(sim, id, 5000, "prograde");
    // Run until the light-lagged command reaches the ship and the burn is under way.
    let guard = 0;
    while (ship.mode !== "thrust" && guard++ < 200) sim.step(200);
    expect(ship.mode).toBe("thrust");

    // Propellant burned over a clean continuously-thrusting window is ṁ·Δt, which
    // reveals the actual (derated) thrust applied.
    const p1 = stage.propMass;
    const t1 = sim.world.t;
    sim.step(4000);
    const dt = sim.world.t - t1;
    const consumed = p1 - stage.propMass;

    const expectedDerated = (thrustAt(stage, r) / ve) * dt; // ≈ rated/9 at 3 AU
    const ratedAmount = (stage.thrust / ve) * dt;           // the pre-fix (buggy) amount

    expect(ship.mode).toBe("thrust"); // still burning — 5000 m/s target unreached
    expect(Math.abs(consumed - expectedDerated) / expectedDerated).toBeLessThan(0.01);
    expect(consumed).toBeLessThan(ratedAmount / 5); // derating is ~9× at 3 AU
  });
});

describe("interplanetary transfer execution", () => {
  it("departs on the heliocentric leg and arrives at Mars", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;

    // Pick the cheapest window from a porkchop over one synodic period.
    const pork = computePorkchop({
      fromId: "earth", toId: "mars",
      depStart: 0, depEnd: 800 * DAY, depN: 60,
      tofMin: 120 * DAY, tofMax: 330 * DAY, tofN: 44,
      rParkFrom: R_EARTH + 4e5,
      rParkTo: BODY_BY_ID.get("mars")!.radius + 4e5,
    });
    const best = pork.best!;
    const plan = planTransfer(sim, id, "mars", best.depT, best.arrT);
    expect(plan).not.toBeNull();
    expect(ship.primary).toBe("earth"); // not yet departed

    // Fast-forward past departure: the injection fires from the event queue.
    sim.step(best.depT + DAY);
    expect(ship.transfer!.departed).toBe(true);
    expect(ship.primary).toBe("sun"); // now on the heliocentric transfer

    // Fast-forward to arrival.
    sim.step(best.arrT - sim.world.t + DAY);
    expect(ship.transfer!.arrived).toBe(true);

    // The ship should be essentially at Mars at the arrival instant.
    const shipPos = shipWorldState(ship, best.arrT).r;
    const marsPos = bodyState(BODY_BY_ID.get("mars")!, best.arrT).r;
    expect(distance(shipPos, marsPos)).toBeLessThan(1e8); // < 100,000 km
  });
});

describe("Phase 4: SOI patched conics and Mars capture", () => {
  it("crosses Mars's SOI and captures into a bound orbit above the surface", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    const mars = BODY_BY_ID.get("mars")!;

    const pork = computePorkchop({
      fromId: "earth", toId: "mars",
      depStart: 0, depEnd: 800 * DAY, depN: 60,
      tofMin: 120 * DAY, tofMax: 330 * DAY, tofN: 44,
      rParkFrom: R_EARTH + 4e5,
      rParkTo: mars.radius + 4e5,
    });
    const best = pork.best!;
    planTransfer(sim, id, "mars", best.depT, best.arrT);

    // Fly the entire transfer in one jump; the event cascade (depart → SOI
    // crossing → capture) all fires inside the analytic fast path.
    sim.step(best.arrT - sim.world.t + 5 * DAY);

    expect(ship.transfer!.departed).toBe(true);
    expect(ship.transfer!.inSoi).toBe(true);
    expect(ship.transfer!.arrived).toBe(true);
    expect(ship.primary).toBe("mars");

    const el = shipOsculatingElements(ship, sim.world.t);
    expect(el.e).toBeLessThan(0.02); // vector circularization → very near circular
    expect(el.a).toBeGreaterThan(0);
    const peri = el.a * (1 - el.e);
    expect(peri).toBeGreaterThan(mars.radius); // clears the surface
    expect(peri).toBeLessThan(mars.radius + 3e6); // a low-ish Mars orbit
  });

  it("refuses a transfer the ship cannot afford (no free Δv on an empty tank)", () => {
    const sim = new Simulation(createWorld(1, 0));
    // A tug with only ~0.66 km/s — far short of the ~3.6 km/s injection.
    const id = spawnShip(sim, {
      name: "Tug", payloadMass: 3000, altitudeKm: 400, inclinationDeg: 28.5,
      stages: [{ name: "S1", dryMass: 5000, propMass: 2000, isp: 300, thrust: 1e6 }],
    });
    const ship = sim.world.ships.get(id)!;
    const pork = computePorkchop({
      fromId: "earth", toId: "mars",
      depStart: 0, depEnd: 800 * DAY, depN: 60, tofMin: 120 * DAY, tofMax: 330 * DAY, tofN: 44,
      rParkFrom: R_EARTH + 4e5, rParkTo: BODY_BY_ID.get("mars")!.radius + 4e5,
    });
    const best = pork.best!;
    const dvBefore = dvRemaining(ship);
    planTransfer(sim, id, "mars", best.depT, best.arrT);
    sim.step(best.depT - sim.world.t + DAY);

    expect(ship.primary).toBe("earth"); // never left the parking orbit
    expect(dvRemaining(ship)).toBeCloseTo(dvBefore, 3); // propellant untouched
    // And the transfer is NOT falsely marked departed — it stays re-plannable
    // rather than soft-locking as a fabricated "in transit" state.
    expect(ship.transfer!.departed).toBe(false);
  });
});

describe("audit-fix regressions", () => {
  it("rejects (NACKs) a commanded burn it cannot complete, spending no propellant", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    const propBefore = ship.stages.reduce((s, st) => s + st.propMass, 0);
    sim.sendCommand(id, { type: "burn", dv: 1e5, dir: "prograde" }); // far past the ~7.9 km/s budget
    let g = 0;
    while (sim.world.messages.some((m) => m.kind === "command") && g++ < 100000) sim.step(1);
    // The order was delivered (consumed) but refused: no thrust, no propellant
    // spent. (For a LEO ship the NACK round-trips back within the same sub-second
    // step, so it isn't asserted in-flight here — see B7 for the ack/nack path.)
    expect(ship.mode).toBe("coast"); // never started a burn it could not finish
    expect(ship.stages.reduce((s, st) => s + st.propMass, 0)).toBe(propBefore); // no propellant spent
  });

  it("a budget-exhausting impulsive burn never leaves a negative propellant residue", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    expect(applyImpulsiveDv(ship, dvRemaining(ship))).toBe(true); // spend the entire budget
    for (const st of ship.stages) expect(st.propMass).toBeGreaterThanOrEqual(0);
  });

  it("shipOsculatingElements honours the query time mid-burn (not epoch-frozen)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    sim.sendCommand(id, { type: "burn", dv: 500, dir: "prograde" });
    let g = 0;
    while (ship.mode !== "thrust" && g++ < 50) sim.step(1);
    expect(ship.mode).toBe("thrust");
    const epoch = ship.epoch!;
    // Epoch-frozen would return identical elements regardless of t; the fix
    // extrapolates, so the mean anomaly advances with the query time.
    expect(shipOsculatingElements(ship, epoch + 30).M).not.toBe(shipOsculatingElements(ship, epoch).M);
  });

  it("re-seeds the message-id counter from a restored world so ids are never reused", () => {
    const w = createWorld(1, 0);
    w.messages.push({
      id: "msg-5", kind: "telemetry", fromPos: { x: 0, y: 0, z: 0 }, toPos: { x: 0, y: 0, z: 0 },
      targetId: "earth", tEmit: 0, tArrive: 1e9, label: "restored",
    });
    const sim = new Simulation(w); // reconstructed from a world that already holds msg-5
    const id = spawnShip(sim, defaultDesign());
    sim.sendCommand(id, { type: "burn", dv: 10, dir: "prograde" });
    const newId = sim.world.messages.map((m) => m.id).find((x) => x !== "msg-5")!;
    expect(Number(newId.replace("msg-", ""))).toBeGreaterThan(5); // not a reused id
  });
});

describe("applyImpulsiveDv affordability", () => {
  it("returns false and mutates nothing when the burn is unaffordable", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    const before = totalMass(ship);
    expect(applyImpulsiveDv(ship, 1e6)).toBe(false); // way past the budget
    expect(totalMass(ship)).toBe(before);
  });
});

describe("Phase 5: light-lag command", () => {
  it("a burn order reaches a ship in transit only after the one-way light delay", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const pork = computePorkchop({
      fromId: "earth", toId: "mars",
      depStart: 0, depEnd: 800 * DAY, depN: 60, tofMin: 120 * DAY, tofMax: 330 * DAY, tofN: 44,
      rParkFrom: R_EARTH + 4e5, rParkTo: BODY_BY_ID.get("mars")!.radius + 4e5,
    });
    const best = pork.best!;
    planTransfer(sim, id, "mars", best.depT, best.arrT);
    sim.step(best.depT + 130 * DAY - sim.world.t); // deep in transit, far from Earth
    const ship = sim.world.ships.get(id)!;
    expect(ship.primary).toBe("sun");

    const propBefore = ship.stages.reduce((s, st) => s + st.propMass, 0);
    const res = sim.sendCommand(id, { type: "burn", dv: 50, dir: "prograde" });
    expect(res).not.toBeNull();
    expect(res!.delay).toBeGreaterThan(120); // minutes of light-lag, not instant
    expect(ship.mode).toBe("coast"); // order not yet arrived

    sim.step(res!.delay - 60);
    expect(ship.mode).toBe("coast"); // still en route
    expect(ship.stages.reduce((s, st) => s + st.propMass, 0)).toBe(propBefore); // no burn yet

    sim.step(120); // cross the arrival time (the short burn may also finish here)
    // Order delivered: propellant was spent, the command is consumed, and an
    // acknowledgement is now crawling back to Earth at c.
    expect(ship.stages.reduce((s, st) => s + st.propMass, 0)).toBeLessThan(propBefore);
    expect(sim.world.messages.some((m) => m.kind === "command")).toBe(false);
    expect(sim.world.messages.some((m) => m.kind === "telemetry")).toBe(true);
  });

  it("integrates a light-lag-delivered burn the same whether stepped coarse or fine", () => {
    // A command can be delivered (and its burn started) mid-interval while the
    // player fast-forwards. The event-aware step must integrate that burn, not
    // skip it, regardless of how time was chunked.
    const run = (chunk: number) => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, defaultDesign());
      const pork = computePorkchop({
        fromId: "earth", toId: "mars",
        depStart: 0, depEnd: 800 * DAY, depN: 60, tofMin: 120 * DAY, tofMax: 330 * DAY, tofN: 44,
        rParkFrom: R_EARTH + 4e5, rParkTo: BODY_BY_ID.get("mars")!.radius + 4e5,
      });
      const best = pork.best!;
      planTransfer(sim, id, "mars", best.depT, best.arrT);
      sim.step(best.depT + 130 * DAY - sim.world.t);
      const res = sim.sendCommand(id, { type: "burn", dv: 200, dir: "prograde" })!;
      const tEnd = sim.world.t + res.delay + 5000;
      while (sim.world.t < tEnd) sim.step(Math.min(chunk, tEnd - sim.world.t));
      return shipOsculatingElements(sim.world.ships.get(id)!, sim.world.t);
    };
    const big = run(1e12); // one giant jump across delivery + burn
    const fine = run(30);
    expect(Math.abs(big.a - fine.a)).toBeLessThan(50); // metres
    expect(Math.abs(big.e - fine.e)).toBeLessThan(1e-5);
  });
});

describe("Phase: closed-loop guidance", () => {
  const propOf = (sim: Simulation, id: string) =>
    sim.world.ships.get(id)!.stages.reduce((s, st) => s + st.propMass, 0);

  // Put a ship deep in heliocentric transit (primary === "sun"), far from Earth.
  const inTransit = () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const pork = computePorkchop({
      fromId: "earth", toId: "mars",
      depStart: 0, depEnd: 800 * DAY, depN: 60, tofMin: 120 * DAY, tofMax: 330 * DAY, tofN: 44,
      rParkFrom: R_EARTH + 4e5, rParkTo: BODY_BY_ID.get("mars")!.radius + 4e5,
    });
    const best = pork.best!;
    planTransfer(sim, id, "mars", best.depT, best.arrT);
    sim.step(best.depT + 130 * DAY - sim.world.t);
    return { sim, id };
  };

  it("trims Δv at delivery to hit the target apoapsis (LEO)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    const targetAlt = 2000e3; // raise apoapsis to 2000 km
    sendBurn(sim, id, 2000, "prograde", { kind: "apoapsis", rTarget: R_EARTH + targetAlt });
    flyUntilCoast(sim, id);
    const after = summarizeOrbit(shipOsculatingElements(ship, sim.world.t), MU_EARTH, R_EARTH);
    // Impulsive-sized goal vs. the finite, continuously-steered burn ⇒ a small gap.
    expect(Math.abs(after.apoapsisAlt - targetAlt)).toBeLessThan(5e4); // within ~50 km
  });

  it("refuses (NACK) when the goal needs more than the correction cap", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    const propBefore = propOf(sim, id);
    // ~2.3 km/s would be needed; cap it at 50 m/s ⇒ unreachable.
    const delay = sendBurn(sim, id, 50, "prograde", { kind: "apoapsis", rTarget: R_EARTH + 30000e3 });
    expect(delay).not.toBeNull();
    sim.step(delay! + 1); // past delivery
    expect(sim.world.messages.some((m) => m.kind === "command")).toBe(false); // delivered + consumed
    expect(ship.mode).toBe("coast"); // but no burn started → NACK
    expect(propOf(sim, id)).toBe(propBefore);
  });

  it("refuses (NACK) when the ship has left the goal's SOI", () => {
    const { sim, id } = inTransit();
    const ship = sim.world.ships.get(id)!;
    expect(ship.primary).toBe("sun");
    const propBefore = propOf(sim, id);
    // A goal framed about "earth" is invalid for a ship now orbiting the Sun.
    const res = sim.sendCommand(id, {
      type: "burn", dv: 100, dir: "prograde",
      goal: { kind: "apoapsis", rTarget: R_EARTH + 1000e3 }, goalPrimary: "earth",
    })!;
    sim.step(res.delay + 5000);
    expect(sim.world.messages.some((m) => m.kind === "command")).toBe(false);
    expect(ship.mode).toBe("coast");
    expect(propOf(sim, id)).toBe(propBefore);
  });

  it("refuses (NACK) when the orbit already meets the goal", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;
    const propBefore = propOf(sim, id);
    const delay = sendBurn(sim, id, 500, "prograde", { kind: "circular" }); // already circular at LEO
    expect(delay).not.toBeNull();
    sim.step(delay! + 1);
    expect(ship.mode).toBe("coast");
    expect(propOf(sim, id)).toBe(propBefore);
  });

  it("integrates a closed-loop-delivered burn identically across time-chunkings", () => {
    const run = (chunk: number) => {
      const { sim, id } = inTransit();
      const ship = sim.world.ships.get(id)!;
      const el0 = shipOsculatingElements(ship, sim.world.t);
      const rTarget = apoapsisRadius(el0.a, el0.e) + 2e8; // a modest heliocentric apoapsis raise
      const res = sim.sendCommand(id, {
        type: "burn", dv: 5000, dir: "prograde",
        goal: { kind: "apoapsis", rTarget }, goalPrimary: "sun",
      })!;
      const tEnd = sim.world.t + res.delay + 5000;
      while (sim.world.t < tEnd) sim.step(Math.min(chunk, tEnd - sim.world.t));
      return shipOsculatingElements(ship, sim.world.t);
    };
    const big = run(1e12); // one giant jump across delivery + the trimmed burn
    const fine = run(30);
    expect(Math.abs(big.a - fine.a)).toBeLessThan(50); // metres
    expect(Math.abs(big.e - fine.e)).toBeLessThan(1e-5);
  });

  it("serializes an OPEN-loop command byte-identically (no goal fields)", () => {
    const { sim, id } = inTransit();
    sim.sendCommand(id, { type: "burn", dv: 50, dir: "prograde" }); // stays in flight (long delay)
    const ser = JSON.parse(serializeWorld(sim.world));
    const cmd = ser.messages.find((m: { kind: string }) => m.kind === "command").command;
    expect(Object.keys(cmd).sort()).toEqual(["dir", "dv", "type"]);
  });

  it("round-trips a closed-loop command through serialize/deserialize hash-stably", () => {
    const { sim, id } = inTransit();
    sim.sendCommand(id, {
      type: "burn", dv: 100, dir: "prograde",
      goal: { kind: "periapsis", rTarget: 1.4e11 }, goalPrimary: "sun",
    });
    const h1 = hashWorld(sim.world);
    const w2 = deserializeWorld(serializeWorld(sim.world));
    expect(hashWorld(w2)).toBe(h1);
    const cmd = w2.messages.find((m) => m.kind === "command")!.command!;
    expect(cmd.goal).toBeDefined();
    expect(cmd.goalPrimary).toBe("sun");
  });
});

describe("Phase 6: ship thermal & detection model", () => {
  it("a thrusting drive spikes the signature but does NOT cook the hull", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;

    const coast = shipThermalState(ship, 0);
    expect(coast.hullTempK).toBeGreaterThan(250); // ~1 AU equilibrium
    expect(coast.hullTempK).toBeLessThan(360);
    expect(coast.reflectedSignatureW).toBeGreaterThan(0); // reflected-sunlight channel exists
    expect(coast.driveWasteW).toBe(0);
    expect(coast.detectionRangeM).toBeGreaterThan(0); // even cold, you glow

    sim.sendCommand(id, { type: "burn", dv: 500, dir: "prograde" });
    let g = 0;
    while (ship.mode !== "thrust" && g++ < 50) sim.step(1);
    const burn = shipThermalState(ship, sim.world.t);

    // Hull temperature is set by the passive load, not the drive — no vaporizing.
    expect(burn.hullTempK).toBeLessThan(360);
    expect(burn.driveWasteW).toBeGreaterThan(0);
    expect(burn.radiatorAreaM2).toBeGreaterThan(0); // a real radiator burden
    // A burning drive is a far brighter beacon than a coasting hull.
    expect(burn.detectionRangeM).toBeGreaterThan(coast.detectionRangeM * 5);
  });

  it("a solar-electric drive's waste heat derates with solar distance, not the rated thrust", () => {
    // Same tug as the burn-derating test: at 1 AU the array is at rated power, at
    // 3 AU it is power-starved to ~1/9. Pre-fix the thermal model used the RATED
    // thrust and reported the same waste heat at both distances; now it tracks the
    // live (derated) drive, so the far signature is correspondingly fainter.
    const design = {
      name: "Tug", payloadMass: 1000, altitudeKm: 400, inclinationDeg: 0,
      stages: [{
        name: "Hall", dryMass: 4000, propMass: 2500, isp: 2600, thrust: 0.6,
        electric: { powerW: (0.6 * 2600 * 9.80665) / 1.2, eta: 0.6, solar: true },
      }],
    };
    const wasteAt = (r: number): number => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, design);
      const ship = sim.world.ships.get(id)!;
      ship.primary = "sun";
      ship.elements = circularOrbit(r);
      ship.epoch = 0;
      ship.r = undefined;
      ship.v = undefined;
      sendBurn(sim, id, 5000, "prograde");
      let guard = 0;
      while (ship.mode !== "thrust" && guard++ < 200) sim.step(200);
      expect(ship.mode).toBe("thrust");
      return shipThermalState(ship, sim.world.t).driveWasteW;
    };
    const near = wasteAt(AU);
    const far = wasteAt(3 * AU);
    expect(far).toBeGreaterThan(0);
    expect(far).toBeCloseTo(near / 9, 5); // power ∝ 1/r² ⇒ waste ∝ 1/r²
    expect(far).toBeLessThan(near / 5); // unmistakably derated, not the flat rated value
  });
});

describe("staging", () => {
  it("drops the spent stage and keeps delivering Δv from the next", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, defaultDesign());
    const ship = sim.world.ships.get(id)!;

    // Stage 1 alone provides ~3.23 km/s; ask for 5 km/s to force a stage drop.
    sendBurn(sim, id, 5000, "prograde");
    flyUntilCoast(sim, id);

    expect(ship.activeStage).toBe(1); // advanced into the second stage
    // Engine Δv delivered should be close to the requested 5 km/s (stack has ~7.9).
    // After coast the burn record is cleared, so verify via remaining propellant:
    expect(ship.stages[0]!.propMass).toBeLessThan(1); // first tank emptied
    expect(ship.stages[1]!.propMass).toBeGreaterThan(0); // second still has fuel
  });
});

describe("parallel staging (in-sim)", () => {
  // A heavy first stage with two unequal-Isp strap-on boosters, then a small upper.
  const heavyDesign = (): ShipDesign => ({
    name: "Heavy", payloadMass: 3000, altitudeKm: 400, inclinationDeg: 28.5,
    stages: [
      {
        name: "Core", dryMass: 5000, propMass: 50000, isp: 300, thrust: 1.2e6,
        boosters: [{ name: "SRB", dryMass: 2000, propMass: 40000, isp: 280, thrust: 6e5, count: 2 }],
      },
      { name: "Upper", dryMass: 2000, propMass: 15000, isp: 340, thrust: 2.0e5 },
    ],
  });

  // Analytic figures for the concurrent core+boosters phase (different Isp ⇒ the
  // blend is genuine, not a no-op).
  const veC = exhaustVelocity(300), veB = exhaustVelocity(280);
  const F = 1.2e6 + 2 * 6e5;
  const mdot = 1.2e6 / veC + (2 * 6e5) / veB;
  const veEff = F / mdot;
  const m0 = 3000 + (55000 + 2 * 42000) + 17000; // payload + core wet + boosters wet + upper wet

  it("totalMass counts payload + core + live boosters + upper stage", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, heavyDesign());
    const ship = sim.world.ships.get(id)!;
    // 3000 payload + 55t core + 2×42t boosters + 17t upper
    expect(totalMass(ship)).toBeCloseTo(m0, 6);
  });

  it("spends propellant at the thrust-weighted vₑ_eff = F/ṁ (single parallel phase)", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, heavyDesign());
    const ship = sim.world.ships.get(id)!;
    const dvTarget = 1000; // small: no reservoir empties, so vₑ_eff is constant

    sendBurn(sim, id, dvTarget, "prograde");
    flyUntilCoast(sim, id);

    // Single phase: boosters survive, stage hasn't advanced.
    expect(ship.activeStage).toBe(0);
    expect(ship.stages[0]!.boosters!.length).toBe(1);

    const boosterProp = ship.stages[0]!.boosters!.reduce((s, b) => s + b.propMass * (b.count ?? 1), 0);
    const consumed = (50000 + 2 * 40000) - (ship.stages[0]!.propMass + boosterProp);
    const predicted = m0 * (1 - Math.exp(-dvTarget / veEff)); // m0·(1 − e^(−Δv/vₑ_eff))
    expect(Math.abs(consumed - predicted) / predicted).toBeLessThan(1e-4);

    // Both tanks drained, in proportion to their mass flow ṁ.
    const coreConsumed = 50000 - ship.stages[0]!.propMass;
    const boosterConsumed = 2 * 40000 - boosterProp;
    expect(coreConsumed / boosterConsumed).toBeCloseTo((1.2e6 / veC) / ((2 * 6e5) / veB), 2);
  });

  it("drops boosters and the dead core, advancing to the upper stage; Δv ledger closes", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, heavyDesign());
    const ship = sim.world.ships.get(id)!;
    const dvBefore = dvRemaining(ship);
    const dvTarget = 5500; // > the ~4.77 km/s of stage 0: empties core then boosters

    sendBurn(sim, id, dvTarget, "prograde");
    flyUntilCoast(sim, id);

    // The core empties first; the longer-lived boosters push the dead core, then
    // both drop and the upper stage ignites.
    expect(ship.activeStage).toBe(1);
    expect(ship.stages[0]!.boosters?.length ?? 0).toBe(0);
    expect(ship.stages[0]!.propMass).toBeLessThan(1);
    expect(ship.stages[1]!.propMass).toBeGreaterThan(0);
    // Δv is the conserved currency: remaining capacity drops by the delivered Δv.
    const delivered = dvBefore - dvRemaining(ship);
    expect(Math.abs(delivered - dvTarget) / dvTarget).toBeLessThan(0.01);
  });

  it("is chunk-invariant: the propellant ledger telescopes regardless of step size", () => {
    const run = (chunk: number): number => {
      const sim = new Simulation(createWorld(1, 0));
      const id = spawnShip(sim, heavyDesign());
      const ship = sim.world.ships.get(id)!;
      sendBurn(sim, id, 1000, "prograde");
      let guard = 0;
      const inFlight = (): boolean => sim.world.messages.some((mm) => mm.kind === "command" && mm.targetId === id);
      while ((ship.mode === "thrust" || inFlight()) && guard++ < 200000) sim.step(chunk);
      return ship.stages[0]!.propMass + ship.stages[0]!.boosters!.reduce((s, b) => s + b.propMass * (b.count ?? 1), 0);
    };
    expect(run(10)).toBeCloseTo(run(1), 3);
  });

  it("an isp=0 booster does not hang the in-sim burn; the ship coasts with finite state", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, {
      name: "Degenerate", payloadMass: 3000, altitudeKm: 400, inclinationDeg: 28.5,
      stages: [{
        name: "Core", dryMass: 5000, propMass: 50000, isp: 300, thrust: 1.2e6,
        boosters: [{ name: "bad", dryMass: 2000, propMass: 20000, isp: 0, thrust: 5e5 }],
      }],
    });
    const ship = sim.world.ships.get(id)!;
    sendBurn(sim, id, 1000, "prograde");
    flyUntilCoast(sim, id); // throws if the burn never completes (the hang we fixed)
    expect(ship.mode).toBe("coast");
    expect(Number.isFinite(ship.elements!.a)).toBe(true);
  });

  it("applyImpulsiveDv delivers a just-affordable boostered burn instead of draining then NACKing", () => {
    const sim = new Simulation(createWorld(1, 0));
    const id = spawnShip(sim, {
      name: "Edge", payloadMass: 5000, altitudeKm: 400, inclinationDeg: 28.5,
      stages: [{
        name: "Core", dryMass: 10000, propMass: 100000, isp: 400, thrust: 1e6,
        boosters: [{ name: "B", dryMass: 3000, propMass: 30000, isp: 250, thrust: 1e6 }],
      }],
    });
    const ship = sim.world.ships.get(id)!;
    const full = dvRemaining(ship);
    // dv = the whole budget plus a sub-tolerance sliver: must succeed (within the
    // +1e-6 affordability gate), not return false after emptying the tanks.
    expect(applyImpulsiveDv(ship, full + 5e-7)).toBe(true);
    expect(dvRemaining(ship)).toBeLessThan(1);
  });
});
