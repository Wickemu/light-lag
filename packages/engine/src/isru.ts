/**
 * ISRU — in-situ resource utilization: mining a body's volatiles into propellant.
 *
 * The Phase-7 mass-economy thesis, in the engine's usual currency: nothing is
 * hand-waved and everything traces back to ENERGY. A landed ship on a
 * volatile-bearing body (a comet, an icy moon, ice-bearing regolith — the bodies
 * that carry a `BodyDef.isru` descriptor) can process in-situ water ice into usable
 * propellant. What it costs is energy: a body's `specificEnergyJPerKg` is the joules
 * to liberate + process one kilogram (loose cometary ice is cheap; bound lunar
 * cold-trap regolith is dear), so the production rate is simply the plant's power
 * divided by that specific energy — kg/s = W / (J/kg). Power comes from the ship's
 * own electric source (solar arrays derate as 1/r² toward the Sun, a reactor is
 * constant — the same `availablePowerW` law the electric drives use), or a modest
 * default surface plant when the ship carries no electric stage.
 *
 * Like refuel.ts, the operations here are pure mutations of the Ship record (fill
 * the tanks, capacity-capped and mass-conserving); the player-facing command
 * wrappers and the scheduled `isru-complete` finalize live in app/commands.ts and
 * sim.ts. The rate is pinned at deploy so the whole process is a SINGLE scheduled
 * mass credit — chunk-invariant, exact at any time-warp — mirroring the impulsive
 * maneuvers and the read-time legs.
 */

import { type Ship } from "./world.ts";
import { type BodyDef } from "./constants.ts";
import { type ElectricSource, availablePowerW, stageHeadroom } from "./propulsion.ts";
import { shipPropHeadroom } from "./refuel.ts";
import { shipWorldState } from "./ships.ts";
import { length } from "./math/vec3.ts";

/** Fallback ISRU plant power (W) for a ship with no electric source — a modest
 *  surface generator (RTG / small reactor scale). Constant ⇒ deterministic. */
export const DEFAULT_ISRU_PLANT_W = 5_000;

/** Whether a body carries mineable in-situ volatiles (a comet / icy moon / ice-bearing
 *  regolith). Absent ⇒ dry: no ISRU is possible there. */
export function bodyHasISRU(body: BodyDef): boolean {
  return body.isru !== undefined;
}

/**
 * Electrical power (W) dedicated to the ISRU plant, evaluated at time `t` (pinned at
 * deploy by the caller). The sum of the ship's live electric sources — each solar
 * array 1/r²-derated at the ship's heliocentric distance via `availablePowerW`, a
 * reactor constant — over the core stages (active → tip), falling back to
 * `DEFAULT_ISRU_PLANT_W` when the ship has no electric stage at all. Pure read.
 */
export function isruPowerW(ship: Ship, t: number): number {
  const r = length(shipWorldState(ship, t).r); // heliocentric distance (root frame, Sun at origin)
  let p = 0;
  for (let i = ship.activeStage; i < ship.stages.length; i++) {
    const e: ElectricSource | undefined = ship.stages[i]!.electric;
    if (e) p += availablePowerW(e, r);
  }
  return p > 0 ? p : DEFAULT_ISRU_PLANT_W;
}

/** Propellant production rate (kg/s) a ship achieves mining `body` at time `t`:
 *  plant power / the body's specific extraction energy. Zero on a dry body. */
export function isruRate(ship: Ship, body: BodyDef, t: number): number {
  if (!body.isru) return 0;
  return isruPowerW(ship, t) / body.isru.specificEnergyJPerKg;
}

/**
 * Add up to `kg` of mined propellant to a ship's tanks, filling the core stages
 * (active → tip), each capped at its as-built `stageCapacity`. Mirrors
 * `transferProp`'s receiver-fill loop, so it conserves the fill exactly and never
 * over-fills a tank. Returns the kg actually added (0 if the ship is already full or
 * `kg ≤ 0`). Mutates `stage.propMass`.
 */
export function fillFromISRU(ship: Ship, kg: number): number {
  const added = Math.min(kg, shipPropHeadroom(ship));
  if (added <= 0) return 0;
  let toFill = added;
  for (let i = ship.activeStage; i < ship.stages.length && toFill > 1e-9; i++) {
    const s = ship.stages[i]!;
    const put = Math.min(stageHeadroom(s), toFill);
    s.propMass += put;
    toFill -= put;
  }
  return added;
}

/** The propellant produced so far by an in-progress process at time `t`: the pinned
 *  rate times elapsed time, clamped to `[0, target]`. A pure function of the stored
 *  descriptor and `t` (independent of chunking) — the basis for partial credit on
 *  pre-emption and the live UI progress readout. */
export function isruProduced(p: NonNullable<Ship["isru"]>, t: number): number {
  return Math.max(0, Math.min(p.target, p.ratePerSec * (t - p.tStart)));
}

export interface ISRUStatus {
  bodyId: string;
  ratePerSec: number; // kg/s (pinned at deploy)
  producedKg: number; // kg mined so far (≤ target)
  target: number; // kg to mine in total (= tank headroom at deploy)
  fraction: number; // producedKg / target, in [0, 1]
  etaS: number; // seconds remaining until the tanks are full (0 once done)
}

/** Read-time status of a ship's in-progress mining, or null when it is not mining.
 *  Pure — never mutates state; safe to call every render frame. */
export function isruStatusOf(ship: Ship, t: number): ISRUStatus | null {
  const p = ship.isru;
  if (!p) return null;
  const producedKg = isruProduced(p, t);
  const fraction = p.target > 0 ? producedKg / p.target : 1;
  const remainingKg = Math.max(0, p.target - producedKg);
  const etaS = p.ratePerSec > 0 ? remainingKg / p.ratePerSec : Infinity;
  return { bodyId: p.bodyId, ratePerSec: p.ratePerSec, producedKg, target: p.target, fraction, etaS };
}
