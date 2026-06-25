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
import { solarFlux, hullArea, equilibriumTemp, detectionRange } from "./thermal.ts";

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

/** Default material/sensor parameters. Material values are physical; the sensor
 *  is a good space IR telescope — its NEP/aperture set the detection SCALE (the
 *  only tunable here), while the 1/r² and T⁴ physics are exact. */
const THERMAL_PARAMS = {
  emissivity: 0.9,
  absorptivity: 0.9,
  housekeepingW: 2000, // baseline onboard electrical load
  driveEfficiency: 0.6, // electrical→jet; the rest is waste heat
};
const SENSOR = { apertureM2: 1, nepW: 1e-15 };

export interface ShipThermal {
  distanceFromSun: number; // m
  solarFlux: number; // W/m² at the ship
  hullArea: number; // m²
  absorbedSolarW: number; // re-radiated sunlight (even a cold hull glows)
  internalW: number; // housekeeping + (thrusting) drive thermal load
  signatureW: number; // total radiated power — what a sensor sees
  hullTempK: number;
  detectionRangeM: number;
  thrusting: boolean;
}

/**
 * The ship's thermodynamic + detection state right now. Energy balance: in
 * steady state everything absorbed/generated must be radiated, so the IR
 * signature equals absorbed sunlight plus internal power. A burning drive adds
 * its (large) input power as heat, spiking the signature — there is no stealth.
 */
export function shipThermalState(ship: Ship, t: number): ShipThermal {
  const r = length(shipWorldState(ship, t).r); // heliocentric distance (Sun at origin)
  const flux = solarFlux(r);
  const A = hullArea(totalMass(ship));
  const absorbed = flux * (A / 4) * THERMAL_PARAMS.absorptivity; // mean cross-section = A/4

  let internal = THERMAL_PARAMS.housekeepingW;
  const thrusting = ship.mode === "thrust";
  if (thrusting) {
    const stage = activeStage(ship);
    if (stage) {
      const ve = exhaustVelocity(stage.isp);
      const jet = 0.5 * stage.thrust * ve; // jet power ½·F·vₑ
      internal += jet / THERMAL_PARAMS.driveEfficiency; // input power → heat (and a bright plume)
    }
  }

  const signature = absorbed + internal;
  return {
    distanceFromSun: r,
    solarFlux: flux,
    hullArea: A,
    absorbedSolarW: absorbed,
    internalW: internal,
    signatureW: signature,
    hullTempK: equilibriumTemp(signature, THERMAL_PARAMS.emissivity, A),
    detectionRangeM: detectionRange(signature, SENSOR.apertureM2, SENSOR.nepW),
    thrusting,
  };
}
