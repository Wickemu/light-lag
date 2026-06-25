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
 *  - Something thrusting → we sub-step on a FIXED ABSOLUTE-TIME GRID (so the
 *    partition is independent of how the caller chunked dtSim — step(A) then
 *    step(B) gives the same result as step(A+B), which is what determinism and
 *    save/load rely on), and the warp is clamped ("time slows near burns").
 *    Within a sub-step, the discrete burn events — reaching the target Δv and a
 *    tank running dry — are detected analytically and the integration is split
 *    EXACTLY at them, so the engine never overshoots the commanded Δv and a
 *    stage transition never leaves a thrust gap or burns phantom propellant.
 */

import { type WorldState, type Ship } from "./world.ts";
import { EventQueue, WARP_LEVELS, type SimEvent } from "./time.ts";
import { rk4 } from "./math/integrators.ts";
import { orbitFrame, hyperbolicBurnDv, periapsisRadius } from "./orbit.ts";
import { activeStage, applyImpulsiveDv, shipOsculatingElements, shipRelativeState } from "./ships.ts";
import { exhaustVelocity } from "./propulsion.ts";
import { stateToElements, meanMotion } from "./math/kepler.ts";
import { bodyState } from "./ephemeris.ts";
import { aimArrival } from "./maneuver/arrival.ts";
import { BODY_BY_ID, MU_SUN, DEFAULT_CAPTURE_ALT } from "./constants.ts";
import { type Vec3, sub, scale, normalize, length, cross } from "./math/vec3.ts";

/** Sub-step grid spacing during powered flight (s). LEO period is ~5500 s, so a
 *  2 s grid keeps RK4 trajectory error negligible. */
const MAX_THRUST_STEP = 2;
/** While any ship is thrusting, the warp is capped so burns stay watchable and
 *  the sub-step count per frame stays bounded. */
const THRUST_WARP_CAP = 60;

export class Simulation {
  readonly world: WorldState;
  readonly events = new EventQueue();
  warpIndex = 0;
  paused = false;

  constructor(world: WorldState) {
    this.world = world;
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

    // Proper time advances with coordinate time for every ship (τ ≡ t in-system;
    // a relativistic layer would later scale this by 1/γ).
    for (const s of this.world.ships.values()) s.tau += dtSim;

    const target = this.world.t + dtSim;

    if (!this.anyThrust()) {
      // Analytic fast path: coasting bodies/ships need no stepping.
      this.drainEvents(target);
      this.world.t = target;
      return;
    }

    // Powered flight: sub-step on a fixed absolute-time grid for determinism.
    while (this.world.t < target - 1e-9) {
      const gridNext = (Math.floor(this.world.t / MAX_THRUST_STEP) + 1) * MAX_THRUST_STEP;
      const dt = Math.min(gridNext, target) - this.world.t;
      const t0 = this.world.t;
      for (const ship of this.world.ships.values()) {
        if (ship.mode === "thrust") this.advanceThrustShip(ship, t0, dt);
      }
      this.world.t = t0 + dt;
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

      const mu = BODY_BY_ID.get(ship.primary)!.mu;
      const ve = exhaustVelocity(stage.isp);
      const thrust = stage.thrust;
      const mdot = thrust / ve;

      // Mass carried but not part of the active tank: payload + active dry +
      // every upper stage (dry + propellant). m0 is the mass at segment start.
      let carried = ship.payloadMass + stage.dryMass;
      for (let i = ship.activeStage + 1; i < ship.stages.length; i++) {
        const up = ship.stages[i]!;
        carried += up.dryMass + up.propMass;
      }
      const m0 = carried + stage.propMass;

      const dvRem = burn.dvTarget - burn.dvDone;
      if (dvRem <= 1e-9) {
        this.endBurn(ship, t0 + elapsed);
        return;
      }

      // Analytic event times within the remaining interval (ṁ is constant).
      const tauCut = (m0 / mdot) * (1 - Math.exp(-dvRem / ve)); // reach target Δv
      const tauEmpty = stage.propMass / mdot; // tank runs dry
      let seg = dt - elapsed;
      let event: "none" | "cut" | "empty" = "none";
      if (tauCut < seg) { seg = tauCut; event = "cut"; }
      if (tauEmpty < seg) { seg = tauEmpty; event = "empty"; }

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
        const m = carried + Math.max(prop, 0);
        const rmag = Math.hypot(r.x, r.y, r.z);
        const gfac = -mu / (rmag * rmag * rmag);
        const dir = dirFor(r, v);
        const at = thrust / m;
        return [
          v.x, v.y, v.z,
          r.x * gfac + dir.x * at,
          r.y * gfac + dir.y * at,
          r.z * gfac + dir.z * at,
          -mdot,
        ];
      };

      const y0 = [ship.r.x, ship.r.y, ship.r.z, ship.v.x, ship.v.y, ship.v.z, stage.propMass];
      const y1 = rk4(y0, t0 + elapsed, seg, deriv);
      ship.r = { x: y1[0]!, y: y1[1]!, z: y1[2]! };
      ship.v = { x: y1[3]!, y: y1[4]!, z: y1[5]! };

      // Rocket-equation quantities advanced analytically so events land exactly.
      stage.propMass = Math.max(stage.propMass - mdot * seg, 0);
      burn.dvDone += ve * Math.log(m0 / (m0 - mdot * seg));
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
    const ship = ev.entityId ? this.world.ships.get(ev.entityId) : undefined;
    if (!ship) return;
    switch (ev.kind) {
      case "transfer-depart": this.executeDeparture(ship, ev.t); break;
      case "soi-crossing": this.enterSoi(ship); break;
      case "capture": this.captureAtPeriapsis(ship); break;
      default: break;
    }
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
    const depState = bodyState(depBody, t);
    const rCapture = target.radius + DEFAULT_CAPTURE_ALT;
    const aim = aimArrival(depBody, target, t, tr.tArrive, rCapture);
    tr.departed = true;
    if (!aim) return; // degenerate geometry; abort the injection

    // Oberth-aware injection from the current parking orbit (see Phase-3 audit).
    const vInf = length(sub(aim.v1, depState.v));
    const parkEl = shipOsculatingElements(ship, t);
    const rPark = periapsisRadius(parkEl.a, parkEl.e);
    const dv = hyperbolicBurnDv(vInf, depBody.mu, rPark);
    if (!applyImpulsiveDv(ship, dv)) return; // can't afford injection — stay in parking orbit
    tr.dvDepart = dv;

    // Onto the heliocentric transfer toward the aim point.
    ship.primary = "sun";
    ship.mode = "coast";
    ship.r = undefined;
    ship.v = undefined;
    ship.elements = stateToElements(depState.r, aim.v1, MU_SUN);
    ship.epoch = t;

    this.events.push({ t: aim.tSoi, kind: "soi-crossing", entityId: ship.id });
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

    // Only an inbound hyperbola (e > 1, pre-periapsis) can be captured at a
    // future periapsis. Anything else is an off-nominal arrival: leave the ship
    // on its real relative trajectory (a flyby) rather than fake a capture.
    const el = ship.elements;
    if (el.e <= 1 || el.M >= 0) return;

    // Schedule the capture at periapsis (time-to-periapsis = −M/n for M < 0).
    const n = meanMotion(el.a, target.mu);
    const tPeri = t + -el.M / n;
    this.events.push({ t: tPeri, kind: "capture", entityId: ship.id });
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
}
