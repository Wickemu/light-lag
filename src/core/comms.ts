/**
 * Light-lag: the defining constraint of the whole game.
 *
 * No signal — command or telemetry — travels faster than c. So you never see
 * the present and you never directly control the distant. The two primitives:
 *
 *  - signalArrival: when a signal emitted now from here reaches a moving target
 *    (light has to chase where the target WILL be).
 *  - retardedTime: the past instant whose light is reaching an observer now, so
 *    the state you actually know of a distant object is its retarded state.
 *
 * Both solve a light-cone intersection by fixed-point iteration, which converges
 * in a couple of steps because in-system speeds are << c. Pure SI; the engine
 * knows about propagation delay, not about what any particular message means.
 */

import { C } from "./constants.ts";
import { type Vec3, distance } from "./math/vec3.ts";

/** One-way light-time (s) between two points. */
export function lightTime(a: Vec3, b: Vec3): number {
  return distance(a, b) / C;
}

/**
 * Time at which a signal emitted at `tEmit` from the fixed point `fromPos`
 * catches the moving target `posFn`. Solves t = tEmit + |posFn(t) − fromPos|/c.
 */
export function signalArrival(fromPos: Vec3, posFn: (t: number) => Vec3, tEmit: number): number {
  let t = tEmit + lightTime(fromPos, posFn(tEmit));
  for (let i = 0; i < 64; i++) {
    const next = tEmit + lightTime(fromPos, posFn(t));
    if (Math.abs(next - t) < 1e-3) return next;
    t = next;
  }
  return t;
}

/**
 * The retarded time: the past instant whose light reaches `obsPos` at time `t`.
 * Solves tRet = t − |posFn(tRet) − obsPos|/c. The observer's *known* state of
 * the target is the target's state at this retarded time.
 */
export function retardedTime(obsPos: Vec3, posFn: (t: number) => Vec3, t: number): number {
  let tRet = t - lightTime(obsPos, posFn(t));
  for (let i = 0; i < 64; i++) {
    const next = t - lightTime(obsPos, posFn(tRet));
    if (Math.abs(next - tRet) < 1e-3) return next;
    tRet = next;
  }
  return tRet;
}
