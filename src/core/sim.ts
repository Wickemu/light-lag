/**
 * The simulation orchestrator — the spine.
 *
 * Owns the world, the event queue, and the time-warp state. Each render frame
 * the app calls advanceReal(dtReal); the sim converts that to sim-seconds via
 * the current warp and advances the world, stopping at each scheduled event in
 * strict time order. step(dtSim) is deterministic in its argument — events fire
 * at their exact scheduled times — which is what save/load and reproducibility
 * rely on. advanceReal additionally caps a single frame's real dt (so a
 * backgrounded tab doesn't lurch the clock forward); that capped time is
 * intentionally forfeited rather than replayed.
 *
 * Two regimes:
 *  - Nothing thrusting → bodies and ships are analytic functions of t, so the
 *    clock simply jumps to the target (exact at any warp).
 *  - Something thrusting → we sub-step at a small fixed dt so RK4 stays accurate,
 *    and the warp is clamped ("time slows near burns") so a million-× warp can't
 *    hand the integrator a month-long step.
 */

import { type WorldState, type Ship } from "./world.ts";
import { EventQueue, WARP_LEVELS, type SimEvent } from "./time.ts";
import { rk4 } from "./math/integrators.ts";
import { orbitFrame } from "./orbit.ts";
import { activeStage } from "./ships.ts";
import { exhaustVelocity } from "./propulsion.ts";
import { stateToElements } from "./math/kepler.ts";
import { BODY_BY_ID } from "./constants.ts";
import { type Vec3 } from "./math/vec3.ts";

/** Largest sub-step handed to RK4 during powered flight (s). LEO period is
 *  ~5500 s, so 2 s keeps integration error negligible. */
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
    const target = this.world.t + dtSim;

    if (!this.anyThrust()) {
      // Analytic fast path: coasting bodies/ships need no stepping.
      this.drainEvents(target);
      this.world.t = target;
      return;
    }

    // Powered flight: sub-step so the integrator sees a small dt.
    let remaining = dtSim;
    while (remaining > 1e-9) {
      const dt = Math.min(remaining, MAX_THRUST_STEP);
      this.integrateThrustShips(dt);
      this.world.t += dt;
      remaining -= dt;
      this.drainEvents(this.world.t);
    }
  }

  private drainEvents(tMax: number): void {
    for (;;) {
      const ev = this.events.popDue(tMax);
      if (!ev) break;
      this.world.t = ev.t;
      this.handleEvent(ev);
    }
  }

  private integrateThrustShips(dt: number): void {
    for (const ship of this.world.ships.values()) {
      if (ship.mode === "thrust") this.advanceThrustShip(ship, dt);
    }
  }

  /**
   * Integrate one ship under gravity + thrust for dt seconds via RK4, consuming
   * propellant honestly, staging when a tank empties, and ending the burn when
   * the target Δv is reached or the ship runs dry.
   */
  private advanceThrustShip(ship: Ship, dt: number): void {
    const burn = ship.burn;
    const stage = activeStage(ship);
    if (!burn || !stage || !ship.r || !ship.v) {
      this.endBurn(ship);
      return;
    }

    const mu = BODY_BY_ID.get(ship.primary)!.mu;
    const ve = exhaustVelocity(stage.isp);
    const thrust = stage.thrust;

    // Mass carried but not part of the active stage's propellant: payload plus
    // every stage above the active one, plus the active stage's own dry mass.
    let carried = ship.payloadMass + stage.dryMass;
    for (let i = ship.activeStage + 1; i < ship.stages.length; i++) {
      const up = ship.stages[i]!;
      carried += up.dryMass + up.propMass;
    }

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

    // State: [rx,ry,rz, vx,vy,vz, propellant, dvDelivered]
    const deriv = (_t: number, y: number[]): number[] => {
      const r: Vec3 = { x: y[0]!, y: y[1]!, z: y[2]! };
      const v: Vec3 = { x: y[3]!, y: y[4]!, z: y[5]! };
      const prop = y[6]!;
      const dvDone = y[7]!;
      const m = carried + Math.max(prop, 0);
      const rmag = Math.hypot(r.x, r.y, r.z);
      const gfac = -mu / (rmag * rmag * rmag);
      let ax = r.x * gfac, ay = r.y * gfac, az = r.z * gfac;
      let dprop = 0, ddv = 0;
      if (prop > 1e-9 && dvDone < burn.dvTarget) {
        const dir = dirFor(r, v);
        const at = thrust / m;
        ax += dir.x * at;
        ay += dir.y * at;
        az += dir.z * at;
        dprop = -thrust / ve;
        ddv = at;
      }
      return [v.x, v.y, v.z, ax, ay, az, dprop, ddv];
    };

    const y0 = [ship.r.x, ship.r.y, ship.r.z, ship.v.x, ship.v.y, ship.v.z, stage.propMass, burn.dvDone];
    const y1 = rk4(y0, this.world.t, dt, deriv);

    ship.r = { x: y1[0]!, y: y1[1]!, z: y1[2]! };
    ship.v = { x: y1[3]!, y: y1[4]!, z: y1[5]! };
    stage.propMass = Math.max(y1[6]!, 0);
    burn.dvDone = y1[7]!;
    ship.tau += dt;

    if (burn.dvDone >= burn.dvTarget - 1e-9) {
      this.endBurn(ship);
    } else if (stage.propMass <= 1e-6) {
      // Tank empty: drop this stage and continue with the next, if any.
      ship.activeStage += 1;
      if (!activeStage(ship)) this.endBurn(ship); // out of propellant
    }
  }

  /** Finish a burn: freeze the achieved orbit as osculating elements and coast. */
  private endBurn(ship: Ship): void {
    if (ship.r && ship.v) {
      const mu = BODY_BY_ID.get(ship.primary)!.mu;
      ship.elements = stateToElements(ship.r, ship.v, mu);
      ship.epoch = this.world.t;
    }
    ship.mode = "coast";
    ship.burn = undefined;
  }

  /** Event dispatch. Scheduled burns / SOI / messages attach here in later phases. */
  private handleEvent(_ev: SimEvent): void {
    // Intentionally empty until later phases.
  }
}
