/**
 * Helpers that turn the raw Ship record into physical quantities: its current
 * mass (which falls as propellant burns and stages drop), its state about its
 * primary, its absolute state in the root frame, and the osculating orbit it is
 * currently on — coasting or mid-burn.
 */

import { type Ship } from "./world.ts";
import { type Stage, deltaVBudget, exhaustVelocity } from "./propulsion.ts";
import {
  type State,
  type KeplerElements,
  elementsToState,
  stateToElements,
  propagate,
} from "./math/kepler.ts";
import { bodyState } from "./ephemeris.ts";
import { BODY_BY_ID } from "./constants.ts";
import { add, addScaled, length } from "./math/vec3.ts";
import { solarFlux, hullArea, equilibriumTemp, detectionRange, radiatorArea } from "./thermal.ts";

/** GM of the body this ship orbits. */
export function primaryMu(ship: Ship): number {
  const body = BODY_BY_ID.get(ship.primary);
  if (!body) throw new Error(`Ship ${ship.id} has unknown primary ${ship.primary}`);
  return body.mu;
}

/** The currently firing stage, or undefined if the ship is out of stages. */
export function activeStage(ship: Ship): Stage | undefined {
  return ship.stages[ship.activeStage];
}

/** Total current mass: payload + every stage from the active one upward. */
export function totalMass(ship: Ship): number {
  let m = ship.payloadMass;
  for (let i = ship.activeStage; i < ship.stages.length; i++) {
    const st = ship.stages[i]!;
    m += st.dryMass + st.propMass;
  }
  return m;
}

/** Δv still available from the remaining (un-spent) stages. */
export function dvRemaining(ship: Ship): number {
  const remaining = ship.stages.slice(ship.activeStage);
  return deltaVBudget(remaining, ship.payloadMass).total;
}

/** State of the ship relative to its primary (the Earth-centred frame, etc.). */
export function shipRelativeState(ship: Ship, t: number): State {
  if (ship.mode === "thrust" && ship.r && ship.v) {
    // Linear extrapolation from the integrated state's valid time, so callers
    // that query a different time (the light-lag chase, retarded telemetry) get
    // a moving target rather than a frozen point. Exact at t = epoch; over a
    // one-way light delay the neglected thrust curvature is second-order.
    const dt = t - (ship.epoch ?? t);
    return { r: addScaled(ship.r, ship.v, dt), v: ship.v };
  }
  const mu = primaryMu(ship);
  const epoch = ship.epoch ?? 0;
  const el = propagate(ship.elements!, mu, t - epoch);
  return elementsToState(el, mu);
}

/** Absolute state of the ship in the root (heliocentric) frame. */
export function shipWorldState(ship: Ship, t: number): State {
  const rel = shipRelativeState(ship, t);
  const body = BODY_BY_ID.get(ship.primary)!;
  const primary = bodyState(body, t);
  return { r: add(primary.r, rel.r), v: add(primary.v, rel.v) };
}

/**
 * Apply an impulsive Δv (m/s), consuming propellant per the rocket equation and
 * staging across empty tanks as needed. Returns false if the ship cannot afford
 * the full Δv. Used for interplanetary injections, where the burn is short
 * relative to the months-long transfer and the impulsive idealization is
 * standard (the porkchop Δv is itself an impulsive metric).
 */
export function applyImpulsiveDv(ship: Ship, dv: number): boolean {
  if (dv <= 0) return true;
  // Affordability check FIRST, so a maneuver the ship can't pay for makes no
  // mutation — never fabricate Δv on an empty tank.
  if (dv > dvRemaining(ship) + 1e-6) return false;
  let remaining = dv;
  while (remaining > 1e-9) {
    const stage = activeStage(ship);
    if (!stage || stage.propMass <= 0) {
      if (stage) ship.activeStage += 1;
      if (!activeStage(ship)) return false;
      continue;
    }
    const ve = exhaustVelocity(stage.isp);
    const m0 = totalMass(ship);
    const stageCapacity = ve * Math.log(m0 / (m0 - stage.propMass));
    if (stageCapacity >= remaining) {
      stage.propMass -= m0 * (1 - Math.exp(-remaining / ve));
      remaining = 0;
    } else {
      remaining -= stageCapacity;
      stage.propMass = 0;
      ship.activeStage += 1;
    }
  }
  return true;
}

/** The osculating Keplerian orbit the ship is on right now (about its primary). */
export function shipOsculatingElements(ship: Ship, t: number): KeplerElements {
  const mu = primaryMu(ship);
  if (ship.mode === "thrust" && ship.r && ship.v) {
    return stateToElements(ship.r, ship.v, mu);
  }
  const epoch = ship.epoch ?? 0;
  return propagate(ship.elements!, mu, t - epoch);
}

// ── Thermal / power / detection ──────────────────────────────────────────────

/** Material parameters are physical. The sensor (NEP/aperture) and the plume
 *  radiated-fraction set only the detection SCALE — a documented calibration —
 *  while the 1/r², T⁴, and √-power relationships are exact. */
const THERMAL_PARAMS = {
  emissivity: 0.9, // hull IR emissivity
  absorptivity: 0.9, // solar absorptivity (albedo = 1 − absorptivity)
  housekeepingW: 2000, // baseline onboard electrical load → radiated by the hull
  driveEfficiency: 0.6, // useful jet fraction; (1−η)/η of the jet is waste heat to reject
  radiatorTempK: 1000, // assumed drive-radiator operating temperature
};
// A reference watching telescope. `nepW` is the detector noise floor; `bgFloorW`
// is the in-beam zodiacal-IR + CMB background power for this aperture — once the
// signal noise is background-dominated, range is sky-limited, not detector-limited
// (a documented calibration; the 1/√ falloff itself is exact).
const SENSOR = { apertureM2: 1, nepW: 1e-15, bgFloorW: 1e-14 };

export interface ShipThermal {
  distanceFromSun: number; // m
  solarFlux: number; // W/m² at the ship
  hullArea: number; // m²
  hullTempK: number; // passive equilibrium temperature (NOT driven by thrust)
  thermalSignatureW: number; // hull thermal IR
  reflectedSignatureW: number; // reflected sunlight (the dominant cold-hull channel)
  driveWasteW: number; // drive waste heat that must be radiated (0 when coasting)
  radiatorAreaM2: number; // radiator area to reject driveWaste at radiatorTempK
  signatureW: number; // total detectable emission (thermal + reflected + drive)
  detectionRangeM: number;
  thrusting: boolean;
}

/**
 * The ship's thermodynamic + detection state. Three independent emitters, not
 * one algebraic identity:
 *  - the HULL radiates its passive load (absorbed sunlight + housekeeping) at an
 *    equilibrium temperature the drive does NOT change (a burning engine does not
 *    cook the hull to thousands of K — its energy leaves elsewhere);
 *  - the hull REFLECTS sunlight (the channel that actually gives away a cold,
 *    shiny hull at 1 AU — so low emissivity is no stealth, it just trades IR for
 *    glint);
 *  - a thrusting DRIVE rejects (1−η)/η of its jet power as waste heat from
 *    radiators (and a bright plume), a separate, large signature.
 * Detection range is set by the total. There is no stealth in space.
 */
export function shipThermalState(ship: Ship, t: number): ShipThermal {
  const { emissivity, absorptivity, housekeepingW, driveEfficiency, radiatorTempK } = THERMAL_PARAMS;
  const r = length(shipWorldState(ship, t).r); // heliocentric distance (Sun at origin)
  const flux = solarFlux(r);
  const A = hullArea(totalMass(ship));
  const cross = A / 4; // mean sun-facing cross-section of a sphere

  // Passive hull balance: absorbed sunlight + housekeeping, radiated over the
  // full hull area. The drive is deliberately excluded.
  const absorbed = flux * cross * absorptivity;
  const hullInput = absorbed + housekeepingW;
  const hullTempK = equilibriumTemp(hullInput, emissivity, A);
  const thermalSignatureW = hullInput; // steady state: radiated = absorbed + generated

  // Reflected sunlight — the optical channel that dominates cold-hull detection.
  const reflectedSignatureW = flux * cross * (1 - absorptivity);

  // Drive waste heat (radiators + plume), only while thrusting.
  let driveWasteW = 0;
  if (ship.mode === "thrust") {
    const stage = activeStage(ship);
    if (stage) {
      const jet = 0.5 * stage.thrust * exhaustVelocity(stage.isp); // ½·F·vₑ
      driveWasteW = (jet * (1 - driveEfficiency)) / driveEfficiency;
    }
  }

  const signatureW = thermalSignatureW + reflectedSignatureW + driveWasteW;
  return {
    distanceFromSun: r,
    solarFlux: flux,
    hullArea: A,
    hullTempK,
    thermalSignatureW,
    reflectedSignatureW,
    driveWasteW,
    radiatorAreaM2: driveWasteW > 0 ? radiatorArea(driveWasteW, radiatorTempK) : 0,
    signatureW,
    detectionRangeM: detectionRange(signatureW, SENSOR.apertureM2, SENSOR.nepW, SENSOR.bgFloorW),
    thrusting: ship.mode === "thrust",
  };
}
