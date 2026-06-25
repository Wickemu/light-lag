/**
 * Helpers that turn the raw Ship record into physical quantities: its current
 * mass (which falls as propellant burns and stages drop), its state about its
 * primary, its absolute state in the root frame, and the osculating orbit it is
 * currently on — coasting or mid-burn.
 */

import { type Ship } from "./world.ts";
import { type Stage, deltaVBudget } from "./propulsion.ts";
import {
  type State,
  type KeplerElements,
  elementsToState,
  stateToElements,
  propagate,
} from "./math/kepler.ts";
import { bodyState } from "./ephemeris.ts";
import { BODY_BY_ID } from "./constants.ts";
import { add } from "./math/vec3.ts";

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
    return { r: ship.r, v: ship.v };
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

/** The osculating Keplerian orbit the ship is on right now (about its primary). */
export function shipOsculatingElements(ship: Ship, t: number): KeplerElements {
  const mu = primaryMu(ship);
  if (ship.mode === "thrust" && ship.r && ship.v) {
    return stateToElements(ship.r, ship.v, mu);
  }
  const epoch = ship.epoch ?? 0;
  return propagate(ship.elements!, mu, t - epoch);
}
