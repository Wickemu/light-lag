/**
 * Persistent propellant depot stations — the Phase-7 mass economy's fixed
 * infrastructure. Where `refuel.ts` moves propellant ship↔ship, a depot is a
 * standing station that BANKS propellant: a ship docks and loads (fills the depot
 * from its own tanks) or unloads (draws the depot down to top itself up). A depot is
 * a single scalar tank — it never burns, so it carries no stages — living on a
 * `Station.depot` field and riding the station's fixed conic about its primary.
 *
 * The same single rule holds: nothing is hand-waved. Propellant is mass; every
 * transfer CONSERVES it (the depot gains exactly what the ship loses, and vice
 * versa) and is capacity-capped at both ends — a ship's tanks fill only to their
 * as-built `stageCapacity`, a depot only to its `propCapacity`. Docking is gated on a
 * TRUE RENDEZVOUS in the station's primary frame (`stationDockState`), reusing the
 * refuel proximity gates. The operations here are pure mutations of the records (like
 * `applyImpulsiveDv` / `transferProp`); the player-facing command wrappers, the
 * rendezvous search, and depot deployment live in app/commands.ts.
 */

import { type Station, type Ship } from "./world.ts";
import { type State, elementsToState } from "./math/kepler.ts";
import { bodyState } from "./ephemeris.ts";
import { BODY_BY_ID } from "./constants.ts";
import { shipWorldState, coastConic } from "./ships.ts";
import {
  type DockState,
  DOCK_DISTANCE,
  DOCK_REL_SPEED,
  drainShip,
  shipPropAvailable,
  shipPropHeadroom,
} from "./refuel.ts";
import { fillFromISRU } from "./isru.ts";
import { add, sub, length } from "./math/vec3.ts";

/** A depot's tank (the non-null shape of `Station.depot`). */
type Depot = NonNullable<Station["depot"]>;

/**
 * Absolute (root-frame) state of a station at time `t`: its fixed conic about its
 * primary plus the primary's ephemeris. The station never thrusts, so this is simply
 * the `shipWorldState` coast case for a body always on its `elements`.
 */
export function stationWorldState(station: Station, t: number): State {
  const body = BODY_BY_ID.get(station.primary)!;
  // Propagate the depot along its orbit with the same Kepler + secular-J2 model a ship
  // coasts under (station-kept ⇒ no drag decay), so a co-orbital ship stays docked.
  const el = coastConic(station.elements, body.mu, t - (station.epoch ?? 0), body, undefined, true);
  const rel = elementsToState(el, body.mu);
  const primary = bodyState(body, t);
  return { r: add(primary.r, rel.r), v: add(primary.v, rel.v) };
}

/**
 * Relative range and closing speed of a ship and a station, in their shared primary's
 * frame (its motion cancels exactly). Reuses the refuel dock gates; callers gate on a
 * shared primary before treating `docked` as meaningful.
 */
export function stationDockState(ship: Ship, station: Station, t: number): DockState {
  const ss = shipWorldState(ship, t);
  const st = stationWorldState(station, t);
  const distance = length(sub(ss.r, st.r));
  const relSpeed = length(sub(ss.v, st.v));
  return { distance, relSpeed, docked: distance <= DOCK_DISTANCE && relSpeed <= DOCK_REL_SPEED };
}

/** Propellant a depot can GIVE (its current fill, kg). */
export function depotAvailable(d: Depot): number {
  return d.propMass;
}

/** Free capacity a depot can ACCEPT (kg). */
export function depotHeadroom(d: Depot): number {
  return Math.max(0, d.propCapacity - d.propMass);
}

/**
 * Load ship → depot: drain up to `amount` kg from the ship's core stages into the
 * depot tank, capped by the ship's available propellant, the depot's headroom, and
 * `amount`. Mutates both the ship's stages and the depot; returns the kg moved
 * (mass-conserving — the depot gains exactly what the ship loses).
 */
export function loadDepot(ship: Ship, d: Depot, amount: number): number {
  const moved = Math.min(amount, shipPropAvailable(ship), depotHeadroom(d));
  if (moved <= 0) return 0;
  const drained = drainShip(ship, moved);
  d.propMass += drained;
  return drained;
}

/**
 * Unload depot → ship: fill the ship's core stages from the depot, capped by the
 * depot's available propellant, the ship's tank headroom, and `amount`. Mutates both;
 * returns the kg moved (the ship gains exactly what the depot loses).
 */
export function unloadDepot(ship: Ship, d: Depot, amount: number): number {
  const want = Math.min(amount, depotAvailable(d), shipPropHeadroom(ship));
  if (want <= 0) return 0;
  const added = fillFromISRU(ship, want); // fills active → tip, capacity-capped
  d.propMass -= added;
  return added;
}
