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
 *  toward `bodyId`, swings past it (the bend is free), pays any powered residual, then
 *  continues to the next flyby — or, for the last one, to the target. Frame-agnostic:
 *  heliocentric (planets as assist bodies) when the transfer's `central` is unset, or
 *  parent-centric (a planet's moons as assist bodies — an intra-system tour) when set. */
export interface FlybyLeg {
  bodyId: string;
  tFlyby: number; // s since J2000 — the patched-conic flyby instant
  dvBurn: number; // estimated powered-flyby Δv (m/s)
  done: boolean; // the flyby has been executed
  // B-plane geometry of the executed pass, recorded at execution for inspection /
  // HUD readout. All OPTIONAL (present only once the pass is flown) ⇒ a planned-but-
  // unflown chain and the golden scenario serialize without them (hash-neutral).
  rpAchieved?: number; // flown periapsis radius (m) — the rpMin-clamped pass periapsis
  bMag?: number; // impact parameter |B| (m) at rpAchieved — the B-plane targeting handle
  turn?: number; // bend angle required between the in/out excess velocities (rad)
  residualTurn?: number; // turn beyond the free bend, paid by the periapsis burn (rad); 0 ⇒ free
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
  outcome: "landed" | "captured" | "skip-out" | "crashed";
  exitR: Vec3; // body-relative position at tEnd (m)
  exitV: Vec3; // body-relative velocity at tEnd (m/s)
  peakDecelG: number; // budget summary for the HUD
  peakHeatFlux: number; // W/m²
  peakWallTemp: number; // K
  heatLoad: number; // J/m²
}

/** One sampled point of a powered ascent/descent arc: `t` is elapsed seconds since
 *  the leg started (so it is warp/epoch-independent and small-magnitude), `h` altitude
 *  above the surface (m), `v` speed (m/s), `gamma` flight-path angle (rad, positive-up —
 *  climbing on ascent, negative descending), `theta` downrange angle swept (rad). */
export interface PoweredSample {
  t: number;
  h: number;
  v: number;
  gamma: number;
  theta: number;
}

/**
 * An in-progress in-sim powered ASCENT from a surface to a parking orbit. Visual only:
 * the Δv/propellant were charged at commit and the terminal parking orbit is PINNED in
 * `exitR,exitV` (== the orbit `launchShip` snapped to before this round). The interior
 * arc is a precomputed spline (sampled from the gravity-turn budget integrator at commit)
 * reconstructed in the launch plane (`planeBasis(r0,v0)`); read-time interpolation makes
 * it exact at any time-warp (chunk-invariant) and golden-hash-neutral (optional, absent
 * from the golden scenario). Cleared at `tEnd` by the `launch-arrive` finalize. */
export interface LaunchLeg {
  bodyId: string;
  tStart: number; // s since J2000 — liftoff
  tEnd: number; // s — tStart + ascentBudget.burnTime
  r0: Vec3; // body-relative liftoff position (m)
  v0: Vec3; // body-relative liftoff velocity (m/s, surface co-rotation)
  samples: PoweredSample[]; // ascent spline, t relative to tStart
  exitR: Vec3; // pinned parking-orbit position at tEnd (m)
  exitV: Vec3; // pinned parking-orbit velocity at tEnd (m/s)
}

/**
 * An in-progress in-sim powered DESCENT from a parking orbit to a surface site. AIRLESS
 * bodies only — atmospheric arrivals fly the drag pass (`EntryLeg`/`flyEntry`) instead, so
 * this never duplicates the entry-heating physics. The spline is the ascent spline reversed
 * in time (a powered landing is the kinematic mirror of a powered ascent). The touchdown site
 * is PINNED in `exitR,exitV` (== the site `landShip` snapped to before this round). Cleared
 * at `tEnd` by the `land-arrive` finalize. */
export interface DescentLeg {
  bodyId: string;
  tStart: number; // s since J2000 — start of the powered descent
  tEnd: number; // s — tStart + descentBudget.burnTime
  r0: Vec3; // body-relative orbital position at start (m)
  v0: Vec3; // body-relative orbital velocity at start (m/s)
  samples: PoweredSample[]; // descent spline (time-reversed ascent), t relative to tStart
  exitR: Vec3; // pinned landed-site position at tEnd (m)
  exitV: Vec3; // pinned landed-site velocity at tEnd (m/s, surface co-rotation)
}

/**
 * An in-progress in-sim J2-perturbed PLANETARY APPROACH — the inbound hyperbolic arc
 * from SOI entry to periapsis at an OBLATE body, integrated under the body's J2 zonal
 * term referenced to its spin pole (see maneuver/approach.ts). Unlike a spherical
 * arrival (a pure-Kepler conic the sim coasts), an oblate giant bends the pass enough
 * to move the periapsis a capture targets by hundreds of km, in a way the secular J2
 * model (bound-only, zero on a hyperbola) cannot express — so the arc is integrated
 * ONCE at SOI entry and carried as a read-time leg (the LaunchLeg/EntryLeg pattern): a
 * 3D sample spline plus the pinned periapsis state `exitR,exitV` the capture fires at.
 * Read-time interpolation is exact at any time-warp (chunk-invariant); the field is
 * optional (absent from a spherical-body arrival and the golden scenario until wired).
 * Cleared at capture. */
export interface ApproachLeg {
  bodyId: string;
  tStart: number; // s since J2000 — SOI entry
  tEnd: number; // s — periapsis (closest approach), where capture fires
  r0: Vec3; // body-relative state at SOI entry (m)
  v0: Vec3; // body-relative velocity at SOI entry (m/s)
  samples: { t: number; r: Vec3; v: Vec3 }[]; // J2-perturbed arc; t relative to tStart
  exitR: Vec3; // body-relative periapsis position (m) — the capture point
  exitV: Vec3; // body-relative periapsis velocity (m/s)
}

/** The five Lagrange points of a (primary, secondary) pair, keyed off the secondary body. */
export type LagrangePoint = "L1" | "L2" | "L3" | "L4" | "L5";

/**
 * A non-default arrival SHAPE for a transfer. Absent ⇒ today's behaviour (a low circular
 * capture, or the `captureApoAlt` ellipse / `aeroPeriAlt` aerocapture). Present ⇒ the
 * arrival establishes a specific bound orbit or station instead:
 *  - `synchronous`: a circular orbit at the target's synchronous (geostationary) radius —
 *    a remote capture (Mars areostationary), or, when the target IS the ship's own primary,
 *    an in-SOI Hohmann raise from the current orbit (Earth LEO → GEO).
 *  - `lagrange`: a station at an L-point of the (targetId.parent, targetId) pair — reached
 *    by a Lambert leg in the cruise frame (heliocentric for Sun–Earth, geocentric `central`
 *    for Earth–Moon) and held by a velocity match (no gravity well, no Oberth).
 * Plain serializable data; absent from a default transfer ⇒ hash-neutral, like the other
 * optional ShipTransfer fields.
 */
export type ArrivalOrbit =
  | { kind: "synchronous" }
  | { kind: "lagrange"; point: LagrangePoint };

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
  /** A non-default arrival shape (synchronous/GEO orbit or a Lagrange-point station). When set
   *  it overrides the default capture: see `ArrivalOrbit`. Absent ⇒ today's capture behaviour. */
  arrival?: ArrivalOrbit;
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
  /**
   * Secular atmospheric-drag decay for a coasting orbit (rung-1 model): a CONSTANT
   * rate of change of mean motion, ṅ (rad/s²), captured once from the orbit's source
   * (a TLE's first time-derivative of mean motion). `coastElements` applies it in
   * closed form — an along-track advance (½·ṅ·dt²) plus the consistent semi-major-axis
   * decay (n²a³ = μ) — so it stays exact at any time-warp, needing no integration.
   * Present only on satellites ingested from a TLE; absent ⇒ a drag-free conic.
   * When `stationKept` is set the decay is SUPPRESSED in `coastElements` (the orbit
   * is actively maintained), but the rate is still recorded here — it is the natural
   * (un-countered) decay, i.e. the basis for sizing real station-keeping Δv.
   *
   * NEXT STEP — rung 2 (not yet built): replace the constant ṅ with an altitude- and
   * space-weather-dependent rate — a King-Hele averaged-element decay from an
   * exponential/Harris-Priester atmosphere ρ(a), scaled by the object's ballistic
   * coefficient (recoverable from the TLE's B*) and modulated by solar flux (F10.7)
   * and the geomagnetic index. That captures the decay RUNAWAY as perigee drops and
   * gives a physical home for solar-activity fluctuation, at the cost of a cheap
   * per-orbit integration (this constant-rate model needs none).
   */
  drag?: { nDot: number };
  /**
   * The orbit is actively STATION-KEPT: its altitude is held against drag. The
   * engine models the corrective burns IMPLICITLY — `coastElements` simply skips
   * the `drag` secular decay — so a maintained object holds its orbit instead of
   * spiralling in (or, for a negative ṅ, ballooning out) when warped far past the
   * element-set epoch. Used for ingested real satellites, which are maintained in
   * reality. (J2 precession is NOT suppressed — station-keeping fights drag, not
   * the oblateness nodal drift, which sun-synchronous orbits actively rely on.)
   *
   * NOTE: this is the FREE, no-propellant model appropriate for catalog satellites.
   * Player-built ships that eventually experience drag should instead pay real Δv
   * for station-keeping (sized from `drag.nDot`) — see ROADMAP.
   */
  stationKept?: boolean;
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
  /** An in-progress in-sim powered ascent to a parking orbit (visual; cleared at tEnd).
   *  Mutually exclusive with `landed`/`elements` — the leg owns the ship's state until
   *  the `launch-arrive` finalize sets the parking orbit. */
  launchLeg?: LaunchLeg;
  /** An in-progress in-sim powered descent to a surface site (airless bodies; visual;
   *  cleared at tEnd). Mutually exclusive with `landed` — the leg owns the ship's state
   *  until the `land-arrive` finalize marks it landed. */
  descentLeg?: DescentLeg;
  /** An in-progress in-sim J2-perturbed approach to an OBLATE body's periapsis (the
   *  inbound hyperbola integrated under J2; the leg owns the ship's state from SOI entry
   *  until the capture finalize). Absent at a spherical body — that arrival stays a
   *  pure-Kepler coast. */
  approachLeg?: ApproachLeg;
  /** Set when the ship has touched down on a body's surface (after paying the
   *  descent Δv). `surfaceDir` is the landing site as a BODY-FIXED unit vector, so
   *  the ship co-rotates with the surface (moving at surface speed, not orbital
   *  speed). Drives the UI (offer Launch, not Land) and the "safe touchdown is
   *  implicit" semantics. Cleared on launch. */
  landed?: { bodyId: string; surfaceDir: Vec3 };
  /** Accumulated proper time (s). Equal to coordinate time in-system; kept so an
   *  eventual relativistic expansion stays consistent. */
  tau: number;
  /** Set when the ship has been destroyed (flew its orbit into a body's surface).
   *  A lost ship is frozen as a wreck at the impact site (stored in `landed`); the
   *  UI shows CONTACT LOST and offers only deletion. Absent ⇒ the ship is active. */
  status?: "lost";
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

/**
 * The orbital goal a CLOSED-LOOP burn command carries. At delivery the ship
 * trims its Δv MAGNITUDE (the player still picks `dir`) so the resulting
 * osculating conic meets this goal — within the command's correction budget.
 * Radii are measured about the ship's primary at delivery (SI metres); the UI
 * converts an altitude to a radius using that primary's surface radius.
 */
export type BurnGoal =
  | { kind: "periapsis"; rTarget: number } // target periapsis radius (m)
  | { kind: "apoapsis"; rTarget: number } // target apoapsis radius (m)
  | { kind: "circular" } // circularize at the delivery radius
  | { kind: "sma"; aTarget: number }; // target semi-major axis (m)

/**
 * A command a control node sends to a ship (delivered at light-lag).
 *
 * Open-loop (no `goal`): `dv` is the exact engine Δv to deliver — today's
 * behavior, the cheap default. The burn fires that magnitude against whatever
 * live state the ship occupies at delivery (it may land mis-sized: the light-lag
 * bargain).
 *
 * Closed-loop (`goal` present): `dv` is reinterpreted as the correction CAP — the
 * most the ship may spend trimming to hit `goal`. `goalPrimary` is the primary
 * the goal's radii are measured about; if the ship has since crossed into a
 * different SOI the order is refused (NACK).
 */
export type ShipCommand = {
  type: "burn";
  dv: number;
  dir: BurnDir;
  goal?: BurnGoal;
  goalPrimary?: string;
};

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
