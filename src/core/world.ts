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

/**
 * An in-progress interstellar crossing: a constant-proper-acceleration
 * flip-and-burn (brachistochrone) from `startPos` to a star. The trajectory is
 * ANALYTIC (closed-form distance-vs-coordinate-time), so it is exact at any
 * time-warp, like the planetary ephemeris. `tau` on the ship advances by the
 * dilated PROPER time over the leg — the relativistic seam the tau field was
 * always kept for.
 */
export interface InterstellarLeg {
  targetStar: string;
  tDepart: number; // coordinate time of departure (s since J2000)
  tArrive: number; // coordinate time of arrival
  properAccel: number; // constant proper acceleration a (m/s²)
  startPos: Vec3; // departure position in the root (ecliptic-J2000) frame (m)
}

/** One gravity-assist flyby in a (possibly multi-body) chain. The ship is seeded
 *  toward `bodyId`, swings past it (the heliocentric bend is free), pays any powered
 *  residual, then continues to the next flyby — or, for the last one, to the target. */
export interface FlybyLeg {
  bodyId: string;
  tFlyby: number; // s since J2000 — the patched-conic flyby instant
  dvBurn: number; // estimated powered-flyby Δv (m/s)
  done: boolean; // the flyby has been executed
}

/** An in-progress low-thrust (electric) spiral between near-circular orbits about
 *  the primary. Flown ANALYTICALLY — the semi-major axis grows linearly and the
 *  orbital phase follows in closed form (∫n dt integrates exactly) — so it is
 *  exact at any time-warp. The Edelbaum Δv/propellant were charged at commit. */
export interface SpiralLeg {
  startRadius: number; // m
  endRadius: number; // m
  i: number; // inclination (rad)
  Omega: number; // longitude of ascending node (rad)
  phase0: number; // argument of latitude at tStart (rad)
  tStart: number; // s since J2000
  tEnd: number;
}

/**
 * An in-progress atmospheric-entry / aerocapture pass about `bodyId`. Unlike the
 * other legs the drag trajectory has no closed form, so it is INTEGRATED on demand
 * from a fixed start (the interface-crossing state `r0,v0`) at a fixed step — still
 * a pure deterministic function of time, exact at any time-warp. `exitR,exitV` are
 * the body-relative state at `tEnd` that the finalize uses (so the outcome is set by
 * the commit-time fine pass, independent of how the leg is re-sampled while flying).
 * First cut: planar, ballistic (lift = 0), atmospheric co-rotation ignored. The
 * peak* / heatLoad fields are the precomputed budget shown live in the HUD.
 */
export interface EntryLeg {
  bodyId: string;
  tStart: number; // s since J2000 — the atmospheric-interface crossing
  tEnd: number; // s — landing / skip-out / capture
  r0: Vec3; // body-relative state at the interface (m)
  v0: Vec3; // body-relative velocity at the interface (m/s)
  ballisticCoef: number; // β = m/(Cd·A) (kg/m²)
  noseRadius: number; // R_n (m)
  emissivity: number; // TPS ε
  outcome: "landed" | "captured" | "skip-out";
  exitR: Vec3; // body-relative position at tEnd (m)
  exitV: Vec3; // body-relative velocity at tEnd (m/s)
  peakDecelG: number; // budget summary for the HUD
  peakHeatFlux: number; // W/m²
  peakWallTemp: number; // K
  heatLoad: number; // J/m²
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
  /** Ordered gravity-assist flyby chain between departure and the target (one entry
   *  per intermediate body; a single-flyby mission is a 1-element array). */
  flybys?: FlybyLeg[];
  /** When set, the arrival is an AEROCAPTURE: the injection aims the arrival hyperbola's
   *  periapsis to this altitude (m, inside the atmosphere) so a drag pass — not a propulsive
   *  burn — sheds the energy to capture. Only a small post-pass periapsis-raise trim is paid. */
  aeroPeriAlt?: number;
  /** Apoapsis altitude (m) of an ELLIPTICAL propulsive capture. When set, the capture burn at
   *  periapsis targets a bound ellipse [parking periapsis, this apoapsis] instead of circularizing
   *  — the Oberth-cheap, realistic deep-well insertion. Absent ⇒ the classic low circular capture. */
  captureApoAlt?: number;
  /** Cruise central body for the transfer (default "sun"). A MOON transfer cruises about the
   *  parent PLANET instead — the ship stays in the planet's SOI and patches into the moon's. */
  central?: string;
  /** Final moon of a two-stage CROSS-SYSTEM mission (e.g. Earth→Jupiter→Europa). This
   *  heliocentric leg targets the moon's parent planet; on capture there the sim auto-chains a
   *  parent-centric Stage-2 leg to this moon (see sim.ts), then clears the field. */
  thenMoonId?: string;
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
  /** An in-progress interstellar crossing. While set, the ship's position is the
   *  analytic brachistochrone trajectory in the root frame (primary is "sun"). */
  interstellarLeg?: InterstellarLeg;
  /** An in-progress low-thrust (electric) spiral about the primary. */
  spiral?: SpiralLeg;
  /** An in-progress in-sim atmospheric-entry / aerocapture pass about its body. */
  entryLeg?: EntryLeg;
  /** Set when the ship has touched down on a body's surface (after paying the
   *  descent Δv). `surfaceDir` is the landing site as a BODY-FIXED unit vector, so
   *  the ship co-rotates with the surface (moving at surface speed, not orbital
   *  speed). Drives the UI (offer Launch, not Land) and the "safe touchdown is
   *  implicit" semantics. Cleared on launch. */
  landed?: { bodyId: string; surfaceDir: Vec3 };
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
