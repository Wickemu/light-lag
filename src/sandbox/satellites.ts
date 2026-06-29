/**
 * Live-satellite ingestion: real TLEs → SGP4 state → engine ships.
 *
 * Real satellite catalogs (Celestrak/Space-Track) publish TLEs, which require an
 * SGP4 propagator — not the engine's analytic Kepler/J2 model. We use satellite.js
 * (MIT) to propagate a TLE to a state vector at the sim's current time, then read
 * off osculating Kepler elements and inject the satellite as a coasting engine
 * `Ship` (the only dynamic, serializable, world-resident entity — `BODY_BY_ID` is
 * frozen, so satellites cannot be natural bodies).
 *
 * Frame: satellite.js returns TEME (true-equator) ECI. We feed those equatorial
 * elements to the engine DIRECTLY, with no ecliptic rotation — matching the
 * existing hardcoded ISS/Hubble/Tiangong bodies, whose stored inclination IS the
 * real equatorial value (constants.ts: "a/e/i are real"). Rotating would make
 * ingested satellites inconsistent with those.
 *
 * Accuracy: a TLE is exact only near its epoch; an analytically-propagated orbit
 * still drifts from the true satellite over days. The engine now coasts with the
 * TLE's measured secular drag (a constant ṅ → ½·ṅ·dt² along-track + SMA decay; see
 * `Ship.drag`), which captures the DOMINANT along-track drift but not what SGP4's
 * full density/resonance model does (the runaway as perigee drops, space-weather
 * swings). The sandbox surfaces the residual rather than hiding it.
 *
 * App-layer (the engine never imports satellite.js).
 */
import { twoline2satrec, propagate, sgp4, type SatRec } from "satellite.js";
import type { Simulation } from "@lightlag/engine/sim";
import type { Ship } from "@lightlag/engine/world";
import type { Vec3 } from "@lightlag/engine/math/vec3";
import { type KeplerElements, stateToElements } from "@lightlag/engine/math/kepler";
import { BODY_BY_ID } from "@lightlag/engine/constants";
import { type Tle } from "./data/tleSnapshot.ts";

export type { Tle } from "./data/tleSnapshot.ts";

const MU_EARTH = BODY_BY_ID.get("earth")!.mu;
/** Unix ms at the J2000 epoch (2000-01-01T12:00:00Z). The engine clock is TT and
 *  ignores leap seconds; the ~minute TT/UTC gap is immaterial at sandbox fidelity,
 *  and a UTC Date is in fact what SGP4 expects. */
const J2000_UNIX_MS = 946728000000;

/** A coasting engine ship that came from a TLE is tagged by this id prefix, so the
 *  renderer/UI can present it read-only (no burns, transfers, or design). */
export const SATELLITE_ID_PREFIX = "sat-";

export function isSatelliteId(id: string): boolean {
  return id.startsWith(SATELLITE_ID_PREFIX);
}

function worldTimeToDate(t: number): Date {
  return new Date(J2000_UNIX_MS + t * 1000);
}

/** NORAD catalog number from line 1 (columns 3–7), e.g. "25544". */
function noradId(line1: string): string {
  return line1.slice(2, 7).trim();
}

const DAY_S = 86400;

/**
 * Secular mean-motion rate ṅ (rad/s²) from TLE line 1's first time-derivative of
 * mean motion (columns 34–43), the orbit's measured drag signature. The field is
 * ṅ/2 in rev/day²; convert to SI by ×2 (undo the half), ×2π (rev→rad), ÷86400²
 * (day²→s²). This single constant rate is the rung-1 drag model the engine coasts
 * with (see `Ship.drag`). Returns 0 for a missing/garbled field, so a malformed TLE
 * just yields a drag-free conic rather than failing ingestion.
 */
function tleMeanMotionRate(line1: string): number {
  const halfRevPerDay2 = Number.parseFloat(line1.slice(33, 43).trim());
  if (!Number.isFinite(halfRevPerDay2)) return 0;
  return (halfRevPerDay2 * 2 * 2 * Math.PI) / (DAY_S * DAY_S);
}

/** TEME state (km, km/s) → engine osculating Kepler elements about Earth (SI). */
function temeToElements(
  pos: { x: number; y: number; z: number },
  vel: { x: number; y: number; z: number },
): KeplerElements {
  const r: Vec3 = { x: pos.x * 1000, y: pos.y * 1000, z: pos.z * 1000 };
  const v: Vec3 = { x: vel.x * 1000, y: vel.y * 1000, z: vel.z * 1000 };
  return stateToElements(r, v, MU_EARTH);
}

function elementsFromPv(pv: ReturnType<typeof propagate>): KeplerElements | null {
  // satellite.js sets position/velocity to `false` when propagation errors
  // (e.g. a decayed orbit, or far past the element set's validity).
  if (!pv || typeof pv.position === "boolean" || typeof pv.velocity === "boolean") return null;
  return temeToElements(pv.position, pv.velocity);
}

/** Osculating elements (about Earth) for a TLE at a given sim time `worldT`. */
export function tleToElements(tle: Tle, worldT: number): KeplerElements | null {
  const satrec: SatRec = twoline2satrec(tle.line1, tle.line2);
  return elementsFromPv(propagate(satrec, worldTimeToDate(worldT)));
}

/** Osculating elements at the TLE's OWN epoch — deterministic (no wall-clock),
 *  used by tests and for a snapshot anchored to the element set's validity. */
export function tleToElementsAtEpoch(tle: Tle): KeplerElements | null {
  const satrec: SatRec = twoline2satrec(tle.line1, tle.line2);
  return elementsFromPv(sgp4(satrec, 0));
}

/** Inject a satellite from a TLE as a coasting, read-only ship at the sim's
 *  current time. Returns its ship id, or null if the TLE could not be propagated. */
export function spawnSatellite(sim: Simulation, tle: Tle): string | null {
  const elements = tleToElements(tle, sim.world.t);
  if (!elements) return null;
  const id = `${SATELLITE_ID_PREFIX}${noradId(tle.line1) || tle.name}`;
  const ship: Ship = {
    id,
    name: tle.name,
    primary: "earth",
    mode: "coast",
    elements,
    epoch: sim.world.t,
    payloadMass: 1000, // nominal; a passive marker carries no staged stack
    stages: [],
    activeStage: 0,
    tau: 0,
  };
  // Carry the TLE's measured secular drag so the coast decays its orbit (rung-1),
  // approximating the dominant along-track drift instead of coasting drag-free.
  // Omit a zero rate so a drag-free object serializes like any other coasting ship.
  const nDot = tleMeanMotionRate(tle.line1);
  if (nDot !== 0) ship.drag = { nDot };
  sim.world.ships.set(id, ship);
  return id;
}

/** Inject many TLEs; returns the ids that ingested successfully. */
export function spawnSatellites(sim: Simulation, tles: Tle[]): string[] {
  const ids: string[] = [];
  for (const tle of tles) {
    const id = spawnSatellite(sim, tle);
    if (id) ids.push(id);
  }
  return ids;
}

/** Parse Celestrak/Space-Track 3-line (name + 2 element lines) TLE text. */
export function parseTleText(text: string): Tle[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
  const out: Tle[] = [];
  for (let i = 0; i + 2 < lines.length + 1; i += 3) {
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (name && line1?.startsWith("1 ") && line2?.startsWith("2 ")) out.push({ name, line1, line2 });
  }
  return out;
}

/**
 * Fetch a live TLE group from Celestrak (opt-in; permissive CORS). Groups include
 * "stations", "visual", "gps-ops", "geo", "active". Network access required.
 */
export async function fetchCelestrak(group = "stations"): Promise<Tle[]> {
  const url = `https://celestrak.org/NORAD/elements/gp.php?GROUP=${encodeURIComponent(group)}&FORMAT=tle`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Celestrak request failed: ${res.status}`);
  return parseTleText(await res.text());
}
