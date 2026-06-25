/**
 * The mutable world state — the single source of truth.
 *
 * Design rules that keep the sim deterministic and serializable:
 *  - State is plain data (numbers, strings, plain {x,y,z}, Maps of those).
 *    No class instances with hidden state, no closures, no THREE objects.
 *  - Natural bodies are NOT stored here: they are static, defined in
 *    constants.ts, and their motion is a pure function of `t` (ephemeris.ts).
 *    Only dynamic, player-affected entities live in the world.
 *  - The renderer and UI may READ this freely but must never be the thing that
 *    advances it; only sim.step() mutates state.
 */

import { type Vec3 } from "./math/vec3.ts";
import { type KeplerElements } from "./math/kepler.ts";

/** A spacecraft. Coasting ships are an analytic conic about `primary`; thrusting
 *  ships carry an integrated state vector. (Fleshed out in later phases.) */
export interface Ship {
  id: string;
  name: string;
  primary: string; // id of the body whose SOI it is in
  mode: "coast" | "thrust";
  /** Coast: osculating elements about `primary`. */
  elements?: KeplerElements;
  /** Thrust: integrated state about `primary`. */
  r?: Vec3;
  v?: Vec3;
  /** Accumulated proper time (s). Equal to coordinate time in-system; kept so an
   *  eventual relativistic expansion stays consistent. */
  tau: number;
}

export interface Station {
  id: string;
  name: string;
  primary: string;
  elements: KeplerElements;
}

export interface Maneuver {
  id: string;
  shipId: string;
  tIgnite: number;
  executed: boolean;
}

export interface MessageInFlight {
  id: string;
  fromPos: Vec3;
  tEmit: number;
  tArrive: number; // tEmit + distance/c
  kind: "command" | "telemetry";
  payload: unknown;
}

export interface WorldState {
  /** Sim time, seconds since J2000. */
  t: number;
  /** Seed for the (future) deterministic PRNG. */
  seed: number;
  ships: Map<string, Ship>;
  stations: Map<string, Station>;
  maneuvers: Map<string, Maneuver>;
  messages: MessageInFlight[];
}

/** Create a fresh world. t0 defaults to J2000 (t=0) for reproducibility. */
export function createWorld(seed = 1, t0 = 0): WorldState {
  return {
    t: t0,
    seed,
    ships: new Map(),
    stations: new Map(),
    maneuvers: new Map(),
    messages: [],
  };
}
