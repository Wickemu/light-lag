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

import { type WorldState, type Ship, type ShipBurn, type ShipCommand, type BurnDir } from "./world.ts";
import { EventQueue, WARP_LEVELS, type SimEvent } from "./time.ts";
import { rk4 } from "./math/integrators.ts";
import { orbitFrame, hyperbolicBurnDv, periapsisRadius, soiRadius, visVivaSpeed } from "./orbit.ts";
import {
  activeStage, applyImpulsiveDv, dvRemaining, shipOsculatingElements, shipRelativeState, shipWorldState,
  interstellarProperTime, spiralElements, buildEntryLeg, NOMINAL_ENTRY_VEHICLE,
} from "./ships.ts";
import { exhaustVelocity, thrustAt, lorentzFactor, boosterCount, type Stage, type Booster } from "./propulsion.ts";
import { properToCoordinateAccel } from "./math/relativity.ts";
import { stateToElements, meanMotion } from "./math/kepler.ts";
import { bodyState, bodyElements } from "./ephemeris.ts";
import { signalArrival } from "./comms.ts";
import { aimArrival } from "./maneuver/arrival.ts";
import { lambert } from "./maneuver/lambert.ts";
import { flybyManeuver } from "./maneuver/assist.ts";
import { entryInterfaceAlt, entryInterfaceCrossing } from "./maneuver/entry.ts";
import { type BodyDef, BODY_BY_ID, MU_SUN, DEFAULT_CAPTURE_ALT } from "./constants.ts";
import { type Vec3, add, sub, scale, normalize, length, cross } from "./math/vec3.ts";

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

export class Simulation {
  readonly world: WorldState;
  readonly events = new EventQueue();
  warpIndex = 0;
  paused = false;
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

    // Proper time advances with coordinate time for every ship (τ ≡ t in-system).
    // A ship on an interstellar leg ages by the DILATED proper time over the part
    // of [t, t+dt] that overlaps the leg, and by coordinate time outside it — the
    // relativistic divergence the τ field was always kept for. This telescopes
    // exactly across chunkings (it is a difference of an analytic function), so
    // determinism is preserved.
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
        // Coasting: bodies and ships are analytic — jump straight to the next event.
        this.world.t = Math.min(target, nextEvent);
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
      const y1 = rk4(y0, t0 + elapsed, seg, deriv);
      ship.r = { x: y1[0]!, y: y1[1]!, z: y1[2]! };
      ship.v = { x: y1[3]!, y: y1[4]!, z: y1[5]! };

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
      case "soi-crossing": this.enterSoi(ship); break;
      case "soi-exit": this.exitSoi(ship); break;
      case "capture": this.captureAtPeriapsis(ship); break;
      case "entry-start": this.beginEntry(ship); break;
      case "entry-end": this.finishEntry(ship); break;
      case "aero-trim": this.trimAerocapture(ship); break;
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
    if (command.type === "burn") return this.applyBurn(ship, command.dv, command.dir);
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

    // Gravity-assist mission: leg 1 aims at the FIRST flyby body (a patched-conic
    // point), and a chain of flyby-pass events handles each bend + the leg toward the
    // next flyby (or, after the last, the final target).
    if (tr.flybys && tr.flybys.length > 0 && !tr.flybys[0]!.done) {
      this.executeAssistDeparture(ship, tr, t, depBody);
      return;
    }

    const depState = bodyState(depBody, t);
    // Aerocapture aims the arrival periapsis INTO the atmosphere (aeroPeriAlt); a
    // propulsive arrival aims at the default parking altitude.
    const rCapture = target.radius + (tr.aeroPeriAlt ?? DEFAULT_CAPTURE_ALT);
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

    const t = this.world.t;
    const shipHelio = shipRelativeState(ship, t); // heliocentric (primary == sun)
    const fb = bodyState(flybyBody, t);

    // Aim the leg leaving this flyby: at the NEXT flyby body's centre (a patched-conic
    // point, via Lambert) if the chain continues, else at the final target (B-plane
    // capture aim). Either way it sets the heliocentric velocity to leave the flyby with.
    const next = tr.flybys[idx + 1];
    let v1: Vec3;
    let nextEvent: { t: number; kind: "flyby-pass" | "soi-crossing" };
    if (next) {
      const nextBody = BODY_BY_ID.get(next.bodyId);
      if (!nextBody) return;
      const nextState = bodyState(nextBody, next.tFlyby);
      const legN = lambert(shipHelio.r, nextState.r, next.tFlyby - t, MU_SUN, true);
      if (!legN) return; // re-plannable
      v1 = legN.v1;
      nextEvent = { t: next.tFlyby, kind: "flyby-pass" };
    } else {
      const target = BODY_BY_ID.get(tr.targetId);
      if (!target) return;
      const rCapture = target.radius + DEFAULT_CAPTURE_ALT;
      const aim = aimArrival(flybyBody, target, t, tr.tArrive, rCapture);
      if (!aim) return; // re-plannable
      v1 = aim.v1;
      nextEvent = { t: aim.tSoi, kind: "soi-crossing" };
    }

    const vInfIn = sub(shipHelio.v, fb.v); // body-relative excess in
    const vInfOut = sub(v1, fb.v); // body-relative excess out (next-leg departure)
    const man = flybyManeuver(vInfIn, vInfOut, flybyBody);
    if (!applyImpulsiveDv(ship, man.dvFlyby)) return; // can't afford the residual burn

    leg.done = true;
    leg.dvBurn = man.dvFlyby;
    // Continue on the next heliocentric conic from the (continuous) flyby point.
    ship.primary = "sun";
    ship.mode = "coast";
    ship.elements = stateToElements(shipHelio.r, v1, MU_SUN);
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
    const shipHelio = shipRelativeState(ship, t);
    const tgt = bodyState(target, t);
    const rRel = sub(shipHelio.r, tgt.r);
    const vRel = sub(shipHelio.v, tgt.v);

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
    const vCirc = Math.sqrt(body.mu / r);

    // True circularization impulse: target the tangential (prograde) direction
    // and take the FULL vector difference, so any residual radial component is
    // removed and the propellant charged matches the burn actually flown. (At
    // exact periapsis this equals the scalar |v| − vCirc.)
    const tHat = normalize(cross(cross(st.r, st.v), st.r));
    const targetV = scale(tHat, vCirc);
    const captureDv = length(sub(targetV, st.v));
    if (!applyImpulsiveDv(ship, captureDv)) return; // can't afford — stays on the hyperbola

    ship.elements = stateToElements(st.r, targetV, body.mu);
    ship.epoch = t;
    ship.mode = "coast";
    tr.arrived = true;
    tr.dvArrive = captureDv;
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
    if (leg.outcome === "landed") {
      // Store the touchdown site as a body-fixed direction (de-rotate by Ω·t), so the
      // ship co-rotates with the surface — identical to landShip.
      const dir = normalize(leg.exitR);
      const T = body.rotationPeriod ?? 0;
      const om = T !== 0 ? (2 * Math.PI) / T : 0;
      const c = Math.cos(-om * t), s = Math.sin(-om * t);
      ship.landed = { bodyId: body.id, surfaceDir: { x: dir.x * c - dir.y * s, y: dir.x * s + dir.y * c, z: dir.z } };
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
