/**
 * The simulation orchestrator — the spine.
 *
 * Owns the world, the event queue, and the time-warp state. Each render frame
 * the app calls advanceReal(dtReal); the sim converts that to sim-seconds via
 * the current warp and advances the world, stopping at each scheduled event in
 * strict time order so behaviour is identical regardless of frame rate or warp.
 *
 * In Phase 1 nothing is under thrust, so advancing is pure clock motion: bodies
 * are analytic functions of t (ephemeris.ts) and need no stepping. Powered
 * flight, SOI handling, and message delivery hook into the same event loop in
 * later phases.
 */

import { type WorldState } from "./world.ts";
import { EventQueue, WARP_LEVELS, type SimEvent } from "./time.ts";

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

  /** Advance the world by a real elapsed wall-clock interval (seconds). */
  advanceReal(dtReal: number): void {
    if (this.paused || dtReal <= 0) return;
    // Guard against huge dt after a tab was backgrounded.
    const clampedReal = Math.min(dtReal, 0.1);
    this.step(clampedReal * this.warp);
  }

  /** Advance sim time by dtSim seconds, firing events in order along the way. */
  step(dtSim: number): void {
    if (dtSim <= 0) return;
    const target = this.world.t + dtSim;

    for (;;) {
      const ev = this.events.popDue(target);
      if (!ev) break;
      this.world.t = ev.t;
      this.handleEvent(ev);
    }
    this.world.t = target;
  }

  /** Event dispatch. Phase 1 has no producers yet; later phases attach burn
   *  ignition/cutoff, SOI crossings, and message arrivals here. */
  private handleEvent(_ev: SimEvent): void {
    // Intentionally empty until Phase 2+.
  }
}
