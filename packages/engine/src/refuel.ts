/**
 * Orbital propellant transfer and in-orbit assembly — the SpaceX-tanker /
 * propellant-depot mechanic, and docking two craft into one larger vehicle.
 *
 * The single rule, in keeping with the rest of the engine: nothing is hand-waved.
 * Propellant is mass; transfer CONSERVES it (the donor loses exactly what the
 * receiver gains), and a receiver can only be filled to its tanks' as-built
 * CAPACITY (`stageCapacity`) — you cannot conjure Δv, only move m₀ from one hull to
 * another. Raising a ship's m₀ raises its Δv = vₑ·ln(m₀/m_f); that is the whole
 * point of refuelling in orbit instead of launching a fully-fuelled deep-space ship
 * out of a gravity well.
 *
 * A transfer (or assembly) is gated on a TRUE RENDEZVOUS: the two craft must share
 * a primary and be co-located — close in position and matched in velocity in that
 * primary's frame (`dockState`). Co-orbital craft (e.g. spawned on the same
 * orbit) satisfy this exactly; ships on different orbits must first be flown
 * together. The mass operations here are pure mutations of the Ship records (like
 * `applyImpulsiveDv`); the player-facing command wrappers and the rendezvous
 * search live in app/commands.ts.
 */

import { type Ship } from "./world.ts";
import { type Stage, stageHeadroom } from "./propulsion.ts";
import { shipWorldState } from "./ships.ts";
import { sub, length } from "./math/vec3.ts";

/** Docking proximity gates for a true rendezvous, in the shared-primary frame: the
 *  two craft must be within ~1 km and closing slower than a soft-dock approach. A
 *  pair on the SAME orbit reads exactly 0 / 0 and always passes; a pair on merely
 *  similar orbits must be flown together to within these gates first. */
export const DOCK_DISTANCE = 1000; // m
export const DOCK_REL_SPEED = 2; // m/s

export interface DockState {
  distance: number; // m — relative position magnitude in the primary's frame
  relSpeed: number; // m/s — relative velocity magnitude (closing speed)
  docked: boolean; // within BOTH gates
}

/**
 * Relative range and closing speed of two ships. Computed from their absolute
 * (root-frame) states, so when they share a primary its own motion cancels exactly
 * and the result is the body-relative separation; callers gate on a shared primary
 * before treating `docked` as meaningful.
 */
export function dockState(a: Ship, b: Ship, t: number): DockState {
  const sa = shipWorldState(a, t);
  const sb = shipWorldState(b, t);
  const distance = length(sub(sa.r, sb.r));
  const relSpeed = length(sub(sa.v, sb.v));
  return { distance, relSpeed, docked: distance <= DOCK_DISTANCE && relSpeed <= DOCK_REL_SPEED };
}

/** Whether a ship is free to dock: a live ship simply coasting in its SOI — not
 *  lost, not landed, not thrusting, and not committed to any in-progress leg
 *  (transfer / interstellar / spiral / entry / powered ascent or descent). */
export function isDockable(ship: Ship): boolean {
  return ship.status !== "lost"
    && ship.mode === "coast"
    && !ship.landed
    && !ship.transfer
    && !ship.interstellarLeg
    && !ship.spiral
    && !ship.entryLeg
    && !ship.launchLeg
    && !ship.descentLeg;
}

/** Transferable propellant a ship can GIVE — the core-stage propellant from the
 *  active stage upward (strap-on boosters are launch hardware, never refuelled). */
export function shipPropAvailable(ship: Ship): number {
  let m = 0;
  for (let i = ship.activeStage; i < ship.stages.length; i++) m += ship.stages[i]!.propMass;
  return m;
}

/** Free tank headroom a ship can ACCEPT — summed over the same core stages. */
export function shipPropHeadroom(ship: Ship): number {
  let m = 0;
  for (let i = ship.activeStage; i < ship.stages.length; i++) m += stageHeadroom(ship.stages[i]!);
  return m;
}

/**
 * Move up to `amount` kg of propellant from `donor` to `receiver`, draining the
 * donor's core stages (active → up) and filling the receiver's core stages (active
 * → up, each capped at `stageCapacity`). The moved mass is the minimum of what's
 * requested, what the donor has, and what the receiver can hold — so it conserves
 * total propellant exactly and never over-fills a tank. Mutates both ships' stage
 * `propMass`; returns the kg actually transferred (0 if nothing can move).
 */
export function transferProp(donor: Ship, receiver: Ship, amount: number): number {
  const moved = Math.min(amount, shipPropAvailable(donor), shipPropHeadroom(receiver));
  if (moved <= 0) return 0;

  let toDrain = moved;
  for (let i = donor.activeStage; i < donor.stages.length && toDrain > 1e-9; i++) {
    const s = donor.stages[i]!;
    const take = Math.min(s.propMass, toDrain);
    s.propMass -= take;
    toDrain -= take;
  }

  let toFill = moved;
  for (let i = receiver.activeStage; i < receiver.stages.length && toFill > 1e-9; i++) {
    const s = receiver.stages[i]!;
    const put = Math.min(stageHeadroom(s), toFill);
    s.propMass += put;
    toFill -= put;
  }
  return moved;
}

/** Deep-copy a stage (and its boosters) so a merged stack never aliases the stage
 *  objects of the ship it was assembled from. */
function cloneStage(s: Stage): Stage {
  return { ...s, boosters: s.boosters?.map((b) => ({ ...b })) };
}

/**
 * In-orbit construction: dock-merge `add` into `base`, MUTATING `base` into the
 * combined vehicle (the caller deletes `add`). The base keeps its identity, primary,
 * and orbit; its remaining stages fire first and the added ship's remaining stages
 * stack ON TOP as upper stages, with the two payload masses summed. Mass is
 * conserved — the merged ship's wet mass equals the sum of the two ships' current
 * masses — and Δv is recomputed from the new stack by the standard budget. Spent
 * (already-dropped) stages on either ship are not carried over.
 */
export function mergeStacks(base: Ship, add: Ship): void {
  const baseRemaining = base.stages.slice(base.activeStage).map(cloneStage);
  const addRemaining = add.stages.slice(add.activeStage).map(cloneStage);
  base.stages = [...baseRemaining, ...addRemaining];
  base.activeStage = 0;
  base.payloadMass += add.payloadMass;
}
