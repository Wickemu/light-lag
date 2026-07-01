/**
 * Cryogenic-propellant boil-off — the natural antagonist to refuelling and ISRU.
 *
 * Cryogens (LH₂/LOX, LCH₄/LOX) are stored far below ambient temperature, so heat
 * constantly leaks in and boils propellant away; a cryo upper stage parked for weeks
 * quietly bleeds Δv, and no amount of refuelling makes the tank a free infinite
 * reservoir. Storable hypergolics, solids, and electric (xenon) propellants do NOT
 * boil off — only a stage carrying a `Stage.boiloff` rate is affected.
 *
 * The rate is calibrated as a fraction of the stage's propellant lost per DAY at
 * 1 AU, scaled by solar flux — (AU/r)² at the ship's heliocentric distance, the same
 * 1/r² law the electric drives use — so cryo storage is much easier in the outer
 * system and harsh near the Sun. This is a first-cut solar-dominated model; planetary
 * IR / eclipse fraction, multilayer-insulation detail, the tank's surface-to-volume
 * (∝ m^⅔) dependence, and active cryocoolers are documented follow-ups.
 *
 * Boil-off is applied by the sim at recurring `boiloff-tick` events (see sim.ts): the
 * loss over a fixed window is a pure function of the ship's state at the tick, so the
 * result is CHUNK-INVARIANT (ticks fire at deterministic times regardless of how the
 * clock is stepped). Like refuel.ts / isru.ts, the mutation here is a plain Ship
 * mutator; the scheduling lives in the sim and the app layer.
 */

import { type Ship } from "./world.ts";
import { type Stage } from "./propulsion.ts";
import { AU } from "./constants.ts";

/** Boil-off tick cadence (s of sim time). Boil-off is slow (days), so a one-day
 *  window keeps the mass loss fine-grained while the per-ship event rate stays low. */
export const BOILOFF_WINDOW = 86400; // 1 day

/** The boil-off rate constant λ (per second) of a stage at heliocentric distance `r`
 *  (m): the stage's per-day-at-1-AU fraction scaled by solar flux (AU/r)². Zero for a
 *  non-cryogenic stage (no `boiloff` field) or a non-positive distance. */
export function stageBoiloffRate(stage: Stage, r: number): number {
  if (stage.boiloff === undefined || r <= 0) return 0;
  return (stage.boiloff / 86400) * (AU / r) ** 2;
}

/** Whether a ship has any cryogenic (boil-off-carrying) core stage — the gate for
 *  arming a boil-off tick and showing the readout. */
export function shipHasBoiloff(ship: Ship): boolean {
  for (let i = ship.activeStage; i < ship.stages.length; i++) {
    if (ship.stages[i]!.boiloff !== undefined) return true;
  }
  return false;
}

/**
 * Boil off `dt` seconds' worth of cryogenic propellant at heliocentric distance `r`,
 * MUTATING each core stage's `propMass` by the exponential factor exp(−λ·dt) (λ from
 * `stageBoiloffRate`). Only stages carrying a `boiloff` rate lose mass; the rest are
 * untouched. Returns the total kg boiled off. The exponential form is always positive
 * and never drives propMass below 0, so no clamp is needed.
 */
export function applyBoiloff(ship: Ship, r: number, dt: number): number {
  let lost = 0;
  for (let i = ship.activeStage; i < ship.stages.length; i++) {
    const s = ship.stages[i]!;
    const lambda = stageBoiloffRate(s, r);
    if (lambda <= 0 || s.propMass <= 0) continue;
    const kept = s.propMass * Math.exp(-lambda * dt);
    lost += s.propMass - kept;
    s.propMass = kept;
  }
  return lost;
}

export interface BoiloffStatus {
  ratePerSec: number; // kg/s boiling off right now (summed over cryo core stages)
  ratePerDay: number; // kg/day — the same rate over a day, for display
  cryoPropKg: number; // kg of cryogenic propellant currently aboard
}

/** Read-time boil-off status of a ship at heliocentric distance `r`, or null when it
 *  has no cryogenic propellant. Instantaneous rate = Σ λ·propMass over the cryo core
 *  stages. Pure — never mutates; safe to call every render frame. */
export function shipBoiloffStatus(ship: Ship, r: number): BoiloffStatus | null {
  if (!shipHasBoiloff(ship)) return null;
  let ratePerSec = 0;
  let cryoPropKg = 0;
  for (let i = ship.activeStage; i < ship.stages.length; i++) {
    const s = ship.stages[i]!;
    if (s.boiloff === undefined) continue;
    cryoPropKg += s.propMass;
    ratePerSec += stageBoiloffRate(s, r) * s.propMass;
  }
  return { ratePerSec, ratePerDay: ratePerSec * 86400, cryoPropKg };
}
