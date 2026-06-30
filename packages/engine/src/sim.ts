/**
 * The simulation orchestrator — the spine.
 *
 * Owns the world, the event queue, and the time-warp state. Each render frame
 * the app calls advanceReal(dtReal); the sim converts that to sim-seconds via
 * the current warp and advances the world.
 *
 * Two regimes:
 *  - Nothing thrusting → bodies and ships are analytic functions of t, so the
 *    clock simply jumps to the target (exact at any warp).
 *  - Something thrusting → we sub-step on a FIXED ABSOLUTE-TIME GRID that CAPS the
 *    RK4 step (bounding truncation error), and the warp is clamped ("time slows
 *    near burns"). Within a sub-step, the discrete burn events — reaching the
 *    target Δv and a tank running dry — are detected analytically and the
 *    integration is split EXACTLY at them, so the engine never overshoots the
 *    commanded Δv and a stage transition never leaves a thrust gap or burns
 *    phantom propellant. The analytic quantities (propellant, delivered Δv, event
 *    times) are exactly chunk-invariant — step(A) then step(B) == step(A+B), which
 *    is what save/load determinism relies on; the RK4-integrated r,v differ across
 *    chunkings only by the per-step truncation (~sub-metre, see serialize.ts).
 */

import { type WorldState, type Ship, type ShipBurn, type ShipCommand, type BurnDir, type BurnGoal, type StationKeep, type LagrangePoint } from "./world.ts";
import { EventQueue, WARP_LEVELS, type SimEvent } from "./time.ts";
import { rk4 } from "./math/integrators.ts";
import { orbitFrame, hyperbolicBurnDv, periapsisRadius, soiRadius, visVivaSpeed, j2Rates, synchronousRadius, combinedPlaneChangeDv, inclinationToEquator, spinPole } from "./orbit.ts";
import {
  activeStage, applyImpulsiveDv, dvRemaining, primaryMu, shipOsculatingElements, shipRelativeState, shipWorldState,
  interstellarProperTime, spiralElements, buildEntryLeg, buildApproachLeg, buildPerturbedLeg, inertialDirToSurface, NOMINAL_ENTRY_VEHICLE,
} from "./ships.ts";
import { selectPerturbers, type Perturber } from "./perturbed.ts";
import { exhaustVelocity, thrustAt, lorentzFactor, boosterCount, type Stage, type Booster } from "./propulsion.ts";
import { properToCoordinateAccel } from "./math/relativity.ts";
import { type KeplerElements, type State, stateToElements, elementsToState, propagate, meanMotion, wrapPi, wrapTwoPi } from "./math/kepler.ts";
import { bodyState, bodyElements, bodyStateRelative } from "./ephemeris.ts";
import { signalArrival } from "./comms.ts";
import { aimArrival, aimMoonArrival } from "./maneuver/arrival.ts";
import { searchMoonWindow, moonLooseApoAlt, outboundClearsParent } from "./maneuver/moon.ts";
import { lambert } from "./maneuver/lambert.ts";
import { lagrangeState, lagrangeStateRelative } from "./maneuver/lagrange.ts";
import { flybyManeuver } from "./maneuver/assist.ts";
import { impactParameter } from "./maneuver/flyby.ts";
import { entryInterfaceAlt, entryInterfaceCrossing } from "./maneuver/entry.ts";
import { solveBurnMagnitude } from "./maneuver/guidance.ts";
import { type BodyDef, BODY_BY_ID, MU_SUN, DEFAULT_CAPTURE_ALT, j2RefRadius } from "./constants.ts";
import { type Vec3, add, sub, scale, normalize, length, cross, dot, addScaled } from "./math/vec3.ts";

/** Sub-step grid spacing during powered flight (s). LEO period is ~5500 s, so a
 *  2 s grid keeps RK4 trajectory error negligible. */
const MAX_THRUST_STEP = 2;
/** Max rapidity (m/s) a single thrust segment may deliver. Caps the segment when a
 *  burn is violently relativistic so γ varies little across it — bounding both the
 *  frozen-γ proper↔coordinate conversion error and any superluminal RK4 sub-step.
 *  ≈0.003c; a no-op sub-relativistically (a 2 s segment then gains far less). */
const MAX_SEG_RAPIDITY = 1e6;
/** While any ship is thrusting, the warp is capped so burns stay watchable and
 *  the sub-step count per frame stays bounded. */
const THRUST_WARP_CAP = 60;
/** Bounded horizon (s) of a single flown perturbed-coast chunk. A perturbed-fidelity
 *  ship is flown as SUCCESSIVE legs of this length, each re-osculating and re-arming the
 *  next, so any one stored spline stays bounded. */
const PERTURBED_LEG_HORIZON = 30 * 86400; // 30 days
/** When auto-selecting perturbers for a flown leg, drop bodies whose peak differential
 *  acceleration is below this fraction of the central pull — keeps the integrated set
 *  small (e.g. Moon+Sun at GEO, not every planet) without losing the dominant terms. */
const PERTURBED_SELECT_THRESHOLD = 1e-5;
/** Default station-keeping correction cadence (the perturbed-leg horizon while holding).
 *  Shorter than the free-drift horizon: a tighter deadband corrects more often, so the
 *  drift per window — and the Δv it costs — stays small for an unstable point. */
const STATIONKEEP_WINDOW = 7 * 86400; // 7 days

/** Replace a Map's contents in place (keeps the same Map instance). */
function copyMap<V>(dst: Map<string, V>, src: Map<string, V>): void {
  dst.clear();
  for (const [k, v] of src) dst.set(k, v);
}

export class Simulation {
  readonly world: WorldState;
  readonly events = new EventQueue();
  warpIndex = 0;
  paused = false;
  /**
   * How remote commands are delivered.
   *  - "binding" (default): a command propagates at c and resolves against the
   *    ship's LIVE state at delivery, NACKing if it can't execute — the strategy
   *    game's light-lag bargain (see sendCommand).
   *  - "informative": the command applies IMMEDIATELY and the light delay is only
   *    a readout, never enforced — the sandbox (see applyCommandNow).
   * The engine ships "binding" so every existing test and the strategy game are
   * unchanged; an app opts into "informative".
   */
  commandPolicy: "binding" | "informative" = "binding";
  /**
   * Preview fidelity for analysis overlays (the "high-fidelity planning" tier of the
   * fidelity ladder — see `perturbed.ts` / `trajectory.ts perturbedForecast`).
   *  - "game" (default): the game layer shows only the two-body + secular-J2 forecast.
   *  - "perturbed": the game layer additionally computes/draws the continuous
   *    third-body perturbed forecast and its divergence readout.
   * This is NON-SERIALIZED config (like `commandPolicy`) — it changes nothing in
   * `WorldState`, so it can never move the golden hash. It governs PREVIEW only;
   * whether a ship is actually FLOWN perturbed is the per-ship `Ship.fidelity` opt-in.
   */
  planningFidelity: "game" | "perturbed" = "game";
  private msgCounter = 0;

  constructor(world: WorldState) {
    this.world = world;
    // Re-seed the message-id counter past any ids already present (e.g. a world
    // restored from a save), so a reconstructed sim never re-mints a live id and
    // mis-delivers via deliverMessage's id lookup.
    for (const m of world.messages) {
      const n = Number(m.id.replace(/^msg-/, ""));
      if (Number.isFinite(n) && n >= this.msgCounter) this.msgCounter = n + 1;
    }
  }

  /**
   * Replace this simulation's entire state IN PLACE — same `world`/`events`
   * object identity, so every renderer/UI reference stays valid. This is the live
   * save-restore / replay-scrub path (the constructor builds a fresh sim from a
   * world). Re-seeds the message-id counter from the restored messages, exactly as
   * the constructor does, so a later sendCommand can't re-mint a live id.
   */
  loadState(world: WorldState, events: SimEvent[], warpIndex = this.warpIndex): void {
    const w = this.world;
    w.t = world.t;
    w.seed = world.seed;
    w.controlNode = world.controlNode;
    copyMap(w.ships, world.ships);
    copyMap(w.stations, world.stations);
    copyMap(w.maneuvers, world.maneuvers);
    w.messages.length = 0;
    w.messages.push(...world.messages);
    this.events.load(events);
    this.warpIndex = warpIndex;
    this.msgCounter = 0;
    for (const m of w.messages) {
      const n = Number(m.id.replace(/^msg-/, ""));
      if (Number.isFinite(n) && n >= this.msgCounter) this.msgCounter = n + 1;
    }
  }

  get warp(): number {
    return WARP_LEVELS[this.warpIndex]!.factor;
  }

  get warpLabel(): string {
    return WARP_LEVELS[this.warpIndex]!.label;
  }

  setWarpIndex(i: number): void {
    this.warpIndex = Math.max(0, Math.min(WARP_LEVELS.length - 1, i));
  }

  cycleWarp(dir: 1 | -1): void {
    this.setWarpIndex(this.warpIndex + dir);
  }

  togglePause(): void {
    this.paused = !this.paused;
  }

  /**
   * Leap the clock forward to absolute time `t` (e.g. "warp to just before a
   * scheduled departure"). Coasting is analytic, so the jump is exact and cheap —
   * scheduled events along the way (other ships' captures, message arrivals) still
   * fire in order. It refuses while anything is thrusting: an active burn must be
   * sub-stepped at the warp cap, never skipped, so a far-off burn blocks the jump
   * until it ends. A no-op when `t` is not in the future.
   */
  jumpToTime(t: number): void {
    if (t <= this.world.t || this.anyThrust()) return;
    this.step(t - this.world.t);
  }

  anyThrust(): boolean {
    for (const s of this.world.ships.values()) if (s.mode === "thrust") return true;
    return false;
  }

  /** Advance the world by a real elapsed wall-clock interval (seconds). */
  advanceReal(dtReal: number): void {
    if (this.paused || dtReal <= 0) return;
    // Cap a single frame's real dt: a backgrounded/stalled tab should resume
    // smoothly, not teleport the clock. The forfeited time is not replayed.
    const clampedReal = Math.min(dtReal, 0.1);
    let warp = this.warp;
    if (this.anyThrust()) warp = Math.min(warp, THRUST_WARP_CAP);
    this.step(clampedReal * warp);
  }

  /** Advance sim time by dtSim seconds, firing events in order along the way. */
  step(dtSim: number): void {
    if (dtSim <= 0) return;

    // Proper time advances with coordinate time for every ship (τ ≡ t in-system,
    // where γ−1 ~ 1e-10 at orbital speeds). A ship on an interstellar leg ages by
    // the DILATED proper time over the part of [t, t+dt] that overlaps the leg, and
    // by coordinate time outside it — the relativistic divergence the τ field was
    // always kept for; this telescopes exactly across chunkings (a difference of an
    // analytic function). A ship on a relativistic in-system BURN is seeded the
    // coordinate interval here and then has the dilation deficit refunded per thrust
    // segment in advanceThrustShip (γ_seg is known there), so its crew clock dilates
    // too — a no-op to f64 for the sub-relativistic burns every preset ship flies.
    const T0 = this.world.t, T1 = this.world.t + dtSim;
    for (const s of this.world.ships.values()) {
      const leg = s.interstellarLeg;
      if (leg) {
        const aStart = Math.max(T0, leg.tDepart);
        const aEnd = Math.min(T1, leg.tArrive);
        if (aEnd > aStart) {
          const dtau = interstellarProperTime(leg, aEnd) - interstellarProperTime(leg, aStart);
          s.tau += dtau + (aStart - T0) + (T1 - aEnd); // proper over the leg, coordinate outside
          continue;
        }
      }
      s.tau += dtSim;
    }

    const target = this.world.t + dtSim;

    // Advance in segments bounded by the next scheduled event — and, while
    // anything is thrusting, by a fixed absolute-time sub-step grid. Re-checking
    // thrust after each event means a command delivered mid-interval (a burn
    // order arriving at light-lag) is integrated correctly, with no skipped arc.
    let guard = 0;
    while (this.world.t < target - 1e-9 && guard++ < 5_000_000) {
      const nextEvent = this.events.nextTime();
      if (this.anyThrust()) {
        const gridNext = (Math.floor(this.world.t / MAX_THRUST_STEP) + 1) * MAX_THRUST_STEP;
        const segEnd = Math.min(gridNext, target, nextEvent);
        const t0 = this.world.t;
        const dt = segEnd - t0;
        if (dt > 0) {
          for (const ship of this.world.ships.values()) {
            if (ship.mode === "thrust") this.advanceThrustShip(ship, t0, dt);
          }
        }
        this.world.t = segEnd;
      } else {
        // Coasting: bodies and ships are analytic — jump straight to the next event,
        // but stop at the earliest impending surface impact so a ship is destroyed
        // exactly when (and where) its orbit first meets the surface. impactTime is a
        // pure function of the ship's (time-invariant) conic, so the crash fires at a
        // deterministic absolute t regardless of how the interval was chunked.
        let stop = Math.min(target, nextEvent);
        let crasher: Ship | undefined;
        for (const ship of this.world.ships.values()) {
          const tImpact = this.impactTime(ship);
          if (tImpact !== null && tImpact <= stop) { stop = tImpact; crasher = ship; }
        }
        this.world.t = stop;
        if (crasher) this.crashShip(crasher, stop);
      }
      this.drainEvents(this.world.t);
    }
    this.world.t = target;
  }

  private drainEvents(tMax: number): void {
    for (;;) {
      const ev = this.events.popDue(tMax);
      if (!ev) break;
      this.world.t = ev.t;
      this.handleEvent(ev);
    }
  }

  /**
   * Integrate one ship under gravity + thrust across [t0, t0+dt], splitting the
   * interval EXACTLY at each discrete event (target Δv reached, or active tank
   * empty). Within each smooth segment thrust is continuous, so RK4 keeps its
   * full order; the rocket-equation quantities (propellant, delivered Δv) are
   * advanced analytically so they land precisely on the event.
   *
   * Dynamics are integrated in the primary-centred frame, which is treated as
   * inertial (a patched-conic approximation: the omitted solar tidal term across
   * LEO is ~1e-7 of Earth's central gravity, far below relevance for a burn).
   *
   * The integration is special-relativistic: thrust and gravity are flat-space
   * proper-frame forces, and `properToCoordinateAccel` converts the specific force
   * to the coordinate 3-acceleration so velocity composes as a rapidity (capped
   * below c) rather than linearly. Propellant burns at a constant PROPER-time rate
   * (the engine operates in its own frame), and `burn.dvDone`/`dvTarget` are an
   * accumulated/target RAPIDITY (`ve·ln(m₀/m_f)` = what the rocket equation
   * delivers). All of this reduces to the Newtonian integrator at the
   * sub-relativistic speeds every preset ship flies (γ−1 ~ 3e-10 in LEO, so to
   * ~1e-9 relative — exactly only at v = 0); the relativistic regime is a torchship
   * doing a powered in-system burn.
   */
  private advanceThrustShip(ship: Ship, t0: number, dt: number): void {
    let elapsed = 0;
    while (elapsed < dt - 1e-12 && ship.mode === "thrust") {
      const burn = ship.burn;
      const stage = activeStage(ship);
      if (!burn || !stage || !ship.r || !ship.v) {
        this.endBurn(ship, t0 + elapsed);
        return;
      }

      // ── Parallel staging ────────────────────────────────────────────────────
      // While the active stage has live strap-on boosters, core and boosters burn
      // CONCURRENTLY: total thrust F = ΣFᵢ, total flow ṁ = Σṁᵢ, and the segment
      // advances on the engines' thrust-weighted vₑ_eff = F/ṁ. Each reservoir
      // drains at its own ṁᵢ; a booster group drops (spliced from the array) the
      // instant it empties. The core's dry mass is carried until the whole stage
      // is spent (`activeStage += 1`), exactly as for serial staging. The moment
      // the last booster is gone with the core still fuelled, the array empties and
      // the loop falls through to the serial path below — so non-boostered burns
      // (and the golden scenario) never touch this branch.
      const boosters = stage.boosters;
      if (boosters && boosters.length > 0) {
        const res = this.advanceBoosteredSegment(ship, burn, stage, boosters, t0, dt, elapsed);
        if (res.ended) return;
        elapsed = res.elapsed;
        continue;
      }

      const mu = BODY_BY_ID.get(ship.primary)!.mu;
      const ve = exhaustVelocity(stage.isp);
      // Thrust at the ship's heliocentric distance: a solar-electric stage is
      // power-limited and derates as 1/r² from the Sun (thrustAt is a no-op for
      // chemical stages, so chemical burns are unchanged). Evaluated at the segment
      // start and held constant across the ≤2 s segment, so ṁ stays constant and
      // the analytic event split below remains exact per segment.
      const primaryPos = bodyState(BODY_BY_ID.get(ship.primary)!, t0 + elapsed).r;
      const thrust = thrustAt(stage, length(add(primaryPos, ship.r)));
      const mdot = thrust / ve;

      // Mass carried but not part of the active tank: payload + active dry +
      // every upper stage (dry + propellant). m0 is the mass at segment start.
      let carried = ship.payloadMass + stage.dryMass;
      for (let i = ship.activeStage + 1; i < ship.stages.length; i++) {
        const up = ship.stages[i]!;
        carried += up.dryMass + up.propMass;
      }
      const m0 = carried + stage.propMass;

      const dvRem = burn.dvTarget - burn.dvDone; // rapidity remaining
      if (dvRem <= 1e-9) {
        this.endBurn(ship, t0 + elapsed);
        return;
      }

      // The engine burns propellant and gains rapidity at a constant PROPER-time
      // rate, so the event times below are solved in proper time τ (the exact
      // classical formulas, now in τ) and converted to coordinate time by the
      // segment-start Lorentz factor γ_seg, held constant across the segment. That
      // freeze is only first-order in the per-segment β change, so the segment is
      // additionally capped (tauStep) to a small rapidity gain — keeping γ ≈ const
      // across it. At v ≪ c, γ_seg = 1, τ = coordinate time, and the cap never binds,
      // recovering the classical split exactly.
      const gammaSeg = lorentzFactor(length(ship.v));
      const tauCut = (m0 / mdot) * (1 - Math.exp(-dvRem / ve)); // proper time to target rapidity
      const tauEmpty = stage.propMass / mdot; // proper time to empty tank
      const tauStep = (m0 / mdot) * (1 - Math.exp(-MAX_SEG_RAPIDITY / ve)); // γ-fidelity cap
      let segTau = (dt - elapsed) / gammaSeg; // available proper time this interval
      let event: "none" | "cut" | "empty" = "none";
      if (tauStep < segTau) { segTau = tauStep; event = "none"; } // soft cap (no event)
      if (tauCut < segTau) { segTau = tauCut; event = "cut"; }
      if (tauEmpty < segTau) { segTau = tauEmpty; event = "empty"; }
      const seg = segTau * gammaSeg; // coordinate-time length of the segment

      // Crew ages by PROPER time over the burn, not coordinate time. step()'s
      // pre-loop already credited this ship the full coordinate interval (part of
      // dtSim); refund the dilation deficit (segTau − seg ≤ 0) so τ accrues the
      // dilated proper time during a relativistic in-system burn. A no-op to f64 at
      // sub-relativistic speed (γ_seg = 1 ⇒ segTau = seg), so the classical golden
      // path — and every preset ship — is byte-unchanged.
      ship.tau += segTau - seg;

      // Integrate r,v over the smooth segment (thrust always on — no toggling).
      const dirFor = (r: Vec3, v: Vec3): Vec3 => {
        const f = orbitFrame(r, v);
        switch (burn.dir) {
          case "prograde": return f.prograde;
          case "retrograde": return f.retrograde;
          case "radial-out": return f.radialOut;
          case "radial-in": return f.radialIn;
          case "normal": return f.normal;
          case "antinormal": return f.antinormal;
        }
      };
      const deriv = (_t: number, y: number[]): number[] => {
        const r: Vec3 = { x: y[0]!, y: y[1]!, z: y[2]! };
        const v: Vec3 = { x: y[3]!, y: y[4]!, z: y[5]! };
        const prop = y[6]!;
        const m = Math.max(carried + Math.max(prop, 0), 1e-9); // floor: never divide by 0 mass
        const rmag = Math.max(Math.hypot(r.x, r.y, r.z), 1); // floor: never divide by 0 radius
        const gfac = -mu / (rmag * rmag * rmag);
        const dir = dirFor(r, v);
        const at = thrust / m;
        // Specific force = thrust (a genuine proper/rest-frame engine push) +
        // Newtonian gravity, both run through the proper→coordinate SR transform.
        // Treating gravity as a proper-frame force is an approximation, but it is
        // exact at γ = 1 (where gravity matters, in the well) and negligible at
        // relativistic β (where the ship is far out and gravity ≈ 0), so the seam
        // is harmless. Reduces to gravity + thrust/m at v ≪ c; caps |v| below c.
        const aProper: Vec3 = {
          x: dir.x * at + r.x * gfac,
          y: dir.y * at + r.y * gfac,
          z: dir.z * at + r.z * gfac,
        };
        const a = properToCoordinateAccel(v, aProper);
        // Propellant burns at a constant proper-time rate ṁ; in coordinate time that
        // is ṁ/γ. This rate IS the propellant ledger — the integrated y[6] below is
        // read back as the consumed mass — and is exactly −ṁ at v ≪ c.
        const gv = lorentzFactor(Math.hypot(v.x, v.y, v.z));
        return [
          v.x, v.y, v.z,
          a.x, a.y, a.z,
          -mdot / gv,
        ];
      };

      const y0 = [ship.r.x, ship.r.y, ship.r.z, ship.v.x, ship.v.y, ship.v.z, stage.propMass];
      const r0: Vec3 = { x: ship.r.x, y: ship.r.y, z: ship.r.z };
      const v0: Vec3 = { x: ship.v.x, y: ship.v.y, z: ship.v.z };
      const y1 = rk4(y0, t0 + elapsed, seg, deriv);
      ship.r = { x: y1[0]!, y: y1[1]!, z: y1[2]! };
      ship.v = { x: y1[3]!, y: y1[4]!, z: y1[5]! };

      // Flew into the primary mid-burn? Freeze the wreck and stop.
      if (this.poweredImpact(ship, r0, v0, ship.r, ship.v, t0 + elapsed + seg)) return;

      // Propellant comes from the RK4 itself (rate −ṁ/γ): the consumed mass is the
      // integral ∫ṁ/γ dt = ṁ·Δτ_true, exact to truncation and — crucially —
      // split-invariant (an integral does not care how the interval is chunked), so
      // the rapidity ledger telescopes and the burn stays chunk-invariant. Delivered
      // rapidity over the segment is ve·ln(m_before/m_after) (dφ = −ve·dm/m), which
      // is the engine's frame-invariant Δv currency. At v ≪ c (γ → 1) the rate is
      // −ṁ, the integral is exact and linear, and both lines reduce to the classical
      // Tsiolkovsky bookkeeping (γ−1 ~ 3e-10 in LEO).
      const mAfter = Math.max(carried + Math.max(y1[6]!, 0), 1e-9); // floor: never log(m0/0)
      stage.propMass = Math.max(y1[6]!, 0);
      burn.dvDone += ve * Math.log(m0 / mAfter);
      elapsed += seg;

      if (event === "cut") {
        burn.dvDone = burn.dvTarget; // kill rounding; the analytic step lands here
        this.endBurn(ship, t0 + elapsed);
        return;
      }
      if (event === "empty") {
        stage.propMass = 0;
        ship.activeStage += 1;
        if (!activeStage(ship)) {
          this.endBurn(ship, t0 + elapsed); // out of propellant
          return;
        }
        // Next stage ignites for the remainder of dt on the next loop iteration.
      }
    }
    // Still thrusting after the full interval: r,v are valid at t0+dt; stamp the
    // epoch so shipRelativeState can extrapolate the ship's position mid-burn.
    if (ship.mode === "thrust") ship.epoch = t0 + dt;
  }

  /**
   * One powered sub-segment of a stage burning WITH live strap-on boosters
   * (parallel staging). Generalizes a single `advanceThrustShip` segment to N
   * concurrent reservoirs: the core plus each booster group, each draining at its
   * own proper-time flow ṁᵢ. The segment is split EXACTLY at the soonest of the
   * target Δv (`cut`), any reservoir running dry (`empty`), or the γ-fidelity cap
   * — the same analytic split the serial path uses, so the burn stays
   * chunk-invariant. The vehicle gains rapidity at the thrust-weighted
   * vₑ_eff = F/ṁ; there is exactly ONE rapidity ledger (`burn.dvDone`), never a
   * per-engine one. Returns the elapsed time and whether the burn ended.
   */
  private advanceBoosteredSegment(
    ship: Ship, burn: ShipBurn, stage: Stage, boosters: Booster[], t0: number, dt: number, elapsed0: number,
  ): { elapsed: number; ended: boolean } {
    let elapsed = elapsed0;
    const r0 = ship.r!, v0 = ship.v!;
    const primaryBody = BODY_BY_ID.get(ship.primary)!;
    const mu = primaryBody.mu;

    const dvRem = burn.dvTarget - burn.dvDone; // rapidity remaining
    if (dvRem <= 1e-9) { this.endBurn(ship, t0 + elapsed); return { elapsed, ended: true }; }

    // Live burning reservoirs this segment (fixed across it; a drop ENDS the
    // segment). `idx === -1` is the core; `idx >= 0` indexes `boosters`. Booster
    // figures are count-aggregated (N identical units ignite and drop together).
    interface Burner { idx: number; thrust: number; ve: number; mdot: number; prop: number; tEmpty: number; }
    const primaryPos = bodyState(primaryBody, t0 + elapsed).r;
    const dist = length(add(primaryPos, r0));
    // `carried` = everything NOT a burning reservoir's propellant: payload + core
    // dry (held while the stage is active) + every booster group's dry + all upper
    // stages (their own dry + propellant + any of their boosters). A reservoir with
    // vₑ ≤ 0 (Isp ≤ 0) or thrust ≤ 0 is INERT — its propellant is carried as ballast
    // rather than producing Infinity/NaN mass flow (defends degenerate designs).
    const burners: Burner[] = [];
    let carried = ship.payloadMass + stage.dryMass;
    const veC = exhaustVelocity(stage.isp);
    const fC = thrustAt(stage, dist); // chemical core: no-op; electric core: derated
    if (stage.propMass > 1e-9 && veC > 0 && fC > 0) {
      const mdotC = fC / veC;
      burners.push({ idx: -1, thrust: fC, ve: veC, mdot: mdotC, prop: stage.propMass, tEmpty: stage.propMass / mdotC });
    } else {
      carried += stage.propMass; // spent/inert core propellant rides as ballast
    }
    boosters.forEach((b, i) => {
      const n = boosterCount(b);
      carried += b.dryMass * n; // booster structure always carried
      const prop = b.propMass * n;
      const veB = exhaustVelocity(b.isp);
      const fB = b.thrust * n;
      if (prop > 1e-9 && veB > 0 && fB > 0) {
        const mdotB = fB / veB;
        burners.push({ idx: i, thrust: fB, ve: veB, mdot: mdotB, prop, tEmpty: prop / mdotB });
      } else {
        carried += prop; // inert booster propellant
      }
    });
    for (let i = ship.activeStage + 1; i < ship.stages.length; i++) {
      const up = ship.stages[i]!;
      carried += up.dryMass + up.propMass;
      if (up.boosters) for (const ub of up.boosters) carried += (ub.dryMass + ub.propMass) * boosterCount(ub);
    }
    if (burners.length === 0) {
      // Stage carries no live propellant: advance (mirrors the serial out-of-fuel path).
      stage.propMass = 0;
      ship.activeStage += 1;
      if (!activeStage(ship)) { this.endBurn(ship, t0 + elapsed); return { elapsed, ended: true }; }
      return { elapsed, ended: false };
    }

    const fTotal = burners.reduce((s, br) => s + br.thrust, 0);
    const mdotTotal = burners.reduce((s, br) => s + br.mdot, 0);
    const veEff = fTotal / mdotTotal;
    const m0 = carried + burners.reduce((s, br) => s + br.prop, 0);

    // Event split in proper time τ, converted by the segment-start γ (held across
    // the ≤2 s segment), exactly as the serial path does.
    const gammaSeg = lorentzFactor(length(v0));
    const tauCut = (m0 / mdotTotal) * (1 - Math.exp(-dvRem / veEff)); // reach target rapidity
    const tauStep = (m0 / mdotTotal) * (1 - Math.exp(-MAX_SEG_RAPIDITY / veEff)); // γ-fidelity cap
    const tauEmptyMin = Math.min(...burners.map((br) => br.tEmpty)); // soonest reservoir dry
    let segTau = (dt - elapsed) / gammaSeg;
    let event: "none" | "cut" | "empty" = "none";
    if (tauStep < segTau) { segTau = tauStep; event = "none"; }
    if (tauCut < segTau) { segTau = tauCut; event = "cut"; }
    if (tauEmptyMin < segTau) { segTau = tauEmptyMin; event = "empty"; }
    const seg = segTau * gammaSeg;

    // Crew ages by proper time over the segment (see advanceThrustShip): refund the
    // step() pre-loop's coordinate-time over-count so a relativistic boostered burn
    // dilates τ. No-op to f64 sub-relativistically (γ_seg = 1).
    ship.tau += segTau - seg;

    const dirFor = (r: Vec3, v: Vec3): Vec3 => {
      const f = orbitFrame(r, v);
      switch (burn.dir) {
        case "prograde": return f.prograde;
        case "retrograde": return f.retrograde;
        case "radial-out": return f.radialOut;
        case "radial-in": return f.radialIn;
        case "normal": return f.normal;
        case "antinormal": return f.antinormal;
      }
    };
    // State vector: [r(3), v(3), prop per burner…]. Total thrust drives a = F/m;
    // each reservoir flows −ṁᵢ/γ in coordinate time (its own constant proper rate).
    const deriv = (_t: number, y: number[]): number[] => {
      const r: Vec3 = { x: y[0]!, y: y[1]!, z: y[2]! };
      const v: Vec3 = { x: y[3]!, y: y[4]!, z: y[5]! };
      let propSum = 0;
      for (let i = 0; i < burners.length; i++) propSum += Math.max(y[6 + i]!, 0);
      const m = Math.max(carried + propSum, 1e-9);
      const rmag = Math.max(Math.hypot(r.x, r.y, r.z), 1);
      const gfac = -mu / (rmag * rmag * rmag);
      const dir = dirFor(r, v);
      const at = fTotal / m;
      const aProper: Vec3 = {
        x: dir.x * at + r.x * gfac,
        y: dir.y * at + r.y * gfac,
        z: dir.z * at + r.z * gfac,
      };
      const a = properToCoordinateAccel(v, aProper);
      const gv = lorentzFactor(Math.hypot(v.x, v.y, v.z));
      const out = [v.x, v.y, v.z, a.x, a.y, a.z];
      for (const br of burners) out.push(-br.mdot / gv);
      return out;
    };

    const y0 = [r0.x, r0.y, r0.z, v0.x, v0.y, v0.z, ...burners.map((br) => br.prop)];
    const y1 = rk4(y0, t0 + elapsed, seg, deriv);
    ship.r = { x: y1[0]!, y: y1[1]!, z: y1[2]! };
    ship.v = { x: y1[3]!, y: y1[4]!, z: y1[5]! };

    // Flew into the primary mid-burn (boosters still firing)? Freeze the wreck and stop.
    if (this.poweredImpact(ship, r0, v0, ship.r, ship.v, t0 + elapsed + seg)) {
      return { elapsed, ended: true };
    }

    let propAfterSum = 0;
    for (let i = 0; i < burners.length; i++) {
      const after = Math.max(y1[6 + i]!, 0);
      burners[i]!.prop = after;
      propAfterSum += after;
    }
    const mAfter = Math.max(carried + propAfterSum, 1e-9);
    burn.dvDone += veEff * Math.log(m0 / mAfter); // single vehicle rapidity ledger
    elapsed += seg;

    // Persist integrated propellant back to the reservoirs.
    for (const br of burners) {
      if (br.idx === -1) stage.propMass = br.prop;
      else { const bb = boosters[br.idx]!; bb.propMass = br.prop / boosterCount(bb); }
    }

    if (event === "cut") {
      burn.dvDone = burn.dvTarget; // kill rounding; the analytic step lands here
      this.endBurn(ship, t0 + elapsed);
      return { elapsed, ended: true };
    }
    if (event === "empty") {
      // Zero every reservoir that hit the shared minimum empty time (by its
      // ANALYTIC tEmpty, not the integrated residual — robust to truncation).
      for (const br of burners) {
        if (br.tEmpty <= tauEmptyMin * (1 + 1e-9) + 1e-12) {
          if (br.idx === -1) stage.propMass = 0;
          else boosters[br.idx]!.propMass = 0;
        }
      }
      // Drop spent booster groups (splice high→low so indices stay valid).
      for (let i = boosters.length - 1; i >= 0; i--) {
        if (boosters[i]!.propMass * boosterCount(boosters[i]!) <= 1e-9) boosters.splice(i, 1);
      }
      // Whole stage spent (core dry AND no boosters left) → advance to the next.
      if (stage.propMass <= 1e-9 && boosters.length === 0) {
        stage.propMass = 0;
        ship.activeStage += 1;
        if (!activeStage(ship)) { this.endBurn(ship, t0 + elapsed); return { elapsed, ended: true }; }
      }
    }
    return { elapsed, ended: false };
  }

  /** Finish a burn at the exact event time: freeze the achieved orbit as
   *  osculating elements (valid at `epoch`) and coast. */
  private endBurn(ship: Ship, epoch: number): void {
    if (ship.r && ship.v) {
      const mu = BODY_BY_ID.get(ship.primary)!.mu;
      ship.elements = stateToElements(ship.r, ship.v, mu);
      ship.epoch = epoch;
    }
    ship.mode = "coast";
    ship.burn = undefined;
  }

  // ── Surface impact (a ship flown into a body) ─────────────────────────────

  /**
   * The absolute time a COASTING ship's conic next crosses its primary's surface
   * (r = body.radius) on the way down — or null if it never will (periapsis clears
   * the surface) or the ship isn't a plain coasting orbit. Derived analytically
   * from the osculating conic, so it is exact at any time-warp and chunk-invariant.
   * Legs with their own kinematics (interstellar / spiral / entry / landed) and
   * powered flight are skipped — they own their own terminal handling.
   */
  private impactTime(ship: Ship): number | null {
    if (ship.status === "lost" || ship.mode !== "coast") return null;
    // A perturbed-leg ship is NOT on a single conic, so the analytic periapsis test below
    // is meaningless for it — the leg owns its own state and terminal handling (the
    // perturbed-finalize). (The supported perturbed orbits are high/bound; in-arc surface
    // impact is a documented follow-up.)
    if (ship.landed || ship.interstellarLeg || ship.spiral || ship.entryLeg || ship.perturbedLeg || !ship.elements) return null;
    const body = BODY_BY_ID.get(ship.primary);
    if (!body) return null;
    const R = body.radius;
    const t = this.world.t;
    const el = shipOsculatingElements(ship, t);
    const rp = el.a * (1 - el.e); // periapsis radius (a<0·(1−e)<0 ⇒ >0 for hyperbolae too)
    if (!(rp < R)) return null; // periapsis clears the surface — safe
    const mu = body.mu;
    const rNow = length(shipRelativeState(ship, t).r);
    if (rNow <= R) return t; // already at/under the surface → destroyed now
    // Convert ΔM → Δt at the SAME rate coastElements advances the mean anomaly: the
    // Kepler mean motion PLUS the J2 secular rate (bound orbits only). Using the bare
    // mean motion here would make the impact time depend on the evaluation epoch and
    // break chunk-invariance over a precessing orbit.
    const n = meanMotion(el.a, mu);
    const nEff = body.J2 && el.e < 1 ? n + j2Rates(mu, j2RefRadius(body), body.J2, el.a, el.e, el.i).anomalyDot : n;
    if (el.e < 1) {
      // Eccentric anomaly at r = R; the impact is the DESCENDING crossing (toward
      // periapsis), whose mean anomaly is 2π − M_ascending.
      const cosE = Math.max(-1, Math.min(1, (1 - R / el.a) / el.e));
      const Ecross = Math.acos(cosE);
      const Mdesc = wrapTwoPi(-(Ecross - el.e * Math.sin(Ecross)));
      let dt = (Mdesc - wrapTwoPi(el.M)) / nEff;
      if (dt < 0) dt += (2 * Math.PI) / nEff;
      return t + dt;
    }
    // Hyperbolic: r = R at hyperbolic anomaly F (cosh F = (1 − R/a)/e, a < 0). The
    // inbound crossing is at mean anomaly −M_cross; if already past it the ship has
    // dived through periapsis (below the surface) and is doomed now.
    const coshF = (1 - R / el.a) / el.e;
    if (coshF < 1) return null;
    const F = Math.acosh(coshF);
    const Mcross = el.e * Math.sinh(F) - F;
    const dt = (-Mcross - el.M) / n;
    return dt >= 0 ? t + dt : t;
  }

  /**
   * Surface impact DURING a powered burn. The coasting impact path (`impactTime`)
   * fires only between burns, so a ship thrusting its vector into the primary —
   * a botched powered descent, or a burn aimed inward — would otherwise fly clean
   * through the body and survive until it next coasts. Called after each RK4
   * segment integrates a new `(r1,v1)`: if the segment ended at or below the
   * surface on a DESCENDING crossing, freeze the ship at the impact point and
   * destroy it. A ship climbing out through the surface (a launch) has r·v ≥ 0 and
   * is left alone. The crossing fraction is a LINEAR interpolation of the segment
   * endpoints — the powered regime is RK4-integrated (already not chunk-invariant
   * per docs/physics-audit.md §3.4), so an interpolated wreck site is in keeping
   * with the regime. Returns true if the ship was crashed (caller must stop it).
   */
  private poweredImpact(ship: Ship, r0: Vec3, v0: Vec3, r1: Vec3, v1: Vec3, t1: number): boolean {
    const body = BODY_BY_ID.get(ship.primary);
    if (!body) return false;
    const R = body.radius;
    if (length(r1) > R) return false; // ended above the surface — fine
    if (dot(r1, v1) >= 0) return false; // ascending through R (a launch climbing out) — not a crash
    // Fraction α∈[0,1] along the segment chord where |r0 + α·(r1−r0)| = R, i.e. the
    // first (entering) root of the quadratic A·α² + B·α + C = 0.
    const d = sub(r1, r0);
    const A = dot(d, d);
    const B = 2 * dot(r0, d);
    const C = dot(r0, r0) - R * R;
    let alpha = 1; // default: the whole segment is at/under the surface
    if (A > 1e-9) {
      const disc = B * B - 4 * A * C;
      if (disc >= 0) {
        const r1Root = (-B - Math.sqrt(disc)) / (2 * A);
        const r2Root = (-B + Math.sqrt(disc)) / (2 * A);
        if (r1Root >= 0 && r1Root <= 1) alpha = r1Root;
        else if (r2Root >= 0 && r2Root <= 1) alpha = r2Root;
        else alpha = 0; // started at/under the surface
      }
    }
    // Seat the impact state (still thrust-mode) so crashShip reads the impact point
    // off shipRelativeState (the thrust branch extrapolates from epoch; dt = 0 here).
    ship.r = addScaled(r0, d, alpha);
    ship.v = addScaled(v0, sub(v1, v0), alpha);
    ship.epoch = t1;
    this.crashShip(ship, t1);
    return true;
  }

  /**
   * Destroy a ship that has flown its orbit into a body: freeze it as a wreck at
   * the impact site (co-rotating with the surface, like a landing), mark it lost,
   * cancel any pending legs/orders, drop its scheduled events, and radio a final
   * "signal lost" home. The wreck stays in the world so the player can see where it
   * died and choose to scrap it; the UI offers only deletion from here.
   */
  private crashShip(ship: Ship, t: number): void {
    const body = BODY_BY_ID.get(ship.primary);
    // Capture the impact direction from the live conic BEFORE clearing it.
    let surfaceDir: Vec3 | undefined;
    if (body) {
      const dir = normalize(shipRelativeState(ship, t).r);
      surfaceDir = inertialDirToSurface(body, dir, t); // body-fixed impact site (co-rotates)
    }
    ship.status = "lost";
    ship.mode = "coast";
    ship.burn = undefined;
    ship.transfer = undefined;
    ship.spiral = undefined;
    ship.entryLeg = undefined;
    ship.interstellarLeg = undefined;
    ship.r = undefined;
    ship.v = undefined;
    ship.elements = undefined;
    ship.epoch = t;
    if (body && surfaceDir) ship.landed = { bodyId: body.id, surfaceDir };
    // Drop any other scheduled events for this ship (capture, SOI, …) — the wreck
    // must not still try to fly them.
    this.events.removeByEntity(ship.id);
    this.emitTelemetry(ship, `signal lost: ${ship.name} impacted ${body?.name ?? ship.primary}`);
  }

  /** Event dispatch. */
  private handleEvent(ev: SimEvent): void {
    if (ev.kind === "message-arrival") {
      if (ev.entityId) this.deliverMessage(ev.entityId);
      return;
    }
    const ship = ev.entityId ? this.world.ships.get(ev.entityId) : undefined;
    if (!ship) return;
    switch (ev.kind) {
      case "transfer-depart": this.executeDeparture(ship, ev.t); break;
      case "flyby-pass": this.executeFlyby(ship, ev.t); break;
      case "spiral-arrive": this.arriveSpiral(ship); break;
      case "transfer-arrive": this.arriveTransfer(ship); break;
      case "soi-crossing": this.enterSoi(ship); break;
      case "soi-exit": this.exitSoi(ship); break;
      case "capture": this.captureAtPeriapsis(ship); break;
      case "entry-start": this.beginEntry(ship); break;
      case "entry-end": this.finishEntry(ship); break;
      case "launch-arrive": this.arriveLaunch(ship); break;
      case "land-arrive": this.arriveLand(ship); break;
      case "aero-trim": this.trimAerocapture(ship); break;
      case "perturbed-finalize": this.finalizePerturbed(ship); break;
      default: break;
    }
  }

  // ── Light-lag command & comms ─────────────────────────────────────────────

  /**
   * Send a command to a ship from the control node. The command is NOT applied
   * now — it becomes a signal that propagates at c and is delivered when it
   * reaches the (moving) ship. Returns the delivery time and one-way light delay,
   * or null if the target is unknown. This is the heart of the game: you act on
   * the past and your orders take real time to arrive.
   */
  sendCommand(targetId: string, command: ShipCommand): { tArrive: number; delay: number } | null {
    const ship = this.world.ships.get(targetId);
    const control = BODY_BY_ID.get(this.world.controlNode);
    if (!ship || !control) return null;
    const fromPos = bodyState(control, this.world.t).r;
    const posFn = (t: number): Vec3 => shipWorldState(ship, t).r;
    const tArrive = signalArrival(fromPos, posFn, this.world.t);
    if (!isFinite(tArrive)) return null; // out of contact: light can't catch the ship
    const id = `msg-${this.msgCounter++}`;
    this.world.messages.push({
      id, kind: "command", fromPos, toPos: posFn(tArrive), targetId,
      tEmit: this.world.t, tArrive, label: `${command.type} → ${ship.name}`, command,
    });
    this.events.push({ t: tArrive, kind: "message-arrival", entityId: id });
    return { tArrive, delay: tArrive - this.world.t };
  }

  /**
   * Apply a command IMMEDIATELY — the "informative light-lag" policy. The order
   * takes effect now (resolved against the ship's current state); the returned
   * `delay` is only what a real signal WOULD take to reach the ship, surfaced as a
   * readout and never enforced. No message is put in flight and nothing is queued,
   * so the sandbox stays free of in-flight comms state. The counterpart to
   * sendCommand's binding delivery. Returns the readout delay and whether the
   * command was accepted (affordable / valid), or null if the target or control
   * node is unknown.
   */
  applyCommandNow(targetId: string, command: ShipCommand): { delay: number; applied: boolean } | null {
    const ship = this.world.ships.get(targetId);
    const control = BODY_BY_ID.get(this.world.controlNode);
    if (!ship || !control) return null;
    const fromPos = bodyState(control, this.world.t).r;
    const tArrive = signalArrival(fromPos, (t) => shipWorldState(ship, t).r, this.world.t);
    const delay = isFinite(tArrive) ? tArrive - this.world.t : Infinity;
    const applied = this.applyCommand(ship, command);
    return { delay, applied };
  }

  private deliverMessage(id: string): void {
    const idx = this.world.messages.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const msg = this.world.messages[idx]!;
    this.world.messages.splice(idx, 1);
    if (msg.kind !== "command" || !msg.command) return; // telemetry just "arrives"

    const ship = this.world.ships.get(msg.targetId);
    if (!ship) return;
    // The command resolves in the ship's frame AT DELIVERY — which, after the
    // light delay, may differ from the frame the player aimed at (it may have
    // crossed an SOI). That is the light-lag bargain, not a bug. The ship answers
    // honestly: an ACK if it executed the order, a NACK if it could not.
    const ok = this.applyCommand(ship, msg.command);
    this.emitTelemetry(ship, `${ok ? "ack" : "nack"}: ${msg.label}`);
  }

  private applyCommand(ship: Ship, command: ShipCommand): boolean {
    if (command.type === "burn") {
      return command.goal
        ? this.applyClosedBurn(ship, command.dv, command.dir, command.goal, command.goalPrimary)
        : this.applyBurn(ship, command.dv, command.dir);
    }
    return false;
  }

  /** Begin a finite-thrust burn (the mutation behind a delivered burn command).
   *  Returns false (rejected → NACK) if it cannot start: already mid-burn, or the
   *  commanded engine Δv exceeds the ship's remaining budget (a burn it could not
   *  complete should be honestly refused, not run dry and falsely acknowledged). */
  private applyBurn(ship: Ship, dv: number, dir: BurnDir): boolean {
    if (dv <= 0 || ship.mode === "thrust") return false;
    if (dv > dvRemaining(ship)) return false; // can't finish the commanded Δv → NACK
    const state = shipRelativeState(ship, this.world.t);
    ship.r = state.r;
    ship.v = state.v;
    ship.epoch = this.world.t; // r,v are valid now (used to extrapolate during thrust)
    ship.mode = "thrust";
    ship.burn = { dir, dvTarget: dv, dvDone: 0 };
    return true;
  }

  /** Begin a CLOSED-LOOP burn: at delivery, re-derive the Δv magnitude (the
   *  player picked `dir`) so the resulting conic meets `goal`, spending no more
   *  than the correction cap `dvCap`. The autonomous counter-pole to the
   *  open-loop bargain. Refused (→ NACK) if already mid-burn, in a powered/landed
   *  leg with no osculating conic to trim, if the ship has since crossed into a
   *  different SOI than the goal assumes, or if the goal is unreachable/already
   *  met within the affordable budget. */
  private applyClosedBurn(
    ship: Ship,
    dvCap: number,
    dir: BurnDir,
    goal: BurnGoal,
    goalPrimary?: string,
  ): boolean {
    if (dvCap <= 0 || ship.mode === "thrust") return false;
    // No clean osculating conic to trim against in these states.
    if (
      ship.interstellarLeg || ship.spiral || ship.entryLeg ||
      ship.launchLeg || ship.descentLeg || ship.landed
    ) {
      return false;
    }
    // The goal's radii are measured about goalPrimary; if the light delay let the
    // ship cross into a different SOI, the frame is invalid — refuse honestly.
    if (goalPrimary && ship.primary !== goalPrimary) return false;
    // Only ever search within what the ship can actually afford.
    const cap = Math.min(dvCap, dvRemaining(ship));
    if (!(cap > 0)) return false;
    const state = shipRelativeState(ship, this.world.t);
    const dv = solveBurnMagnitude(state.r, state.v, primaryMu(ship), dir, goal, cap);
    if (dv === null || dv <= 1e-9) return false; // unreachable, or already at goal
    ship.r = state.r;
    ship.v = state.v;
    ship.epoch = this.world.t;
    ship.mode = "thrust";
    ship.burn = { dir, dvTarget: dv, dvDone: 0 };
    return true;
  }

  /** Emit a telemetry/ack signal from a ship back to the control node at c. */
  private emitTelemetry(ship: Ship, label: string): void {
    const control = BODY_BY_ID.get(this.world.controlNode);
    if (!control) return;
    const t = this.world.t;
    const fromPos = shipWorldState(ship, t).r;
    const posFn = (tt: number): Vec3 => bodyState(control, tt).r;
    const tArrive = signalArrival(fromPos, posFn, t);
    if (!isFinite(tArrive)) return; // control node unreachable from here — drop the telemetry
    const id = `msg-${this.msgCounter++}`;
    this.world.messages.push({
      id, kind: "telemetry", fromPos, toPos: posFn(tArrive), targetId: this.world.controlNode,
      tEmit: t, tArrive, label,
    });
    this.events.push({ t: tArrive, kind: "message-arrival", entityId: id });
  }

  /**
   * Execute a scheduled interplanetary departure: aim the arrival so the
   * approach hyperbola clears the target (B-plane targeting, evaluated at the
   * true SOI-entry state), pay the Oberth-aware injection from the parking
   * orbit, place the ship on the heliocentric leg, and schedule its
   * sphere-of-influence crossing.
   */
  private executeDeparture(ship: Ship, evT: number): void {
    const tr = ship.transfer;
    if (!tr || tr.departed) return;
    if (Math.abs(evT - tr.tDepart) > 1) return; // stale event from a re-plan

    const depBody = BODY_BY_ID.get(ship.primary);
    const target = BODY_BY_ID.get(tr.targetId);
    if (!depBody || !target) return;

    const t = this.world.t; // == tr.tDepart

    // Lagrange-point arrival: a Lambert leg in the cruise frame to a free co-moving point. There
    // is no SOI to enter, so it seeds the conic and schedules its own transfer-arrive.
    if (tr.arrival?.kind === "lagrange") { this.executeLagrangeDeparture(ship, tr, t); return; }

    // Same-primary synchronous (GEO) raise: an in-SOI Hohmann from the current orbit to the
    // synchronous radius — no Lambert, no SOI change. Identified by `central` == the ship's primary.
    if (tr.arrival?.kind === "synchronous" && tr.central === ship.primary) {
      this.executeSyncRaiseDeparture(ship, tr, t); return;
    }

    // Intra-system moon TOUR (most-specific case first): cruises about the parent (tr.central)
    // AND walks a moon-flyby chain inside the parent's SOI. A plain moon transfer sets `central`
    // but no `flybys`; a heliocentric assist sets `flybys` but no `central` — so the tour is the
    // combination, and must be matched BEFORE the plain-moon branch below.
    if (tr.central && tr.central !== "sun" && tr.flybys && tr.flybys.length > 0 && !tr.flybys[0]!.done) {
      this.executeMoonTourDeparture(ship, tr, t);
      return;
    }

    // Moon transfer: cruise about the PARENT (tr.central), not the Sun. The ship stays in
    // the parent's SOI, so it is seeded at its CURRENT parking-orbit position (not the
    // parent's centre) onto a parent-centric transfer conic toward the moon.
    if (tr.central && tr.central !== "sun") {
      this.executeMoonDeparture(ship, tr, t);
      return;
    }

    // Gravity-assist mission: leg 1 aims at the FIRST flyby body (a patched-conic
    // point), and a chain of flyby-pass events handles each bend + the leg toward the
    // next flyby (or, after the last, the final target).
    if (tr.flybys && tr.flybys.length > 0 && !tr.flybys[0]!.done) {
      this.executeAssistDeparture(ship, tr, t, depBody);
      return;
    }

    const depState = bodyState(depBody, t);
    // A remote SYNCHRONOUS arrival aims the hyperbola straight at the synchronous radius (capture
    // directly into a circular GEO/areostationary orbit); aerocapture aims the periapsis INTO the
    // atmosphere (aeroPeriAlt); a plain propulsive arrival aims at the default parking altitude.
    const rCapture = tr.arrival?.kind === "synchronous"
      ? synchronousRadius(target.mu, target.rotationPeriod ?? 0)
      : target.radius + (tr.aeroPeriAlt ?? DEFAULT_CAPTURE_ALT);
    const aim = aimArrival(depBody, target, t, tr.tArrive, rCapture);
    if (!aim) return; // degenerate geometry; leave the transfer un-departed so it can be re-planned

    // Oberth-aware injection from the current parking orbit (see Phase-3 audit).
    const vInf = length(sub(aim.v1, depState.v));
    const parkEl = shipOsculatingElements(ship, t);
    const rPark = periapsisRadius(parkEl.a, parkEl.e);
    const dv = hyperbolicBurnDv(vInf, depBody.mu, rPark);
    if (!applyImpulsiveDv(ship, dv)) return; // can't afford injection — stay in parking orbit, un-departed

    // The injection is committed: only NOW has the ship actually left the parking
    // orbit, so mark departed here (not before the guards) — an aborted injection
    // must leave departed=false so the transfer stays re-plannable, not soft-locked.
    tr.departed = true;
    tr.dvDepart = dv;

    // Onto the heliocentric transfer toward the aim point. This is the documented
    // SOI-as-point DEPARTURE idealization: the ship is seeded on the heliocentric
    // conic from the departure body's CENTRE with the Lambert velocity, dropping
    // the parking-orbit offset (~rPark, a few thousand km ≈ 3e-5 of 1 AU, below the
    // ephemeris error at heliocentric scale) and the brief SOI-escape arc. Only
    // ARRIVAL SOI continuity is modelled (see enterSoi/exitSoi); see ROADMAP.
    ship.primary = "sun";
    ship.mode = "coast";
    ship.r = undefined;
    ship.v = undefined;
    ship.elements = stateToElements(depState.r, aim.v1, MU_SUN);
    ship.epoch = t;

    this.events.push({ t: aim.tSoi, kind: "soi-crossing", entityId: ship.id });
  }

  /**
   * Departure of a MOON transfer (cruise frame = the parent planet `tr.central`): re-solve
   * the parent-centric Lambert from the ship's current parking-orbit position to the moon,
   * pay the direct injection, seed the parent-centric transfer conic (the ship stays in the
   * parent's SOI), and schedule the moon SOI crossing.
   */
  private executeMoonDeparture(ship: Ship, tr: NonNullable<Ship["transfer"]>, t: number): void {
    const central = BODY_BY_ID.get(tr.central!);
    const moon = BODY_BY_ID.get(tr.targetId);
    if (!central || !moon) return;
    const shipDep = shipRelativeState(ship, t); // parent-relative (primary == central)
    // Aim the parent-centric transfer at a moon-relative periapsis above the surface (a
    // B-plane offset), so the capture circularizes into a real parking orbit. The aim also
    // gives the moon SOI-entry time.
    const rParkTo = moon.radius + DEFAULT_CAPTURE_ALT;
    const aim = aimMoonArrival(central, moon, shipDep.r, t, tr.tArrive, rParkTo);
    if (!aim) return; // degenerate; leave un-departed for re-planning
    // Safety net: never fly the ship into the parent. An injection solved only against the
    // moon-relative arrival can — for an unfavourable parking-orbit phase — put the outbound
    // conic's periapsis below the parent's surface (searchMoonWindow already filters these, but
    // a directly-specified window might not). Leave the transfer un-departed so it re-plans
    // rather than committing a powered burn straight into the planet.
    if (!outboundClearsParent(shipDep.r, aim.v1, central.mu, central.radius)) return;
    const dv = length(sub(aim.v1, shipDep.v));
    if (!applyImpulsiveDv(ship, dv)) return; // can't afford the injection — stay parked

    tr.departed = true;
    tr.dvDepart = dv;
    ship.primary = central.id;
    ship.mode = "coast";
    ship.r = undefined;
    ship.v = undefined;
    ship.elements = stateToElements(shipDep.r, aim.v1, central.mu);
    ship.epoch = t;
    this.events.push({ t: aim.tSoi, kind: "soi-crossing", entityId: ship.id });
  }

  /**
   * Departure of an intra-system moon TOUR (cruise frame = the parent planet `tr.central`): seed
   * the parent-centric leg-1 Lambert from the ship's current parking position to the FIRST flyby
   * moon's centre (a patched-conic point), pay the DIRECT injection (the ship is already in orbit
   * about the parent — no origin-body well to escape, mirroring executeMoonDeparture), keep it in
   * the parent's SOI, and schedule the first moon flyby-pass. The parent-frame twin of
   * executeAssistDeparture.
   */
  private executeMoonTourDeparture(ship: Ship, tr: NonNullable<Ship["transfer"]>, t: number): void {
    const central = BODY_BY_ID.get(tr.central!);
    const first = tr.flybys![0]!;
    const firstMoon = BODY_BY_ID.get(first.bodyId);
    if (!central || !firstMoon) return;
    const shipDep = shipRelativeState(ship, t); // parent-relative (primary == central)
    const moonR = bodyStateRelative(firstMoon, first.tFlyby).r;
    const leg1 = lambert(shipDep.r, moonR, first.tFlyby - t, central.mu, true);
    if (!leg1) return; // degenerate; leave un-departed for re-planning
    // Safety net: never fly the ship into the parent. The leg-1 Lambert to the first flyby moon
    // can — for an unfavourable parking-orbit phase — put the parent-relative outbound conic's
    // periapsis below the surface (searchMoonTour already filters these, but a directly-specified
    // schedule might not). Leave the transfer un-departed so it re-plans rather than committing a
    // powered burn straight into the planet.
    if (!outboundClearsParent(shipDep.r, leg1.v1, central.mu, central.radius)) return;
    const dv = length(sub(leg1.v1, shipDep.v));
    if (!applyImpulsiveDv(ship, dv)) return; // can't afford the injection — stay parked

    tr.departed = true;
    tr.dvDepart = dv;
    ship.primary = central.id;
    ship.mode = "coast";
    ship.r = undefined;
    ship.v = undefined;
    ship.elements = stateToElements(shipDep.r, leg1.v1, central.mu);
    ship.epoch = t;
    this.events.push({ t: first.tFlyby, kind: "flyby-pass", entityId: ship.id });
  }

  /**
   * Departure of a gravity-assist mission: seed the ship on the heliocentric leg
   * to the FIRST flyby body's centre (a patched-conic flyby point) with the Lambert
   * velocity, pay the Oberth injection, and schedule the first flyby-pass.
   */
  private executeAssistDeparture(ship: Ship, tr: NonNullable<Ship["transfer"]>, t: number, depBody: BodyDef): void {
    const first = tr.flybys![0]!;
    const flybyBody = BODY_BY_ID.get(first.bodyId);
    if (!flybyBody) return;
    const depState = bodyState(depBody, t);
    const fbState = bodyState(flybyBody, first.tFlyby);
    const leg1 = lambert(depState.r, fbState.r, first.tFlyby - t, MU_SUN, true);
    if (!leg1) return; // degenerate; leave un-departed for re-planning

    const vInf = length(sub(leg1.v1, depState.v));
    const parkEl = shipOsculatingElements(ship, t);
    const rPark = periapsisRadius(parkEl.a, parkEl.e);
    const dv = hyperbolicBurnDv(vInf, depBody.mu, rPark);
    if (!applyImpulsiveDv(ship, dv)) return; // can't afford injection — stay parked

    tr.departed = true;
    tr.dvDepart = dv;
    ship.primary = "sun";
    ship.mode = "coast";
    ship.r = undefined;
    ship.v = undefined;
    ship.elements = stateToElements(depState.r, leg1.v1, MU_SUN);
    ship.epoch = t;
    this.events.push({ t: first.tFlyby, kind: "flyby-pass", entityId: ship.id });
  }

  /**
   * One gravity-assist flyby in the chain (patched-conic, instantaneous at
   * heliocentric scale, mirroring the SOI-as-point departure idealization). The ship
   * is at the flyby body; the body-relative excess velocity is rotated toward the next
   * leg's direction for FREE (the slingshot), only the excess-speed mismatch is charged
   * (an Oberth periapsis burn). The next leg aims at the FOLLOWING flyby body if one
   * remains (schedule another flyby-pass), else at the final target (schedule capture).
   */
  private executeFlyby(ship: Ship, evT: number): void {
    const tr = ship.transfer;
    if (!tr || !tr.flybys) return;
    const idx = tr.flybys.findIndex((f) => !f.done && Math.abs(evT - f.tFlyby) <= 1);
    if (idx < 0) return; // stale or already done
    const leg = tr.flybys[idx]!;
    const flybyBody = BODY_BY_ID.get(leg.bodyId);
    if (!flybyBody) return;

    // Frame: an intra-system moon TOUR bends about the PARENT (tr.central) with its moons as the
    // assist bodies; a heliocentric assist bends about the Sun with planets. The flyby relations
    // are identical — only the central μ, the frame body states are read in, the final-leg aim, and
    // the conic the ship continues on differ.
    const moonCruise = tr.central !== undefined && tr.central !== "sun";
    const central = moonCruise ? BODY_BY_ID.get(tr.central!) : undefined;
    if (moonCruise && !central) return;
    const mu = moonCruise ? central!.mu : MU_SUN;
    const stateOf = (b: BodyDef, tt: number): { r: Vec3; v: Vec3 } =>
      moonCruise ? bodyStateRelative(b, tt) : bodyState(b, tt);

    const t = this.world.t;
    const shipRel = shipRelativeState(ship, t); // parent- or helio-relative, per ship.primary
    const fb = stateOf(flybyBody, t);

    // Aim the leg leaving this flyby: at the NEXT flyby body's centre (a patched-conic
    // point, via Lambert) if the chain continues, else at the final target (a B-plane
    // capture aim). Either way it sets the frame velocity to leave the flyby with.
    const next = tr.flybys[idx + 1];
    let v1: Vec3;
    let nextEvent: { t: number; kind: "flyby-pass" | "soi-crossing" };
    if (next) {
      const nextBody = BODY_BY_ID.get(next.bodyId);
      if (!nextBody) return;
      const nextState = stateOf(nextBody, next.tFlyby);
      const legN = lambert(shipRel.r, nextState.r, next.tFlyby - t, mu, true);
      if (!legN) return; // re-plannable
      v1 = legN.v1;
      nextEvent = { t: next.tFlyby, kind: "flyby-pass" };
    } else {
      const target = BODY_BY_ID.get(tr.targetId);
      if (!target) return;
      if (moonCruise) {
        // Final moon leg: a J2-aware PARENT-frame B-plane aim (aimMoonArrival) into the moon's
        // small SOI — the parent-frame twin of the heliocentric aimArrival below.
        const rCapture = target.radius + DEFAULT_CAPTURE_ALT;
        const aim = aimMoonArrival(central!, target, shipRel.r, t, tr.tArrive, rCapture);
        if (!aim) return; // re-plannable
        v1 = aim.v1;
        nextEvent = { t: aim.tSoi, kind: "soi-crossing" };
      } else {
        // Aerocapture arrival aims the periapsis INTO the atmosphere (aeroPeriAlt); a
        // propulsive (circular or elliptical) arrival aims at the parking altitude. The
        // capture geometry itself is then chosen at SOI entry (enterSoi reads aeroPeriAlt /
        // captureApoAlt) — mirroring a direct transfer's executeDeparture.
        const rCapture = target.radius + (tr.aeroPeriAlt ?? DEFAULT_CAPTURE_ALT);
        const aim = aimArrival(flybyBody, target, t, tr.tArrive, rCapture);
        if (!aim) return; // re-plannable
        v1 = aim.v1;
        nextEvent = { t: aim.tSoi, kind: "soi-crossing" };
      }
    }

    const vInfIn = sub(shipRel.v, fb.v); // body-relative excess in
    const vInfOut = sub(v1, fb.v); // body-relative excess out (next-leg departure)
    const man = flybyManeuver(vInfIn, vInfOut, flybyBody);
    if (!applyImpulsiveDv(ship, man.dvFlyby)) return; // can't afford the residual burn

    leg.done = true;
    leg.dvBurn = man.dvFlyby;
    // Record the B-plane geometry actually flown: the rpMin-clamped periapsis (man.rp),
    // its impact parameter b = rp·√((e+1)/(e−1)) — the B-plane targeting handle — the
    // required bend, and any turn the free pass couldn't supply (paid by the periapsis
    // burn; 0 ⇒ the bend was free). A feasible free flyby has man.rp ≡ bPlaneAim's rp
    // (same e = 1/sin(δ/2) relation). Inspection/HUD only — v1 and the charged Δv above
    // are unchanged, so the flown trajectory and cost are byte-identical (hash-neutral).
    leg.rpAchieved = man.rp;
    leg.bMag = impactParameter(length(vInfIn), flybyBody.mu, man.rp);
    leg.turn = man.turnRequired;
    leg.residualTurn = man.residualTurn;
    // Continue on the next conic from the (continuous) flyby point, in the SAME frame — the
    // parent for a moon tour (the ship never leaves the planet's SOI), the Sun otherwise.
    ship.primary = moonCruise ? central!.id : "sun";
    ship.mode = "coast";
    ship.elements = stateToElements(shipRel.r, v1, mu);
    ship.epoch = t;
    this.events.push({ t: nextEvent.t, kind: nextEvent.kind, entityId: ship.id });
  }

  /** End of a low-thrust spiral: settle the ship onto the final circular orbit
   *  (the Δv/propellant were charged at commit) and clear the leg. */
  private arriveSpiral(ship: Ship): void {
    if (!ship.spiral) return;
    const final = spiralElements(ship, ship.spiral.tEnd);
    ship.spiral = undefined;
    ship.mode = "coast";
    ship.r = undefined;
    ship.v = undefined;
    ship.elements = final;
    ship.epoch = this.world.t;
  }

  // ── Synchronous (GEO) & Lagrange arrivals ────────────────────────────────────

  /** Elements of an equatorial circular orbit of radius `radius` about `body` passing closest to
   *  the direction `rDir` — the current position projected onto the equator and re-scaled, so the
   *  established GEO orbit lies in the equator with minimal positional jump. */
  private synchronousElements(rDir: Vec3, body: BodyDef, radius: number): KeplerElements {
    const pole = spinPole(body.obliquityDeg ?? 0);
    const proj = sub(rDir, scale(pole, dot(rDir, pole))); // drop the out-of-equator component
    const rEq = scale(normalize(proj), radius);
    const tHat = normalize(cross(pole, rEq)); // prograde direction in the equatorial plane
    const vEq = scale(tHat, Math.sqrt(body.mu / radius));
    return stateToElements(rEq, vEq, body.mu);
  }

  /**
   * Departure of a same-primary synchronous (GEO) raise: an in-SOI Hohmann from the current
   * circular orbit. Burn 1 is prograde at the current radius, seeding the transfer ellipse whose
   * apoapsis is the synchronous radius; the circularization + equatorial plane change (burn 2)
   * fires at apoapsis via transfer-arrive. The ship never leaves its primary's SOI.
   */
  private executeSyncRaiseDeparture(ship: Ship, tr: NonNullable<Ship["transfer"]>, t: number): void {
    const body = BODY_BY_ID.get(ship.primary);
    if (!body || !body.rotationPeriod) return;
    const st = shipRelativeState(ship, t);
    const rNow = length(st.r);
    const aSync = synchronousRadius(body.mu, body.rotationPeriod);
    if (aSync <= rNow) return; // already at/above synchronous — nothing to raise
    const aGTO = (rNow + aSync) / 2;
    const vPeri = visVivaSpeed(body.mu, rNow, aGTO); // transfer-ellipse periapsis speed
    const vPost = scale(normalize(st.v), vPeri); // prograde burn (plane change deferred to apoapsis)
    const dv = length(sub(vPost, st.v));
    if (!applyImpulsiveDv(ship, dv)) return; // can't afford — stay parked, un-departed
    tr.departed = true;
    tr.dvDepart = dv;
    ship.mode = "coast";
    ship.r = undefined;
    ship.v = undefined;
    ship.elements = stateToElements(st.r, vPost, body.mu); // on the transfer ellipse, at periapsis
    ship.epoch = t;
    const tof = Math.PI * Math.sqrt((aGTO * aGTO * aGTO) / body.mu); // half the transfer period
    this.events.push({ t: t + tof, kind: "transfer-arrive", entityId: ship.id });
  }

  /**
   * Departure of a Lagrange-point transfer: a Lambert leg in the cruise frame to the L-point's
   * co-moving state at arrival. Heliocentric (Sun–planet L-points) pays an Oberth escape from the
   * departure planet's well and seeds the heliocentric conic; geocentric (planet–moon L-points)
   * pays a direct injection from the parking orbit and stays in the parent's frame, like a moon
   * hop. Either way it schedules transfer-arrive — there is no SOI to enter at a free point.
   */
  private executeLagrangeDeparture(ship: Ship, tr: NonNullable<Ship["transfer"]>, t: number): void {
    const secondary = BODY_BY_ID.get(tr.targetId);
    if (!secondary || tr.arrival?.kind !== "lagrange") return;
    const point = tr.arrival.point;
    const geocentric = tr.central !== undefined && tr.central !== "sun";
    if (geocentric) {
      const central = BODY_BY_ID.get(tr.central!);
      if (!central) return;
      const dep = shipRelativeState(ship, t); // parent-relative parking state
      const arr = lagrangeStateRelative(secondary, point, tr.tArrive); // parent-relative L-point
      const sol = lambert(dep.r, arr.r, tr.tArrive - t, central.mu, true);
      if (!sol) return;
      if (!outboundClearsParent(dep.r, sol.v1, central.mu, central.radius)) return;
      const dv = length(sub(sol.v1, dep.v));
      if (!applyImpulsiveDv(ship, dv)) return; // can't afford — stay parked
      tr.departed = true;
      tr.dvDepart = dv;
      ship.primary = central.id;
      ship.mode = "coast";
      ship.r = undefined;
      ship.v = undefined;
      ship.elements = stateToElements(dep.r, sol.v1, central.mu);
      ship.epoch = t;
    } else {
      const depBody = BODY_BY_ID.get(ship.primary);
      if (!depBody) return;
      const depState = bodyState(depBody, t);
      const arr = lagrangeState(secondary, point, tr.tArrive); // heliocentric absolute
      const sol = lambert(depState.r, arr.r, tr.tArrive - t, MU_SUN, true);
      if (!sol) return;
      const vInf = length(sub(sol.v1, depState.v));
      const parkEl = shipOsculatingElements(ship, t);
      const rPark = periapsisRadius(parkEl.a, parkEl.e);
      const dv = hyperbolicBurnDv(vInf, depBody.mu, rPark); // Oberth escape from the planet's well
      if (!applyImpulsiveDv(ship, dv)) return; // can't afford injection — stay parked
      tr.departed = true;
      tr.dvDepart = dv;
      ship.primary = "sun";
      ship.mode = "coast";
      ship.r = undefined;
      ship.v = undefined;
      ship.elements = stateToElements(depState.r, sol.v1, MU_SUN);
      ship.epoch = t;
    }
    this.events.push({ t: tr.tArrive, kind: "transfer-arrive", entityId: ship.id });
  }

  /** transfer-arrive dispatch: a Lagrange velocity match, or the circularization of a GEO raise. */
  private arriveTransfer(ship: Ship): void {
    const tr = ship.transfer;
    if (!tr || tr.arrived) return;
    if (tr.arrival?.kind === "lagrange") this.arriveAtLagrange(ship, tr);
    else if (tr.arrival?.kind === "synchronous") this.arriveSyncRaise(ship, tr);
  }

  /**
   * Arrive at a Lagrange point: match the point's co-moving velocity (a single impulse — no
   * gravity well, no Oberth) and park the ship on the secondary's displaced Keplerian arc, which
   * tracks the point over the timescales that matter. Halo/libration & station-keeping are not
   * modelled. The cruise frame is read off `tr.central` (geocentric for planet–moon L-points).
   */
  private arriveAtLagrange(ship: Ship, tr: NonNullable<Ship["transfer"]>): void {
    const secondary = BODY_BY_ID.get(tr.targetId);
    if (!secondary || tr.arrival?.kind !== "lagrange") return;
    const point = tr.arrival.point;
    const t = this.world.t;
    const geocentric = tr.central !== undefined && tr.central !== "sun";
    const cruiseMu = geocentric ? BODY_BY_ID.get(tr.central!)!.mu : MU_SUN;
    const pointState = geocentric
      ? lagrangeStateRelative(secondary, point, t)
      : lagrangeState(secondary, point, t);
    const st = shipRelativeState(ship, t); // relative to ship.primary (the cruise centre)
    const dv = length(sub(pointState.v, st.v)); // velocity match
    if (!applyImpulsiveDv(ship, dv)) return; // can't afford — coasts past the point
    ship.mode = "coast";
    ship.r = undefined;
    ship.v = undefined;
    ship.elements = stateToElements(pointState.r, pointState.v, cruiseMu);
    ship.epoch = t;
    tr.arrived = true;
    tr.dvArrive = dv;
    // Higher-fidelity arrival: if the craft is in perturbed mode, fly the L-point as a
    // continuous third-body coast (it will actually drift off the kinematic point on the
    // real instability timescale) instead of staying pinned to the two-body conic.
    if (ship.fidelity === "perturbed") this.armPerturbedLeg(ship, t);
  }

  // ── Third-body perturbed propagation (the flown higher-fidelity tier) ─────────

  /**
   * Opt a ship into flown third-body PERTURBED propagation and arm its first leg. The
   * ship is then coasted under continuous third-body gravity (the Sun on a high orbit,
   * sibling moons inside a planet's SOI, Earth at a Sun–Earth L-point) as successive
   * bounded `PerturbedLeg`s, each re-osculating and re-arming the next. Opt-in and
   * reversible (clear `fidelity`); the default game model is untouched. Returns false if
   * the ship can't be armed right now (thrusting, on another leg, landed, mid-transfer).
   */
  flyPerturbed(
    shipId: string,
    opts: { horizon?: number; includeJ2?: boolean; perturbers?: Perturber[] } = {},
  ): boolean {
    const ship = this.world.ships.get(shipId);
    if (!ship) return false;
    ship.fidelity = "perturbed";
    return this.armPerturbedLeg(ship, this.world.t, opts);
  }

  /** Stop flying a ship perturbed: drop the active leg + its finalize and re-osculate
   *  onto a plain game-mode conic from wherever it is now. */
  stopPerturbed(shipId: string): void {
    const ship = this.world.ships.get(shipId);
    if (!ship) return;
    ship.fidelity = undefined;
    ship.stationKeep = undefined; // station-keeping rides on perturbed legs; it can't run without them
    if (ship.perturbedLeg) {
      const st = shipRelativeState(ship, this.world.t);
      ship.elements = stateToElements(st.r, st.v, primaryMu(ship));
      ship.epoch = this.world.t;
      ship.perturbedLeg = undefined;
    }
    this.events.removeByEntityKind(ship.id, "perturbed-finalize");
  }

  /** Build and attach a bounded perturbed-coast leg from the ship's current state, and
   *  schedule its finalize. Pure-deterministic in the start state + time (the perturbers
   *  are analytic), so the leg — and the whole re-arm chain — is chunk-invariant. */
  private armPerturbedLeg(
    ship: Ship, t: number,
    opts: { horizon?: number; includeJ2?: boolean; perturbers?: Perturber[] } = {},
  ): boolean {
    if (ship.status === "lost" || ship.landed || ship.interstellarLeg) return false;
    if (ship.mode === "thrust" || ship.burn) return false;
    if (ship.entryLeg || ship.approachLeg || ship.spiral || ship.launchLeg || ship.descentLeg) return false;
    if (ship.transfer && !ship.transfer.arrived) return false; // a pending transfer owns the path
    const body = BODY_BY_ID.get(ship.primary);
    if (!body) return false;
    const st = shipRelativeState(ship, t);
    const horizon = opts.horizon ?? PERTURBED_LEG_HORIZON;
    const perturbers = opts.perturbers ?? selectPerturbers(ship.primary, t, {
      threshold: PERTURBED_SELECT_THRESHOLD, r0: st.r, horizon, mu: body.mu,
    });
    if (perturbers.length === 0) return false; // nothing significant to feel
    const leg = buildPerturbedLeg(body, st.r, st.v, t, horizon, perturbers, { includeJ2: opts.includeJ2 });
    ship.perturbedLeg = leg;
    ship.mode = "coast";
    ship.r = undefined;
    ship.v = undefined;
    // Cancel any stale finalize before scheduling this leg's, so a re-arm can never be
    // pre-empted by a previous leg's pending event.
    this.events.removeByEntityKind(ship.id, "perturbed-finalize");
    this.events.push({ t: leg.tEnd, kind: "perturbed-finalize", entityId: ship.id });
    return true;
  }

  /** End a perturbed-coast leg. With a station-keeping hold active, charge the correction
   *  Δv that returns the ship from its drifted exit to the nominal target — re-seating it
   *  on the nominal and re-arming, UNLESS it can't afford it (then the hold fails and it
   *  drifts on). Without a hold, just re-osculate on the drifted exit and, while still in
   *  perturbed mode, re-arm the next bounded chunk. */
  private finalizePerturbed(ship: Ship): void {
    const leg = ship.perturbedLeg;
    if (!leg) return;
    const t = this.world.t; // == leg.tEnd
    const mu = primaryMu(ship);
    ship.perturbedLeg = undefined;
    ship.mode = "coast";
    ship.r = undefined;
    ship.v = undefined;

    // Station-keeping: pay to return to the nominal target, or fail and drift.
    const sk = ship.stationKeep;
    if (sk && sk.holding) {
      const nom = this.stationNominalState(ship, sk, t);
      if (nom) {
        // Velocity-restore correction (deadband: the small position drift is re-seated for
        // free, mirroring arriveAtLagrange's velocity-match — a documented abstraction).
        const holdDv = length(sub(leg.exitV, nom.v));
        if (applyImpulsiveDv(ship, holdDv)) {
          sk.dvSpent += holdDv;
          sk.lastDv = holdDv;
          ship.elements = stateToElements(nom.r, nom.v, mu);
          ship.epoch = t;
          this.armPerturbedLeg(ship, t, { horizon: sk.windowS });
          return;
        }
        sk.holding = false; // can't afford the correction — station-keeping has failed
      } else {
        sk.holding = false; // nominal target unresolvable — stop holding
      }
    }

    // Default / failed-hold: re-osculate on the drifted exit and keep drifting if perturbed.
    ship.elements = stateToElements(leg.exitR, leg.exitV, mu);
    ship.epoch = t;
    if (ship.fidelity === "perturbed") this.armPerturbedLeg(ship, t);
  }

  // ── Δv-accounted station-keeping (the player-ship paid hold) ──────────────────

  /** The nominal target state (body-relative, in the ship's primary frame) a hold tracks:
   *  a co-moving L-point (`lagrangeState`), or a fixed orbit advanced by Kepler + secular
   *  J2. Null if the target can't be resolved. */
  private stationNominalState(ship: Ship, sk: StationKeep, t: number): State | null {
    if (sk.kind === "lagrange") {
      const secondary = sk.secondaryId ? BODY_BY_ID.get(sk.secondaryId) : undefined;
      if (!secondary || !sk.point) return null;
      const geocentric = sk.central !== undefined && sk.central !== "sun";
      return geocentric ? lagrangeStateRelative(secondary, sk.point, t) : lagrangeState(secondary, sk.point, t);
    }
    if (!sk.nominal || sk.nominalEpoch === undefined) return null;
    const body = BODY_BY_ID.get(ship.primary);
    if (!body) return null;
    const dt = t - sk.nominalEpoch;
    const el = propagate(sk.nominal, body.mu, dt);
    if (body.J2 && el.e < 1) {
      const r = j2Rates(body.mu, j2RefRadius(body), body.J2, el.a, el.e, el.i);
      el.Omega = wrapPi(el.Omega + r.nodeDot * dt);
      el.omega = wrapPi(el.omega + r.periDot * dt);
      el.M = wrapPi(el.M + r.anomalyDot * dt);
    }
    return elementsToState(el, body.mu);
  }

  /**
   * Engage Δv-accounted station-keeping: the ship spends propellant each correction window
   * to hold `target` against the third-body drift the perturbed model reveals, and drifts
   * off once it can no longer afford the hold. Runs ON TOP of perturbed flight (arms a
   * short-horizon perturbed leg). `target` is an L-point (nominal from `lagrangeState`) or
   * the ship's current orbit (`{kind:"orbit"}`). Returns false if it can't be armed
   * (thrusting, on another leg, landed, mid-transfer).
   */
  holdStation(
    shipId: string,
    target: { kind: "lagrange"; secondaryId: string; point: LagrangePoint; central?: string } | { kind: "orbit" },
    opts: { windowS?: number } = {},
  ): boolean {
    const ship = this.world.ships.get(shipId);
    if (!ship) return false;
    const windowS = Math.max(3600, opts.windowS ?? STATIONKEEP_WINDOW);
    const sk: StationKeep = target.kind === "lagrange"
      ? { kind: "lagrange", secondaryId: target.secondaryId, point: target.point, central: target.central,
          dvSpent: 0, lastDv: 0, windowS, holding: true }
      : { kind: "orbit", nominal: shipOsculatingElements(ship, this.world.t), nominalEpoch: this.world.t,
          dvSpent: 0, lastDv: 0, windowS, holding: true };
    ship.stationKeep = sk;
    ship.fidelity = "perturbed";
    const armed = this.armPerturbedLeg(ship, this.world.t, { horizon: windowS });
    if (!armed) ship.stationKeep = undefined; // couldn't start — leave no dangling hold
    return armed;
  }

  /** Stop station-keeping; the ship reverts to a plain game-mode coast (also stops the
   *  underlying perturbed flight). */
  releaseStation(shipId: string): void {
    this.stopPerturbed(shipId); // clears stationKeep + perturbedLeg, re-osculates onto a conic
  }

  /** Circularize a same-primary GEO raise at apoapsis: a combined burn that circularizes at the
   *  synchronous radius and rotates the orbit into the body's equator. */
  private arriveSyncRaise(ship: Ship, tr: NonNullable<Ship["transfer"]>): void {
    const body = BODY_BY_ID.get(ship.primary);
    if (!body || !body.rotationPeriod) return;
    const t = this.world.t;
    const st = shipRelativeState(ship, t); // ≈ apoapsis at the synchronous radius
    const aSync = synchronousRadius(body.mu, body.rotationPeriod);
    const di = inclinationToEquator(cross(st.r, st.v), body.obliquityDeg ?? 0);
    const dv = combinedPlaneChangeDv(length(st.v), Math.sqrt(body.mu / aSync), di);
    if (!applyImpulsiveDv(ship, dv)) return; // can't afford — stays on the transfer ellipse
    ship.mode = "coast";
    ship.r = undefined;
    ship.v = undefined;
    ship.elements = this.synchronousElements(st.r, body, aSync);
    ship.epoch = t;
    tr.arrived = true;
    tr.dvArrive = dv;
  }

  /**
   * Sphere-of-influence crossing: switch the reference body using the CONTINUOUS
   * state vector (never interpolated elements), re-derive the now-hyperbolic
   * orbit about the target, and schedule the capture burn at its periapsis.
   */
  private enterSoi(ship: Ship): void {
    const tr = ship.transfer;
    if (!tr || tr.inSoi) return;
    const target = BODY_BY_ID.get(tr.targetId);
    if (!target) return;

    const t = this.world.t;
    const shipState = shipRelativeState(ship, t);
    // A moon transfer cruises about the parent, so the hand-off is parent-relative; an
    // interplanetary transfer hands off in the heliocentric frame.
    const moonCruise = tr.central !== undefined && tr.central !== "sun";
    const tgt = moonCruise ? bodyStateRelative(target, t) : bodyState(target, t);
    const rRel = sub(shipState.r, tgt.r);
    const vRel = sub(shipState.v, tgt.v);

    ship.primary = tr.targetId;
    ship.mode = "coast";
    ship.r = undefined;
    ship.v = undefined;
    ship.elements = stateToElements(rRel, vRel, target.mu);
    ship.epoch = t;
    tr.inSoi = true;

    // Only an inbound hyperbola (e > 1, pre-periapsis) is captured at a future
    // periapsis. Anything else is an off-nominal arrival — a flyby: the ship is
    // merely passing through the SOI, so schedule its EGRESS and re-patch back to
    // a heliocentric conic when it leaves, rather than stranding it on a
    // target-centred conic forever (which would fly it to infinity about the
    // target while only the target's bounded position is added back).
    const el = ship.elements;
    if (el.e <= 1 || el.M >= 0) {
      // Schedule the outbound SOI crossing from the conic GEOMETRY (robust to the
      // mean-anomaly wrapping convention: elliptic M is wrapped to [0,2π) while
      // hyperbolic M is signed). The mean anomaly magnitude at r = rSoi is a
      // geometric quantity; an inbound arrival reaches it again after dipping to
      // periapsis (Δt = 2·Mᵣ/n by symmetry), an already-outbound one egresses now.
      const parentMu = target.parent ? BODY_BY_ID.get(target.parent)!.mu : MU_SUN;
      const rSoi = soiRadius(bodyElements(target, t)!.a, target.mu, parentMu);
      const n = meanMotion(el.a, target.mu);
      const inbound = rRel.x * vRel.x + rRel.y * vRel.y + rRel.z * vRel.z < 0;
      let dt = 0;
      if (inbound) {
        if (el.e < 1) {
          const cosE = Math.max(-1, Math.min(1, (1 - rSoi / el.a) / el.e));
          const E = Math.acos(cosE);
          dt = (2 * (E - el.e * Math.sin(E))) / n;
        } else {
          const coshF = Math.max(1, (1 - rSoi / el.a) / el.e); // a<0 ⇒ argument > 1
          const F = Math.acosh(coshF);
          dt = (2 * (el.e * Math.sinh(F) - F)) / n;
        }
      }
      this.events.push({ t: t + dt, kind: "soi-exit", entityId: ship.id });
      return;
    }

    // Aerocapture arrival: the hyperbola's periapsis is inside the atmosphere, so fly
    // the drag pass (an entry leg) at the interface crossing instead of a propulsive
    // capture burn. finishEntry then trims periapsis up at first apoapsis.
    if (tr.aeroPeriAlt !== undefined && target.atmosphere) {
      const x = entryInterfaceCrossing(target, el);
      if (x) {
        this.events.push({ t: t + x.dtToInterface, kind: "entry-start", entityId: ship.id });
        return;
      }
      // No interface crossing (aim ended up above the atmosphere) — fall back to a
      // propulsive capture so the arrival still completes.
    }

    // An OBLATE body bends the inbound hyperbola enough (hundreds of km of periapsis at a
    // giant) that the periapsis a capture actually reaches differs from the two-body a(1−e).
    // Secular J2 is identically zero on a hyperbola, so fly the J2-perturbed approach as a
    // once-sampled read-time leg (the SAME j2Approach the arrival aim uses ⇒ the flown
    // periapsis matches the planned one). Capture fires at the perturbed periapsis instant.
    // A spherical body (no J2) returns null and stays a pure-Kepler coast.
    const approach = buildApproachLeg(target, rRel, vRel, t);
    if (approach) {
      ship.approachLeg = approach;
      this.events.push({ t: approach.tEnd, kind: "capture", entityId: ship.id });
      return;
    }

    // Schedule the capture at periapsis (time-to-periapsis = −M/n for M < 0).
    const n = meanMotion(el.a, target.mu);
    const tPeri = t + -el.M / n;
    this.events.push({ t: tPeri, kind: "capture", entityId: ship.id });
  }

  /**
   * Sphere-of-influence EGRESS for an uncaptured flyby: the mirror of enterSoi.
   * Switch the reference body back to the Sun using the CONTINUOUS relative state
   * vector (so world position/velocity stay continuous across the patch) and
   * re-derive the heliocentric conic. Without this a flyby would propagate as an
   * isolated orbit about the target forever — physically false once it leaves the
   * SOI and solar gravity again dominates.
   */
  private exitSoi(ship: Ship): void {
    const tr = ship.transfer;
    if (!tr || !tr.inSoi || tr.arrived) return; // captured ships never egress
    if (ship.primary === "sun") return;
    const target = BODY_BY_ID.get(ship.primary);
    if (!target) return;

    const t = this.world.t;
    const rel = shipRelativeState(ship, t); // continuous target-relative state at egress

    // Re-patch into the frame the cruise lives in. An intra-system moon TOUR egresses from a
    // moon's SOI back into the PARENT planet's frame (parent.mu, parent-relative) — the ship is
    // still deep inside the planet's SOI, so re-patching to the Sun (as a heliocentric flyby does)
    // would corrupt the frame. A heliocentric flyby egresses to the Sun.
    const moonCruise = tr.central !== undefined && tr.central !== "sun";
    const parent = moonCruise && target.parent ? BODY_BY_ID.get(target.parent) : undefined;
    if (parent) {
      const tgt = bodyStateRelative(target, t); // parent-relative moon state
      ship.primary = parent.id;
      ship.mode = "coast";
      ship.r = undefined;
      ship.v = undefined;
      ship.elements = stateToElements(add(rel.r, tgt.r), add(rel.v, tgt.v), parent.mu);
      ship.epoch = t;
      tr.inSoi = false; // back on a parent-centric conic — the tour continues correctly
      return;
    }

    const tgt = bodyState(target, t);
    ship.primary = "sun";
    ship.mode = "coast";
    ship.r = undefined;
    ship.v = undefined;
    ship.elements = stateToElements(add(rel.r, tgt.r), add(rel.v, tgt.v), MU_SUN);
    ship.epoch = t;
    tr.inSoi = false; // back on a heliocentric conic — the flyby continues correctly
  }

  /**
   * Capture burn at periapsis: an impulsive retrograde burn (the patched-conic
   * idealization, Oberth-efficient at periapsis) circularizing the hyperbolic
   * approach into a bound orbit at the periapsis radius.
   */
  private captureAtPeriapsis(ship: Ship): void {
    const tr = ship.transfer;
    if (!tr || tr.arrived) return;
    const body = BODY_BY_ID.get(ship.primary);
    if (!body) return;

    const t = this.world.t;
    const st = shipRelativeState(ship, t); // at periapsis (coast about target)
    const r = length(st.r);

    // SYNCHRONOUS (GEO/areostationary) arrival: the hyperbola was aimed straight at the synchronous
    // radius, so capture here circularizes AND rotates into the body's equator in one combined burn
    // (cheap at the low synchronous speed). The final orbit is equatorial and circular at a_sync.
    if (tr.arrival?.kind === "synchronous") {
      const aSync = synchronousRadius(body.mu, body.rotationPeriod ?? 0);
      const di = inclinationToEquator(cross(st.r, st.v), body.obliquityDeg ?? 0);
      const captureDv = combinedPlaneChangeDv(length(st.v), Math.sqrt(body.mu / aSync), di);
      if (!applyImpulsiveDv(ship, captureDv)) return; // can't afford — stays on the hyperbola
      ship.elements = this.synchronousElements(st.r, body, aSync);
      ship.epoch = t;
      ship.mode = "coast";
      ship.approachLeg = undefined;
      tr.arrived = true;
      tr.dvArrive = captureDv;
      this.maybeChainMoonLeg(ship, tr);
      return;
    }

    // Capture speed at periapsis: circularize (vCirc) by default, or — for an ELLIPTICAL capture
    // (tr.captureApoAlt set) — only slow to the periapsis speed of a bound ellipse reaching that
    // apoapsis. The latter is the Oberth-cheap deep-well insertion; it leaves periapsis here.
    let vTarget = Math.sqrt(body.mu / r);
    if (tr.captureApoAlt !== undefined) {
      const rApo = Math.max(r, body.radius + tr.captureApoAlt);
      vTarget = Math.sqrt(body.mu * (2 / r - 2 / (r + rApo)));
    }

    // Target the tangential (prograde) direction and take the FULL vector difference, so any
    // residual radial component is removed and the propellant charged matches the burn actually
    // flown. (At exact periapsis this equals the scalar |v| − vTarget.)
    const tHat = normalize(cross(cross(st.r, st.v), st.r));
    const targetV = scale(tHat, vTarget);
    const captureDv = length(sub(targetV, st.v));
    if (!applyImpulsiveDv(ship, captureDv)) return; // can't afford — stays on the hyperbola

    ship.elements = stateToElements(st.r, targetV, body.mu);
    ship.epoch = t;
    ship.mode = "coast";
    ship.approachLeg = undefined; // the J2 approach ends at this periapsis; coast the bound orbit now
    tr.arrived = true;
    tr.dvArrive = captureDv;
    this.maybeChainMoonLeg(ship, tr);
  }

  /**
   * Auto-chain the Stage-2 (moon) leg of a cross-system mission. On capturing into a parking
   * orbit at a planet, if the just-completed transfer carried `thenMoonId` AND that moon orbits
   * the planet we're now at, search a fresh parent-centric window (searchMoonWindow) and queue
   * the moon-leg departure — which then flies exactly as a same-parent moon transfer. The field
   * is consumed unconditionally so a missed window never re-fires. Capture is a deterministic
   * event and the search is a fixed grid ⇒ the chain is chunk-invariant.
   */
  private maybeChainMoonLeg(ship: Ship, tr: NonNullable<Ship["transfer"]>): void {
    const moonId = tr.thenMoonId;
    if (!moonId) return;
    tr.thenMoonId = undefined;
    const moon = BODY_BY_ID.get(moonId);
    if (!moon || moon.parent !== ship.primary) return; // not at the moon's planet
    const parent = BODY_BY_ID.get(ship.primary);
    const t = this.world.t;
    const aPark = shipOsculatingElements(ship, t).a;
    // If the mission captured at the planet into a loose ellipse, the moon leg should capture into
    // a loose ellipse too — but sized to the MOON's own well (reusing the planet's apoapsis altitude
    // would be physically wrong). A circular Stage-1 keeps the moon leg circular.
    const apo = parent && tr.captureApoAlt !== undefined ? moonLooseApoAlt(parent, moon, t) : undefined;
    const win = searchMoonWindow(ship.primary, moonId, t, (tt) => shipRelativeState(ship, tt), aPark, apo);
    if (!win) return;
    ship.transfer = {
      targetId: moonId, tDepart: win.tDepart, tArrive: win.tArrive,
      dvDepart: win.dvDepart, dvArrive: win.dvArrive,
      departed: false, inSoi: false, arrived: false, central: ship.primary,
      ...(apo !== undefined ? { captureApoAlt: apo } : {}),
    };
    this.events.push({ t: win.tDepart, kind: "transfer-depart", entityId: ship.id });
  }

  /**
   * Begin an in-sim atmospheric-entry pass: the ship has coasted to the interface,
   * so capture its body-relative state, build the (ballistic, no-propellant) entry
   * leg, and schedule the finalize at its end. Re-validates that the ship is still
   * coasting and actually at/descending through the interface (the player may have
   * burned away in the interim) — otherwise it does nothing.
   */
  private beginEntry(ship: Ship): void {
    if (ship.mode !== "coast" || ship.landed || ship.entryLeg || ship.interstellarLeg || ship.spiral) return;
    const body = BODY_BY_ID.get(ship.primary);
    if (!body || body.hasSurface === false || !body.atmosphere) return;
    const t = this.world.t;
    const st = shipRelativeState(ship, t);
    const alt = length(st.r) - body.radius;
    const descending = (st.r.x * st.v.x + st.r.y * st.v.y + st.r.z * st.v.z) < 0;
    // Guard: only if the ship is near the interface and falling (orbit unchanged).
    if (!descending || alt < 0 || alt > 1.3 * entryInterfaceAlt(body)) return;
    const leg = buildEntryLeg(body, st.r, st.v, t, NOMINAL_ENTRY_VEHICLE);
    if (!leg) return;
    ship.entryLeg = leg;
    ship.mode = "coast";
    ship.elements = undefined;
    ship.r = undefined;
    ship.v = undefined;
    ship.epoch = t;
    this.events.push({ t: leg.tEnd, kind: "entry-end", entityId: ship.id });
  }

  /**
   * Finalize an in-sim entry at its end. A landed pass parks the ship on the surface
   * (co-rotating, like landShip); a captured or skip-out pass settles onto the
   * post-pass osculating orbit from the body-relative exit state. The leg is cleared.
   */
  private finishEntry(ship: Ship): void {
    const leg = ship.entryLeg;
    if (!leg) return;
    const body = BODY_BY_ID.get(leg.bodyId);
    if (!body) { ship.entryLeg = undefined; return; }
    const t = this.world.t;
    ship.entryLeg = undefined;
    if (leg.outcome === "crashed") {
      // A lethal lithobraking impact (too steep / too thin an atmosphere to brake to a
      // survivable touchdown). Seat the body-relative impact state so crashShip reads
      // the site off the osculating conic, then destroy the ship at the surface.
      ship.mode = "coast";
      ship.elements = stateToElements(leg.exitR, leg.exitV, body.mu);
      ship.r = undefined;
      ship.v = undefined;
      ship.epoch = t;
      this.crashShip(ship, t);
      return;
    }
    if (leg.outcome === "landed") {
      // Store the touchdown site as a body-fixed direction (un-tilt + de-rotate by Ω·t),
      // so the ship co-rotates with the surface — identical to landShip.
      const dir = normalize(leg.exitR);
      ship.landed = { bodyId: body.id, surfaceDir: inertialDirToSurface(body, dir, t) };
      ship.mode = "coast";
      ship.elements = undefined;
      ship.r = undefined;
      ship.v = undefined;
      ship.epoch = t;
    } else {
      // Captured (now bound) or skip-out (still unbound): continue on the osculating
      // orbit defined by the body-relative exit state.
      const el = stateToElements(leg.exitR, leg.exitV, body.mu);
      ship.elements = el;
      ship.epoch = t;
      ship.mode = "coast";

      // Aerocapture follow-up: the captured ellipse's periapsis is still inside the
      // atmosphere, so trim it up at the FIRST apoapsis (before the ship falls back
      // in). A skip-out failed to capture — schedule its SOI egress so it leaves.
      const tr = ship.transfer;
      if (tr && tr.aeroPeriAlt !== undefined && !tr.arrived) {
        if (leg.outcome === "captured" && el.e < 1) {
          const n = meanMotion(el.a, body.mu);
          const dtApo = (((Math.PI - el.M) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / n;
          this.events.push({ t: t + dtApo, kind: "aero-trim", entityId: ship.id });
        } else if (leg.outcome === "skip-out") {
          this.scheduleSoiEgress(ship, body, el, t);
        }
      }
    }
  }

  /**
   * Finalize a powered ASCENT (`launch-arrive`): the ship reaches its parking orbit. The
   * orbit is the leg's pinned exit state (a clean circular insertion at the arc's downrange
   * end), so the in-flight arc and the post-arc coast are continuous. The leg is cleared.
   */
  private arriveLaunch(ship: Ship): void {
    const leg = ship.launchLeg;
    if (!leg) return;
    const body = BODY_BY_ID.get(leg.bodyId);
    ship.launchLeg = undefined;
    if (!body) return;
    ship.elements = stateToElements(leg.exitR, leg.exitV, body.mu);
    ship.epoch = this.world.t;
    ship.mode = "coast";
    ship.r = undefined;
    ship.v = undefined;
  }

  /**
   * Finalize a powered DESCENT (`land-arrive`): the ship touches down. The touchdown site is
   * the leg's pinned exit position, stored as a body-fixed direction (de-rotate by Ω·t) so the
   * ship co-rotates with the surface — identical to landShip's snap. The leg is cleared.
   */
  private arriveLand(ship: Ship): void {
    const leg = ship.descentLeg;
    if (!leg) return;
    const body = BODY_BY_ID.get(leg.bodyId);
    ship.descentLeg = undefined;
    if (!body) return;
    const t = this.world.t;
    const dir = normalize(leg.exitR);
    ship.landed = { bodyId: body.id, surfaceDir: inertialDirToSurface(body, dir, t) };
    ship.mode = "coast";
    ship.elements = undefined;
    ship.r = undefined;
    ship.v = undefined;
    ship.epoch = t;
  }

  /**
   * Raise periapsis out of the atmosphere at the first apoapsis after an aerocapture
   * drag pass — the small trim burn that turns the grazing captured ellipse into a
   * clean parking orbit, completing the arrival. Mirrors captureAtPeriapsis, but at
   * apoapsis (a prograde burn there raises periapsis).
   */
  private trimAerocapture(ship: Ship): void {
    const tr = ship.transfer;
    if (!tr || tr.arrived || tr.aeroPeriAlt === undefined) return;
    const body = BODY_BY_ID.get(ship.primary);
    if (!body) return;
    const t = this.world.t;
    const el = shipOsculatingElements(ship, t);
    if (el.e >= 1) return; // not bound (shouldn't happen for a captured pass)
    const mu = body.mu;
    const ra = el.a * (1 + el.e); // apoapsis radius (the ship is here now)
    const rpTarget = body.radius + DEFAULT_CAPTURE_ALT;
    if (rpTarget >= ra) { tr.arrived = true; tr.dvArrive = 0; return; } // already high enough
    const aNew = (ra + rpTarget) / 2;
    const trimDv = visVivaSpeed(mu, ra, aNew) - visVivaSpeed(mu, ra, el.a); // prograde, > 0
    applyImpulsiveDv(ship, trimDv); // affordable by construction (tiny); proceed regardless
    // Rebuild the orbit sharing this apoapsis (position + prograde direction continuous).
    ship.elements = {
      a: aNew, e: (ra - rpTarget) / (ra + rpTarget),
      i: el.i, Omega: el.Omega, omega: el.omega, M: Math.PI,
    };
    ship.epoch = t;
    ship.mode = "coast";
    tr.arrived = true;
    tr.dvArrive = trimDv;
    this.maybeChainMoonLeg(ship, tr);
  }

  /** Schedule the SOI egress of a ship on a target-relative conic `el` at time `t`
   *  (reuses enterSoi's geometric time-to-egress for an inbound or outbound arc). */
  private scheduleSoiEgress(ship: Ship, target: BodyDef, el: { a: number; e: number; M: number }, t: number): void {
    const parentMu = target.parent ? BODY_BY_ID.get(target.parent)!.mu : MU_SUN;
    const rSoi = soiRadius(bodyElements(target, t)!.a, target.mu, parentMu);
    const n = meanMotion(el.a, target.mu);
    let dt = 0;
    if (el.e < 1) {
      const cosE = Math.max(-1, Math.min(1, (1 - rSoi / el.a) / el.e));
      const E = Math.acos(cosE);
      dt = ((2 * (E - el.e * Math.sin(E))) / n) - (el.M >= 0 ? el.M / n : 0);
    } else {
      const coshF = Math.max(1, (1 - rSoi / el.a) / el.e);
      const F = Math.acosh(coshF);
      dt = ((2 * (el.e * Math.sinh(F) - F)) / n) - (el.M >= 0 ? el.M / n : 0);
    }
    this.events.push({ t: t + Math.max(0, dt), kind: "soi-exit", entityId: ship.id });
  }
}
