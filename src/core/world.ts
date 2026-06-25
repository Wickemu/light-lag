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
import { type Stage } from "./propulsion.ts";

/** Directions a burn can be steered in, expressed in the local orbit frame. */
export type BurnDir =
  | "prograde"
  | "retrograde"
  | "radial-out"
  | "radial-in"
  | "normal"
  | "antinormal";

/** An in-progress finite-thrust burn. */
export interface ShipBurn {
  dir: BurnDir;
  dvTarget: number; // m/s of engine Δv to deliver
  dvDone: number; // m/s delivered so far (integrated ∫ F/m dt)
}

/** A planned/active interplanetary transfer (Lambert leg to another body). */
export interface ShipTransfer {
  targetId: string;
  tDepart: number; // s since J2000
  tArrive: number;
  dvDepart: number; // injection Δv (m/s)
  dvArrive: number; // estimated arrival/capture Δv (m/s)
  departed: boolean;
  inSoi: boolean; // entered the target's sphere of influence
  arrived: boolean; // captured into orbit at the target
}

/**
 * A spacecraft. Coasting ships are an analytic conic about `primary` (evaluated
 * from `elements` at any time, like a natural body); thrusting ships carry an
 * integrated state vector `r,v` about `primary`. Mass lives in the staged stack.
 */
export interface Ship {
  id: string;
  name: string;
  primary: string; // id of the body whose SOI it is in
  mode: "coast" | "thrust";
  /** Coast: osculating elements about `primary`, valid at time `epoch`. */
  elements?: KeplerElements;
  epoch?: number; // s, the time `elements` were set
  /** Thrust: integrated state about `primary` (valid at world.t). */
  r?: Vec3;
  v?: Vec3;
  /** Non-propulsive mass carried to the end (habitat, cargo), kg. */
  payloadMass: number;
  /** Stages in firing order; index 0 fires first. Spent stages are removed. */
  stages: Stage[];
  /** Index of the currently firing stage (bottom-most remaining). */
  activeStage: number;
  /** Present only while mode === "thrust". */
  burn?: ShipBurn;
  /** A planned or in-progress interplanetary transfer. */
  transfer?: ShipTransfer;
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

/** A command a control node sends to a ship (delivered at light-lag). */
export type ShipCommand = { type: "burn"; dv: number; dir: BurnDir };

/** A signal propagating at c — a command outbound, or telemetry/ack inbound. */
export interface MessageInFlight {
  id: string;
  kind: "command" | "telemetry";
  fromPos: Vec3; // emission point (fixed in inertial space)
  toPos: Vec3; // target position at arrival (the light-chase solution)
  targetId: string; // ship id (command) or control node id (telemetry)
  tEmit: number;
  tArrive: number; // tEmit + light-time to the moving target
  label: string; // human-readable, for the comms log
  command?: ShipCommand; // present when kind === "command"
}

export interface WorldState {
  /** Sim time, seconds since J2000. */
  t: number;
  /** Seed for the (future) deterministic PRNG. */
  seed: number;
  /** Body id of the player's command origin — all commands/telemetry propagate
   *  to and from here at c. (Game config; the engine just reads it.) */
  controlNode: string;
  ships: Map<string, Ship>;
  stations: Map<string, Station>;
  maneuvers: Map<string, Maneuver>;
  messages: MessageInFlight[];
}

/** Create a fresh world. t0 defaults to J2000 (t=0) for reproducibility. */
export function createWorld(seed = 1, t0 = 0, controlNode = "earth"): WorldState {
  return {
    t: t0,
    seed,
    controlNode,
    ships: new Map(),
    stations: new Map(),
    maneuvers: new Map(),
    messages: [],
  };
}
