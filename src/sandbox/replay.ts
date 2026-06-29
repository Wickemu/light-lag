/**
 * Replay transport for the sandbox: a scrubbable playhead over the deterministic
 * sim. Forward = step (analytic, cheap); backward = restore the nearest earlier
 * keyframe in place, then step the remainder. Keyframes are captured as you play
 * so scrubbing back is fast. Because restore + step is bit-exact, scrubbing to a
 * time always lands on the same state.
 */
import type { Simulation } from "@lightlag/engine/sim";
import { snapshot, restoreInto, type SimSnapshot } from "@lightlag/engine/scenario";

export interface ReplayOpts {
  /** Sim-seconds between auto-keyframes while playing forward (default 6 h). */
  keyframeInterval?: number;
  /** Called after any playhead move, for the UI to refresh. */
  onChange?: () => void;
}

export class ReplayController {
  active = false;
  playing = false;
  keyframeInterval: number;
  private onChange?: () => void;
  private keyframes: { t: number; snap: SimSnapshot }[] = [];
  private startT = 0;
  private maxT = 0;

  constructor(private sim: Simulation, opts: ReplayOpts = {}) {
    this.keyframeInterval = opts.keyframeInterval ?? 6 * 3600;
    this.onChange = opts.onChange;
  }

  /** First captured time (the scrub minimum). */
  get startTime(): number { return this.startT; }
  /** The playhead (current sim time). */
  get currentTime(): number { return this.sim.world.t; }
  /** Furthest time reached — the scrub maximum (grows as you play forward). */
  get maxTime(): number { return this.maxT; }

  /** Enter replay anchored at the current sim time (paused). */
  begin(): void {
    this.active = true;
    this.playing = false;
    this.startT = this.sim.world.t;
    this.maxT = this.sim.world.t;
    this.keyframes = [{ t: this.sim.world.t, snap: snapshot(this.sim) }];
    this.onChange?.();
  }

  exit(): void {
    this.active = false;
    this.playing = false;
    this.onChange?.();
  }

  setPlaying(p: boolean): void {
    this.playing = p;
    this.onChange?.();
  }

  togglePlay(): void {
    this.setPlaying(!this.playing);
  }

  /** Per-frame advance while active+playing (real dt × the sim's warp). */
  tick(dtReal: number): void {
    if (!this.active || !this.playing || dtReal <= 0) return;
    this.scrubTo(this.sim.world.t + dtReal * this.sim.warp);
  }

  /** Move the playhead to absolute sim time `t`. */
  scrubTo(t: number): void {
    if (!this.active) return;
    const target = Math.max(this.startT, t);
    if (target > this.sim.world.t) {
      this.sim.step(target - this.sim.world.t);
      this.recordKeyframe();
    } else if (target < this.sim.world.t) {
      restoreInto(this.sim, this.nearestKeyframe(target).snap);
      if (target > this.sim.world.t) this.sim.step(target - this.sim.world.t);
    }
    if (this.sim.world.t > this.maxT) this.maxT = this.sim.world.t;
    this.onChange?.();
  }

  private nearestKeyframe(t: number): { t: number; snap: SimSnapshot } {
    let best = this.keyframes[0]!;
    for (const kf of this.keyframes) if (kf.t <= t && kf.t >= best.t) best = kf;
    return best;
  }

  private recordKeyframe(): void {
    const last = this.keyframes[this.keyframes.length - 1];
    if (!last || this.sim.world.t - last.t >= this.keyframeInterval) {
      this.keyframes.push({ t: this.sim.world.t, snap: snapshot(this.sim) });
    }
  }
}
