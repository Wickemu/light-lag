/**
 * Canonical, deterministic serialization of the world — the basis of the
 * golden-state determinism guarantee (and the foundation a Phase-8 save/load
 * will build on).
 *
 * Two problems it solves:
 *  1. `WorldState` holds JS `Map`s, which `JSON.stringify` does not serialize.
 *     We convert them to plain objects with keys inserted in SORTED order, so
 *     the output is independent of Map iteration/insertion history.
 *  2. Floating-point results that are mathematically equal can differ in the
 *     last ULP depending on evaluation order. We QUANTIZE every number to 12
 *     significant figures — far below any physical tolerance, above last-ULP /
 *     evaluation-order noise — so a state that is genuinely the same hashes
 *     identically. `q` is idempotent, so re-serializing a deserialized world is
 *     stable (and non-finite values round-trip via the reviver in deserialize).
 *
 * Scope of the chunk-invariance guarantee: two runs that reach the SAME physical
 * state hash identically. That makes hashWorld a determinism oracle across
 * arbitrary time-chunkings ONLY in the analytic/impulsive regime (coast +
 * impulsive maneuvers are exact regardless of chunking — see the golden
 * scenario). It is NOT an oracle across different chunkings of an active
 * finite-thrust burn: RK4 truncation makes those states differ by ~metres, which
 * is many quanta, so they are legitimately different states and hash differently.
 *
 * Pure; depends only on world types.
 */

import {
  type WorldState, type Ship, type Station, type Maneuver,
  type MessageInFlight, type ShipBurn, type ShipTransfer, type ShipCommand,
} from "./world.ts";
import { type Stage } from "./propulsion.ts";
import { type Vec3 } from "./math/vec3.ts";
import { type KeplerElements } from "./math/kepler.ts";

/** Quantize a number to 12 significant figures, canonicalizing −0 and the
 *  non-finite tokens. Idempotent. */
function q(x: number): number | string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "NaN" : x > 0 ? "Inf" : "-Inf";
  if (x === 0) return 0; // collapse −0
  return Number(x.toPrecision(12));
}

function qv(v: Vec3): { x: number | string; y: number | string; z: number | string } {
  return { x: q(v.x), y: q(v.y), z: q(v.z) };
}

function qEl(el: KeplerElements) {
  return { a: q(el.a), e: q(el.e), i: q(el.i), Omega: q(el.Omega), omega: q(el.omega), M: q(el.M) };
}

function qStage(s: Stage) {
  return { name: s.name, dryMass: q(s.dryMass), propMass: q(s.propMass), isp: q(s.isp), thrust: q(s.thrust) };
}

function qBurn(b: ShipBurn) {
  return { dir: b.dir, dvTarget: q(b.dvTarget), dvDone: q(b.dvDone) };
}

function qTransfer(t: ShipTransfer) {
  return {
    targetId: t.targetId, tDepart: q(t.tDepart), tArrive: q(t.tArrive),
    dvDepart: q(t.dvDepart), dvArrive: q(t.dvArrive),
    departed: t.departed, inSoi: t.inSoi, arrived: t.arrived,
  };
}

function qShip(s: Ship): Record<string, unknown> {
  // Build in a FIXED field order; omit absent optionals entirely so two ships in
  // the same logical state serialize identically.
  const o: Record<string, unknown> = {
    id: s.id, name: s.name, primary: s.primary, mode: s.mode,
    payloadMass: q(s.payloadMass), activeStage: s.activeStage, tau: q(s.tau),
  };
  if (s.epoch !== undefined) o.epoch = q(s.epoch);
  if (s.elements) o.elements = qEl(s.elements);
  if (s.r) o.r = qv(s.r);
  if (s.v) o.v = qv(s.v);
  if (s.burn) o.burn = qBurn(s.burn);
  if (s.transfer) o.transfer = qTransfer(s.transfer);
  o.stages = s.stages.map(qStage);
  return o;
}

function qStation(s: Station) {
  return { id: s.id, name: s.name, primary: s.primary, elements: qEl(s.elements) };
}

function qManeuver(m: Maneuver) {
  return { id: m.id, shipId: m.shipId, tIgnite: q(m.tIgnite), executed: m.executed };
}

function qCommand(c: ShipCommand) {
  return { type: c.type, dv: q(c.dv), dir: c.dir };
}

function qMessage(m: MessageInFlight): Record<string, unknown> {
  const o: Record<string, unknown> = {
    id: m.id, kind: m.kind, fromPos: qv(m.fromPos), toPos: qv(m.toPos),
    targetId: m.targetId, tEmit: q(m.tEmit), tArrive: q(m.tArrive), label: m.label,
  };
  if (m.command) o.command = qCommand(m.command);
  return o;
}

/** Map → plain object with keys inserted in sorted order (deterministic). */
function sortedMap<V>(map: Map<string, V>, fn: (v: V) => unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [...map.keys()].sort()) out[k] = fn(map.get(k)!);
  return out;
}

/** A canonical plain-object view of the world: sorted maps, quantized numbers,
 *  fixed key order, optionals omitted. JSON.stringify of this is deterministic. */
export function canonicalizeWorld(world: WorldState): Record<string, unknown> {
  return {
    t: q(world.t),
    seed: world.seed,
    controlNode: world.controlNode,
    ships: sortedMap(world.ships, qShip),
    stations: sortedMap(world.stations, qStation),
    maneuvers: sortedMap(world.maneuvers, qManeuver),
    messages: world.messages.map(qMessage),
  };
}

/** Canonical, deterministic JSON string of the world state. */
export function serializeWorld(world: WorldState): string {
  return JSON.stringify(canonicalizeWorld(world));
}

/**
 * cyrb53 — a fast 53-bit string hash (fits exactly in a JS double mantissa, so
 * no BigInt). Returned as a 14-char hex string.
 */
export function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** A deterministic hash of the entire world state. Identical physical states →
 *  identical hash. The golden-state determinism guard. */
export function hashWorld(world: WorldState): string {
  return cyrb53(serializeWorld(world));
}

/** String-valued field names in the serialized form. A JSON reviver uses this to
 *  restore the non-finite tokens q() emits into NUMERIC fields only, so a string
 *  field that happens to equal a token (e.g. a ship named "Inf") is left alone. */
const STRING_KEYS = new Set([
  "id", "name", "primary", "mode", "targetId", "shipId", "label", "kind", "dir", "type", "controlNode",
]);

/** Inverse of q()'s non-finite tokens, applied during JSON.parse. */
function reviveNonFinite(key: string, value: unknown): unknown {
  if (typeof value === "string" && !STRING_KEYS.has(key)) {
    if (value === "NaN") return NaN;
    if (value === "Inf") return Infinity;
    if (value === "-Inf") return -Infinity;
  }
  return value;
}

/**
 * Rebuild a WorldState from `serializeWorld` output (Phase-8 save/load
 * foundation). Values are quantized (≤12 sig figs, sub-metre) and the round-trip
 * is hash-stable; non-finite values (e.g. a parabolic a=∞) are revived from their
 * tokens, not left as strings in numeric slots. NOTE: this restores the world
 * only — a live `Simulation`'s scheduled events (capture / SOI crossings &
 * exits / message arrivals) live in its EventQueue, not in WorldState, so a
 * resumed sim must re-schedule them. (The Simulation constructor already re-seeds
 * its message-id counter from the restored messages.) That EventQueue
 * re-scheduling is the one remaining save/load gap, to be closed in Phase 8.
 */
export function deserializeWorld(s: string): WorldState {
  const o = JSON.parse(s, reviveNonFinite) as ReturnType<typeof canonicalizeWorld>;
  const toMap = <V>(obj: unknown): Map<string, V> =>
    new Map(Object.entries(obj as Record<string, V>));
  return {
    t: o.t as number,
    seed: o.seed as number,
    controlNode: o.controlNode as string,
    ships: toMap<Ship>(o.ships),
    stations: toMap<Station>(o.stations),
    maneuvers: toMap<Maneuver>(o.maneuvers),
    messages: o.messages as MessageInFlight[],
  };
}
