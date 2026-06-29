/**
 * Scenarios, snapshots, and deterministic replay — built on the fact that the
 * engine is a pure function of (world, pending events, time).
 *
 * A live `Simulation` is fully determined by three things: its `world`
 * (serializable), its pending `events`, and its `warpIndex`. `paused` is UI-only
 * and `msgCounter` is re-derived from `world.messages` by the constructor. So a
 * complete, lossless snapshot is just those three — and because `step()` is
 * deterministic and has no wall-clock / RNG, restoring a snapshot and stepping on
 * reproduces the original run BYTE-FOR-BYTE.
 *
 * This is why we do NOT re-derive ("reschedule") the event queue from ship state:
 * the events are plain data ({t, kind, entityId, seq}); serializing them directly
 * is lossless and cannot drift from the kernel's own scheduling. The only gap the
 * old design called out — "the EventQueue isn't part of WorldState" — is closed
 * here by snapshotting the queue alongside the world.
 *
 * World codec: snapshots use a LOSSLESS world serialization (full f64), distinct
 * from `serialize.ts`'s 12-sig-fig `serializeWorld` (whose quantization exists to
 * make `hashWorld` an evaluation-order-independent determinism oracle across
 * *different* runs). For saving and resuming the SAME run we want the exact bits,
 * so restore→step equals the uninterrupted run with no quantization drift. We
 * reuse `deserializeWorld` to read it back (the on-wire shape — sorted Maps,
 * non-finite tokens — is identical; only the number precision differs).
 *
 * Pure; no DOM, no wall-clock.
 */

import { Simulation } from "./sim.ts";
import { type SimEvent } from "./time.ts";
import { type WorldState } from "./world.ts";
import { deserializeWorld } from "./serialize.ts";
import { shipOsculatingElements } from "./ships.ts";
import { apoapsisRadius, periapsisRadius } from "./orbit.ts";

// ── Lossless world serialization (full f64; reuses deserializeWorld to read) ──

/** Non-finite → the same tokens `serialize.ts` uses, so `deserializeWorld`'s
 *  reviver restores them. Finite numbers pass through at full precision. */
function nonFiniteToken(x: number): number | string {
  if (Number.isFinite(x)) return x;
  return Number.isNaN(x) ? "NaN" : x > 0 ? "Inf" : "-Inf";
}

/**
 * Serialize a world WITHOUT quantization — the exact f64 state. Maps become plain
 * objects with sorted keys (matching the canonical shape `deserializeWorld`
 * expects); non-finite values become string tokens. The result round-trips
 * bit-for-bit through `deserializeWorld`.
 */
export function serializeWorldLossless(world: WorldState): string {
  return JSON.stringify(world, (_key, value) => {
    if (value instanceof Map) {
      const o: Record<string, unknown> = {};
      for (const k of [...(value as Map<string, unknown>).keys()].sort()) {
        o[k] = (value as Map<string, unknown>).get(k);
      }
      return o;
    }
    if (typeof value === "number") return nonFiniteToken(value);
    return value;
  });
}

// ── Snapshots (the complete, lossless save unit) ──────────────────────────────

/** A complete, serializable capture of a running simulation. Restoring it and
 *  stepping reproduces the original run exactly. */
export interface SimSnapshot {
  /** Lossless world serialization (see `serializeWorldLossless`). */
  world: string;
  /** Pending events, with their insertion `seq` (so equal-time order is exact). */
  events: SimEvent[];
  /** Time-warp index at capture (presentation; restored for convenience). */
  warpIndex: number;
}

/** Capture a simulation's complete state. */
export function snapshot(sim: Simulation): SimSnapshot {
  return {
    world: serializeWorldLossless(sim.world),
    events: sim.events.snapshot(),
    warpIndex: sim.warpIndex,
  };
}

/** Rebuild a `Simulation` from a snapshot — bit-identical to the captured one.
 *  The constructor re-seeds the message-id counter from the restored messages. */
export function restore(snap: SimSnapshot): Simulation {
  const sim = new Simulation(deserializeWorld(snap.world));
  sim.events.load(snap.events);
  sim.warpIndex = snap.warpIndex;
  return sim;
}

// ── Objectives (serializable goal predicates, not closures) ───────────────────

/**
 * A goal condition, described declaratively so it round-trips through JSON and
 * stays deterministic (no embedded functions). `evaluateObjective` interprets it
 * against a world. Radii are SI metres about the ship's current primary.
 */
export type ObjectivePredicate =
  | { kind: "timeReached"; t: number }
  | { kind: "shipExists"; shipId: string }
  | { kind: "shipLost"; shipId: string }
  | { kind: "reachedBody"; shipId: string; bodyId: string }
  | { kind: "transferArrived"; shipId: string }
  | {
      kind: "orbitAchieved";
      shipId: string;
      bodyId?: string; // require the ship to be in this body's SOI
      periapsisMin?: number;
      periapsisMax?: number;
      apoapsisMin?: number;
      apoapsisMax?: number;
    };

export interface Objective {
  id: string;
  label: string;
  predicate: ObjectivePredicate;
}

/** Evaluate a single objective predicate against a world (read-only, pure). */
export function evaluateObjective(world: WorldState, pred: ObjectivePredicate): boolean {
  switch (pred.kind) {
    case "timeReached":
      return world.t >= pred.t;
    case "shipExists":
      return world.ships.has(pred.shipId);
    case "shipLost":
      return world.ships.get(pred.shipId)?.status === "lost";
    case "reachedBody": {
      const ship = world.ships.get(pred.shipId);
      return !!ship && ship.primary === pred.bodyId;
    }
    case "transferArrived":
      return world.ships.get(pred.shipId)?.transfer?.arrived === true;
    case "orbitAchieved": {
      const ship = world.ships.get(pred.shipId);
      if (!ship) return false;
      if (pred.bodyId && ship.primary !== pred.bodyId) return false;
      const el = shipOsculatingElements(ship, world.t);
      const rp = periapsisRadius(el.a, el.e);
      const ra = apoapsisRadius(el.a, el.e);
      if (pred.periapsisMin !== undefined && !(rp >= pred.periapsisMin)) return false;
      if (pred.periapsisMax !== undefined && !(rp <= pred.periapsisMax)) return false;
      if (pred.apoapsisMin !== undefined && !(ra >= pred.apoapsisMin)) return false;
      if (pred.apoapsisMax !== undefined && !(ra <= pred.apoapsisMax)) return false;
      return true;
    }
  }
}

// ── Scenario (a named snapshot + objectives) ──────────────────────────────────

/**
 * A scenario: a named starting state plus optional goals. v1 is a thin wrapper
 * around a snapshot — replaying it is `loadScenario` then stepping. (A scripted
 * timeline of injected commands is a natural v2 addition; objectives are the v1
 * gameplay hook.)
 */
export interface Scenario {
  version: 1;
  name: string;
  snapshot: SimSnapshot;
  /** Light-lag policy the scenario should run under (applied in the app/sim once
   *  the policy field exists). */
  commandPolicy?: "binding" | "informative";
  objectives?: Objective[];
}

/** Build a scenario from a live simulation. */
export function makeScenario(
  name: string,
  sim: Simulation,
  opts: { commandPolicy?: "binding" | "informative"; objectives?: Objective[] } = {},
): Scenario {
  return {
    version: 1,
    name,
    snapshot: snapshot(sim),
    ...(opts.commandPolicy ? { commandPolicy: opts.commandPolicy } : {}),
    ...(opts.objectives ? { objectives: opts.objectives } : {}),
  };
}

export function serializeScenario(s: Scenario): string {
  return JSON.stringify(s);
}

export function deserializeScenario(str: string): Scenario {
  return JSON.parse(str) as Scenario;
}

/** Load a scenario into a fresh, ready-to-step simulation. */
export function loadScenario(s: Scenario): Simulation {
  return restore(s.snapshot);
}
