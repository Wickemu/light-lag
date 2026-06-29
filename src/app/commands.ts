/**
 * Player intents → validated mutations of the world.
 *
 * In Phase 2 the player's ships are "local" (their own assets in Earth orbit),
 * so commands apply immediately. Phase 5 reroutes these through the light-lag
 * comms layer — a command to a distant ship will become a message that
 * propagates at c — but the call sites here stay the same.
 */

import { type Simulation } from "@lightlag/engine/sim";
import { type Ship, type WorldState, type BurnDir, type BurnGoal, type ShipTransfer, type LagrangePoint, type PoweredSample } from "@lightlag/engine/world";
import { type Stage, exhaustVelocity, thrustAt, brachistochrone, stageLiftoffThrust, stageLiftoffExhaust } from "@lightlag/engine/propulsion";
import { circularOrbit, hyperbolicBurnDv, ellipticalCaptureDv, periapsisRadius, soiRadius, synchronousRadius, synchronousFeasible, inclinationToEquator, combinedPlaneChangeDv } from "@lightlag/engine/orbit";
import { hohmann } from "@lightlag/engine/maneuver/hohmann";
import { orbitRaise } from "@lightlag/engine/maneuver/orbitRaise";
import { computePorkchopTo, type Porkchop, type PorkGrid } from "@lightlag/engine/maneuver/porkchop";
import { lagrangeState, lagrangeStateRelative, lagrangeEligible, lagrangeCentral } from "@lightlag/engine/maneuver/lagrange";
import { shipOsculatingElements, shipRelativeState, shipWorldState, landedRelativeState, buildLaunchLeg, buildDescentLeg, inertialDirToSurface, activeStage, totalMass, dvRemaining, applyImpulsiveDv, NOMINAL_ENTRY_VEHICLE } from "@lightlag/engine/ships";
import { dockState, isDockable, transferProp, mergeStacks, shipPropAvailable, shipPropHeadroom } from "@lightlag/engine/refuel";
import { entryInterfaceCrossing, entryTrajectory, aerocapture } from "@lightlag/engine/maneuver/entry";
import { aimMoonArrival } from "@lightlag/engine/maneuver/arrival";
export { searchMoonWindow, type MoonWindow } from "@lightlag/engine/maneuver/moon";
import { outboundClearsParent } from "@lightlag/engine/maneuver/moon";
import { edelbaumTransfer } from "@lightlag/engine/maneuver/lowThrust";
import { wrapPi } from "@lightlag/engine/math/kepler";
import { torchTransit, type InterstellarTransit } from "@lightlag/engine/maneuver/interstellar";
import { assistTransfer, chainAssist, type AssistResult, type ChainAssistResult } from "@lightlag/engine/maneuver/assist";
import { moonTour, type MoonTourResult } from "@lightlag/engine/maneuver/moonTour";
export { searchMoonTour, type MoonTourResult, type MoonTourFlyby } from "@lightlag/engine/maneuver/moonTour";
import { STAR_BY_ID, starPosition } from "@lightlag/engine/stars";
import {
  ascentBudget, descentBudget, surfaceManeuverCost, type AscentParams,
} from "@lightlag/engine/surface";
import { bodyState, bodyStateRelative, bodyElements } from "@lightlag/engine/ephemeris";
import { lambert } from "@lightlag/engine/maneuver/lambert";
import { length, sub, normalize, distance, cross } from "@lightlag/engine/math/vec3";
import { BODY_BY_ID, DEG, MU_SUN, C, JULIAN_YEAR, DEFAULT_CAPTURE_ALT, type BodyDef } from "@lightlag/engine/constants";

export interface ShipDesign {
  name: string;
  payloadMass: number; // kg
  altitudeKm: number; // circular insertion altitude
  inclinationDeg: number;
  stages: Stage[]; // firing order, index 0 first
  /** True for a LAUNCH VEHICLE that starts on an Earth launch pad and must fly the
   *  ascent to LEO (its boost stages are expended in the climb — see `spawnOnPad` /
   *  `expressToOrbit`). Absent/false ⇒ an IN-SPACE craft deployed directly in LEO with
   *  full propellant (delivered as payload, or assembled in orbit). */
  fromSurface?: boolean;
}

/** A reasonable two-stage chemical ship: ~7.9 km/s of Δv, T/W ≈ 1.6. */
export function defaultDesign(): ShipDesign {
  return {
    name: "Courier",
    payloadMass: 3000,
    altitudeKm: 400,
    inclinationDeg: 28.5,
    stages: [
      { name: "Booster", dryMass: 5000, propMass: 50000, isp: 300, thrust: 1.2e6 },
      { name: "Upper", dryMass: 2000, propMass: 15000, isp: 340, thrust: 2.0e5 },
    ],
  };
}

/** Build the staged ship record from a design (full tanks; each stage's as-built tank
 *  capacity recorded so a later refuelling can top it up but never over-fill it). The
 *  caller PLACES it — on a LEO conic (`spawnShip`) or landed on a launch pad
 *  (`spawnOnPad`). Stages (and boosters) are deep-copied so the live ship never aliases
 *  the design template (the sim mutates propMass and splices spent boosters). */
function buildShipRecord(id: string, design: ShipDesign, t: number): Ship {
  return {
    id,
    name: design.name,
    primary: "earth",
    mode: "coast",
    epoch: t,
    payloadMass: design.payloadMass,
    stages: design.stages.map((s) => ({
      ...s,
      propCapacity: s.propCapacity ?? s.propMass,
      boosters: s.boosters?.map((b) => ({ ...b })),
    })),
    activeStage: 0,
    tau: 0,
  };
}

/**
 * Deploy a ship directly into a circular orbit about Earth, fully fuelled — the
 * IN-SPACE case: the craft is delivered to LEO as payload (or assembled there), so
 * its full Δv is its in-space budget. A LAUNCH VEHICLE instead stands on the pad
 * (`spawnOnPad`) and pays the ascent. Returns its id.
 */
export function spawnShip(sim: Simulation, design: ShipDesign): string {
  const earth = BODY_BY_ID.get("earth")!;
  const radius = earth.radius + design.altitudeKm * 1000;
  const id = `ship-${sim.world.ships.size + 1}`;
  const ship = buildShipRecord(id, design, sim.world.t);
  ship.elements = circularOrbit(radius, design.inclinationDeg * DEG, 0, 0);
  sim.world.ships.set(id, ship);
  return id;
}

/** Body-fixed launch-site direction at latitude φ = the design's target inclination
 *  (the minimum inclination a pad can reach is its latitude; `launchShip` recovers it
 *  as asin(surfaceDir.z)). Longitude is arbitrary — the body rotates under the pad — so
 *  we seat it on the +x meridian. */
function launchSiteDir(inclinationDeg: number): { x: number; y: number; z: number } {
  const phi = Math.min(Math.abs(inclinationDeg), 90) * DEG;
  return { x: Math.cos(phi), y: 0, z: Math.sin(phi) };
}

/**
 * Stand a LAUNCH VEHICLE on the Earth launch pad (landed at a pad whose latitude is the
 * design's target inclination, full propellant). The player then flies the ascent with
 * `launchShip` — the gravity-turn budget expends the boost/lower stages and only the
 * surviving stack reaches LEO. Returns its id.
 */
export function spawnOnPad(sim: Simulation, design: ShipDesign): string {
  const id = `ship-${sim.world.ships.size + 1}`;
  const ship = buildShipRecord(id, design, sim.world.t);
  ship.landed = { bodyId: "earth", surfaceDir: launchSiteDir(design.inclinationDeg) };
  sim.world.ships.set(id, ship);
  return id;
}

export interface ExpressResult {
  id: string | null; // the new ship's id, or null if it cannot reach orbit
  op: SurfaceOp; // the ascent cost (feasible:false ⇒ the design's Δv < the ascent budget)
}

/**
 * "Express to LEO": stand a launch vehicle on the pad and immediately resolve its
 * ascent — charging the gravity-turn Δv, expending the boost/lower stages — and seat
 * the surviving stack in a circular LEO parking orbit at the design's altitude. The
 * no-flying convenience; the resulting LEO state is identical to flying the ascent
 * (the Δv is charged up front either way). Returns the new id + the ascent cost, or
 * `{ id: null, … }` (and spawns nothing) if the design can't reach orbit.
 */
export function expressToOrbit(sim: Simulation, design: ShipDesign): ExpressResult {
  const id = spawnOnPad(sim, design);
  const op = launchShip(sim, id, design.altitudeKm, { instant: true });
  if (!op || !op.feasible) {
    deleteShip(sim, id); // couldn't reach orbit — leave the world untouched
    return { id: null, op: op ?? { dv: 0, propellant: 0, burnTime: 0, feasible: false } };
  }
  return { id, op };
}

export interface AscentPreview {
  ascentDv: number; // the Earth→LEO gravity-turn budget (m/s)
  stackDv: number; // the full ground stack's Δv (m/s)
  reachesOrbit: boolean; // stack Δv ≥ ascent budget (and the climb converges)
  survivorMass: number; // mass that reaches LEO after the ascent (kg)
  survivorDv: number; // Δv left in LEO after the ascent (m/s)
}

/**
 * Read-only projection of launching a design from the Earth pad to LEO: the ascent
 * Δv it must pay, its full-stack Δv, whether it makes orbit, and — if so — the mass
 * and Δv that SURVIVE into LEO once the boost stages are expended. Builds and charges
 * a throwaway ship; mutates nothing in the world. Lets the designer show the honest
 * ascent budget and orbital survivor for a launch vehicle. null for the Sun/gas giants.
 */
export function ascentPreview(design: ShipDesign): AscentPreview | null {
  const earth = BODY_BY_ID.get("earth")!;
  const ship = buildShipRecord("preview", design, 0); // detached — never added to the world
  const asc = ascentBudget(earth, shipSurfaceParams(ship, earth, design.altitudeKm * 1000));
  if (!asc) return null;
  const stackDv = dvRemaining(ship);
  const reachesOrbit = asc.converged && stackDv >= asc.dvTotal;
  if (reachesOrbit) applyImpulsiveDv(ship, asc.dvTotal); // expend the ascent off the copy
  return {
    ascentDv: asc.dvTotal, stackDv, reachesOrbit,
    survivorMass: totalMass(ship), survivorDv: dvRemaining(ship),
  };
}

/**
 * Remove a ship from the world entirely (the player scraps or abandons it),
 * cleaning up every reference: any command messages still crawling out to it,
 * its scheduled events (departures, captures, SOI crossings…), and any maneuver
 * records. The renderer and ship panel drop their per-ship visuals on their own
 * (they sync to `world.ships` each frame). Telemetry already in flight FROM the
 * ship is harmless — it just arrives and is discarded. Returns true if a ship was
 * removed, false if the id was unknown. The caller redirects camera focus if it
 * was watching this ship.
 */
export function deleteShip(sim: Simulation, shipId: string): boolean {
  if (!sim.world.ships.has(shipId)) return false;
  sim.world.ships.delete(shipId);
  sim.world.messages = sim.world.messages.filter((m) => m.targetId !== shipId);
  for (const [id, m] of sim.world.maneuvers) if (m.shipId === shipId) sim.world.maneuvers.delete(id);
  sim.events.removeByEntity(shipId);
  return true;
}

// ── Orbital propellant transfer & in-orbit construction ──────────────────────

export interface DockCandidate {
  id: string;
  name: string;
  distance: number; // m — relative range in the shared primary's frame
  relSpeed: number; // m/s — closing speed
}

/**
 * Ships currently DOCKED with `shipId` — sharing its primary, both free-coasting,
 * and within rendezvous tolerance (see refuel.ts `dockState`). These are the valid
 * partners for a propellant transfer or an assembly. Returns [] if the ship itself
 * can't dock (lost, landed, thrusting, or committed to a leg).
 */
export function dockCandidates(sim: Simulation, shipId: string): DockCandidate[] {
  const ship = sim.world.ships.get(shipId);
  if (!ship || !isDockable(ship)) return [];
  const out: DockCandidate[] = [];
  for (const other of sim.world.ships.values()) {
    if (other.id === shipId || other.primary !== ship.primary || !isDockable(other)) continue;
    const d = dockState(ship, other, sim.world.t);
    if (d.docked) out.push({ id: other.id, name: other.name, distance: d.distance, relSpeed: d.relSpeed });
  }
  return out;
}

export interface TransferResult {
  moved: number; // kg of propellant transferred
  donorDvAfter: number; // m/s Δv left on the donor
  receiverDvAfter: number; // m/s Δv now available to the receiver
}

/**
 * Transfer propellant from `fromId` to `toId` — the depot / tanker refuelling move.
 * Both ships must share a primary, be free-coasting, and be docked (within
 * rendezvous tolerance). `amountKg` omitted ⇒ fill the receiver as much as the donor
 * and the receiver's tank capacity allow. Conserves mass (the donor loses exactly
 * what the receiver gains), so it raises the receiver's m₀ → Δv and lowers the
 * donor's. Returns what moved + both new Δv budgets, or null if the pair can't dock
 * or nothing can move.
 */
export function transferPropellant(sim: Simulation, fromId: string, toId: string, amountKg?: number): TransferResult | null {
  if (fromId === toId) return null;
  const donor = sim.world.ships.get(fromId);
  const receiver = sim.world.ships.get(toId);
  if (!donor || !receiver) return null;
  if (donor.primary !== receiver.primary || !isDockable(donor) || !isDockable(receiver)) return null;
  if (!dockState(donor, receiver, sim.world.t).docked) return null;
  const amount = amountKg ?? shipPropHeadroom(receiver);
  const moved = transferProp(donor, receiver, amount);
  if (moved <= 0) return null;
  return { moved, donorDvAfter: dvRemaining(donor), receiverDvAfter: dvRemaining(receiver) };
}

export interface AssemblyResult {
  dvAfter: number; // m/s Δv of the merged vehicle
  wetMass: number; // kg total mass of the merged vehicle
}

/**
 * Assemble (dock-merge) `addId` into `baseId` — in-orbit construction. The base keeps
 * its identity and orbit; the added ship's remaining stages stack on top of the base's
 * (the base fires first) and its payload adds to the base's. The added ship is consumed
 * (deleted, with its in-flight orders/events purged). Both must share a primary, be
 * free-coasting, and be docked. Mass is conserved — the merged wet mass is the sum of
 * the two — and Δv is recomputed from the combined stack. Returns the merged ship's new
 * Δv/mass, or null if the pair can't dock.
 */
export function assembleShips(sim: Simulation, baseId: string, addId: string): AssemblyResult | null {
  if (baseId === addId) return null;
  const base = sim.world.ships.get(baseId);
  const add = sim.world.ships.get(addId);
  if (!base || !add) return null;
  if (base.primary !== add.primary || !isDockable(base) || !isDockable(add)) return null;
  if (!dockState(base, add, sim.world.t).docked) return null;
  mergeStacks(base, add);
  deleteShip(sim, addId);
  return { dvAfter: dvRemaining(base), wetMass: totalMass(base) };
}

/** Read-only: a ship's propellant available to give and the headroom it can accept,
 *  for the dock/transfer UI. */
export function shipPropStatus(sim: Simulation, shipId: string): { available: number; headroom: number } | null {
  const ship = sim.world.ships.get(shipId);
  if (!ship) return null;
  return { available: shipPropAvailable(ship), headroom: shipPropHeadroom(ship) };
}

/**
 * Command a finite-thrust burn delivering `dvTarget` of ENGINE Δv in the given
 * orbit direction. The command is NOT applied now: it is transmitted from the
 * control node and propagates at c, so a distant ship only begins the burn after
 * the one-way light delay (and acknowledges a round-trip later). The Δv is
 * engine Δv (∫F/m dt, the rocket-equation currency); the realised speed change
 * is slightly less for a finite burn — that loss is physically honest.
 *
 * Returns the one-way light delay (s): under the "binding" policy this is the
 * time until the order reaches the ship; under "informative" the order applies
 * immediately and the delay is only a readout. Null if the command can't be sent
 * (unknown target/control node) or, in informative mode, wasn't accepted.
 */
export function sendBurn(
  sim: Simulation,
  shipId: string,
  dvTarget: number,
  dir: BurnDir,
  goal?: BurnGoal,
): number | null {
  if (dvTarget <= 0) return null;
  // Open-loop (no goal): dvTarget is the exact Δv. Closed-loop: dvTarget is the
  // correction CAP, and we stamp the primary the goal's radii are measured about
  // (the retarded snapshot the player aimed from) so delivery can reject an
  // order whose target frame the ship has since left.
  const command = goal
    ? { type: "burn" as const, dv: dvTarget, dir, goal, goalPrimary: sim.world.ships.get(shipId)?.primary }
    : { type: "burn" as const, dv: dvTarget, dir };
  if (sim.commandPolicy === "informative") {
    const res = sim.applyCommandNow(shipId, command);
    return res && res.applied ? res.delay : null;
  }
  const res = sim.sendCommand(shipId, command);
  return res ? res.delay : null;
}

export interface TransferPlan {
  dvDepart: number;
  dvArrive: number;
  tof: number;
}

/**
 * Plan and schedule an interplanetary transfer: solve the Lambert leg from the
 * ship's current primary (e.g. Earth) to `targetId` for the chosen departure and
 * arrival times, record it on the ship, and queue the departure. The injection
 * executes when the clock reaches tDepart (see Simulation.executeDeparture).
 */
export function planTransfer(
  sim: Simulation,
  shipId: string,
  targetId: string,
  tDepart: number,
  tArrive: number,
  captureMode: "propulsive" | "aerocapture" = "propulsive",
  captureApoAlt?: number, // propulsive only: capture into an ellipse reaching this apoapsis alt
): TransferPlan | null {
  const ship = sim.world.ships.get(shipId);
  // A landed ship has no parking orbit to inject from (its osculating "orbit" is the
  // surface) — launch to LEO first. Mirrors the guard on the moon/spiral planners.
  if (!ship || ship.landed || tArrive <= tDepart) return null;
  const depBody = BODY_BY_ID.get(ship.primary);
  const target = BODY_BY_ID.get(targetId);
  if (!depBody || !target) return null;

  const depState = bodyState(depBody, tDepart);
  const arrState = bodyState(target, tArrive);
  const sol = lambert(depState.r, arrState.r, tArrive - tDepart, MU_SUN, true);
  if (!sol) return null;

  // Oberth-aware injection from the ship's parking orbit, and capture into a
  // default low orbit at the target — so the planned cost equals what is paid.
  const el = shipOsculatingElements(ship, sim.world.t);
  const rParkFrom = periapsisRadius(el.a, el.e);
  const rParkTo = target.radius + DEFAULT_CAPTURE_ALT;
  const vInfArrive = length(sub(sol.v2, arrState.v));
  const dvDepart = hyperbolicBurnDv(length(sub(sol.v1, depState.v)), depBody.mu, rParkFrom);

  // Aerocapture: solve the corridor that captures this arrival on a single drag pass.
  // The injection aims the hyperbola's periapsis INTO the atmosphere (aeroPeriAlt) and
  // only the post-pass periapsis-raise trim is charged at arrival.
  if (captureMode === "aerocapture") {
    if (!target.atmosphere) return null; // nothing to brake against
    const ac = aerocapture(target, NOMINAL_ENTRY_VEHICLE, {
      vInf: vInfArrive,
      targetApoAlt: Math.max(2e6, target.radius), // a high capture ellipse; trimmed at apoapsis
      targetPeriAlt: DEFAULT_CAPTURE_ALT,
    });
    if (!ac || !ac.feasible) return null; // arrival can't aerocapture (overheats / never captures)
    ship.transfer = {
      targetId, tDepart, tArrive, dvDepart, dvArrive: ac.trimDv,
      departed: false, inSoi: false, arrived: false, aeroPeriAlt: ac.periapsisAlt,
    };
    sim.events.push({ t: tDepart, kind: "transfer-depart", entityId: shipId });
    return { dvDepart, dvArrive: ac.trimDv, tof: tArrive - tDepart };
  }

  // Propulsive capture: circular by default, or — when an apoapsis is given — a cheap
  // Oberth-efficient elliptical insertion (low periapsis, high apoapsis), as flown at deep wells.
  const dvArrive = captureApoAlt !== undefined
    ? ellipticalCaptureDv(vInfArrive, target.mu, rParkTo, target.radius + captureApoAlt)
    : hyperbolicBurnDv(vInfArrive, target.mu, rParkTo);
  ship.transfer = {
    targetId, tDepart, tArrive, dvDepart, dvArrive, departed: false, inSoi: false, arrived: false,
    ...(captureApoAlt !== undefined ? { captureApoAlt } : {}),
  };
  sim.events.push({ t: tDepart, kind: "transfer-depart", entityId: shipId });
  return { dvDepart, dvArrive, tof: tArrive - tDepart };
}

/** Read-only preview of aerocapturing a transfer arrival (no mutation): the trim Δv it
 *  would cost, the propulsive capture Δv it replaces, and whether the body's atmosphere can
 *  actually shed the arrival's excess speed. null if the target has no atmosphere / no
 *  Lambert solution. Used by the transfer planner to show the aerocapture option. */
export function aerocapturePreview(
  targetId: string, depBodyId: string, tDepart: number, tArrive: number,
): { feasible: boolean; trimDv: number; propulsiveDv: number } | null {
  const depBody = BODY_BY_ID.get(depBodyId);
  const target = BODY_BY_ID.get(targetId);
  if (!depBody || !target || !target.atmosphere || tArrive <= tDepart) return null;
  const sol = lambert(bodyState(depBody, tDepart).r, bodyState(target, tArrive).r, tArrive - tDepart, MU_SUN, true);
  if (!sol) return null;
  const vInf = length(sub(sol.v2, bodyState(target, tArrive).v));
  const propulsiveDv = hyperbolicBurnDv(vInf, target.mu, target.radius + DEFAULT_CAPTURE_ALT);
  const ac = aerocapture(target, NOMINAL_ENTRY_VEHICLE, {
    vInf, targetApoAlt: Math.max(2e6, target.radius), targetPeriAlt: DEFAULT_CAPTURE_ALT,
  });
  return { feasible: !!ac && ac.feasible, trimDv: ac?.trimDv ?? 0, propulsiveDv };
}

/** Fraction of a body's sphere of influence used as the apoapsis of a "loose" elliptical
 *  capture — well inside the SOI (so it stays bound and stable) yet eccentric enough to win
 *  most of the Oberth saving over a low circular capture. */
const LOOSE_CAPTURE_SOI_FRACTION = 0.5;

/** Apoapsis ALTITUDE (m) of a sensible loose elliptical capture at `targetId`: half its SOI,
 *  measured above the surface. Scales naturally across wells (a Jupiter ellipse is vast, a Mars
 *  one modest). Used by the planner to offer the cheap elliptical-capture option. */
export function looseCaptureApoAlt(targetId: string, t: number): number {
  const body = BODY_BY_ID.get(targetId);
  if (!body) return DEFAULT_CAPTURE_ALT;
  const parentMu = body.parent ? (BODY_BY_ID.get(body.parent)?.mu ?? MU_SUN) : MU_SUN;
  const a = bodyElements(body, t)?.a ?? 0;
  const rSoi = soiRadius(a, body.mu, parentMu);
  return Math.max(DEFAULT_CAPTURE_ALT, LOOSE_CAPTURE_SOI_FRACTION * rSoi - body.radius);
}

/** Read-only preview of the propulsive capture Δv for a heliocentric arrival — circular
 *  (`captureApoAlt` omitted) or a cheaper elliptical insertion to that apoapsis altitude. null if
 *  the bodies are unknown or no Lambert solution exists. Lets the planner show the live saving. */
export function captureDvPreview(
  targetId: string, depBodyId: string, tDepart: number, tArrive: number, captureApoAlt?: number,
): number | null {
  const depBody = BODY_BY_ID.get(depBodyId);
  const target = BODY_BY_ID.get(targetId);
  if (!depBody || !target || tArrive <= tDepart) return null;
  const sol = lambert(bodyState(depBody, tDepart).r, bodyState(target, tArrive).r, tArrive - tDepart, MU_SUN, true);
  if (!sol) return null;
  const vInf = length(sub(sol.v2, bodyState(target, tArrive).v));
  const rPark = target.radius + DEFAULT_CAPTURE_ALT;
  return captureApoAlt !== undefined
    ? ellipticalCaptureDv(vInf, target.mu, rPark, target.radius + captureApoAlt)
    : hyperbolicBurnDv(vInf, target.mu, rPark);
}

/**
 * Plan a transfer from the ship's current planet-orbit to one of that planet's MOONS — a
 * transfer flown about the PARENT planet (not the Sun), so the ship stays in the planet's
 * SOI and patches into the moon's. Eligible only when `moon.parent === ship.primary` (ship
 * at Earth → Moon, at Jupiter → a Galilean, …). Parent-centric Lambert + a direct injection
 * from the parking orbit; capture into a low orbit about the moon. Returns the cost or null.
 */
export function planMoonTransfer(
  sim: Simulation, shipId: string, moonId: string, tDepart: number, tArrive: number,
  captureApoAlt?: number, // capture into an ellipse reaching this apoapsis alt (else circular)
): TransferPlan | null {
  const ship = sim.world.ships.get(shipId);
  if (!ship || tArrive <= tDepart || ship.mode !== "coast" || ship.landed) return null;
  if (ship.transfer || ship.interstellarLeg || ship.spiral || ship.entryLeg) return null;
  const parent = BODY_BY_ID.get(ship.primary);
  const moon = BODY_BY_ID.get(moonId);
  if (!parent || !moon || moon.parent !== ship.primary) return null;

  // Parent-centric aim: from the ship's parking-orbit position to a moon-relative periapsis
  // above the surface (a B-plane offset, so the capture circularizes into a real orbit). The
  // injection is the direct impulse from the parking velocity; the arrival is an Oberth
  // capture about the moon.
  const shipDep = shipRelativeState(ship, tDepart);
  const moonArr = bodyStateRelative(moon, tArrive);
  const rParkTo = moon.radius + DEFAULT_CAPTURE_ALT;
  const aim = aimMoonArrival(parent, moon, shipDep.r, tDepart, tArrive, rParkTo);
  if (!aim) return null;
  // Reject a window whose outbound conic would fly the ship into the parent at departure (an
  // unfavourable parking-orbit phase) — the same safety the sim enforces at departure.
  if (!outboundClearsParent(shipDep.r, aim.v1, parent.mu, parent.radius)) return null;
  const dvDepart = length(sub(aim.v1, shipDep.v));
  // Capture about the moon: the approach v∞ from the (centre) Lambert vs the moon's velocity —
  // circular by default, or a cheaper elliptical insertion when an apoapsis is given.
  const approach = lambert(shipDep.r, moonArr.r, tArrive - tDepart, parent.mu, true);
  const vInf = approach ? length(sub(approach.v2, moonArr.v)) : 0;
  const dvArrive = !approach ? 0 : captureApoAlt !== undefined
    ? ellipticalCaptureDv(vInf, moon.mu, rParkTo, moon.radius + captureApoAlt)
    : hyperbolicBurnDv(vInf, moon.mu, rParkTo);

  ship.transfer = {
    targetId: moonId, tDepart, tArrive, dvDepart, dvArrive,
    departed: false, inSoi: false, arrived: false, central: ship.primary,
    ...(captureApoAlt !== undefined ? { captureApoAlt } : {}),
  };
  sim.events.push({ t: tDepart, kind: "transfer-depart", entityId: shipId });
  return { dvDepart, dvArrive, tof: tArrive - tDepart };
}

/**
 * Plan and schedule an intra-system gravity-assist TOUR: the ship is in orbit about a planet and
 * reaches one of its moons by flying past sibling moons (the Galileo / JUICE / Europa Clipper
 * pump-down). Records the transfer with `central = parent` + one `FlybyLeg` per flyby moon (and the
 * target moon as `targetId`), and queues the departure; the sim flies depart → moon flyby-pass×N →
 * capture, all INSIDE the planet's SOI. `flybyMoonIds` lists the flyby moons in order; `times` is
 * `[tDepart, …flybyTimes, tArrive]` (strictly increasing, length = flybyMoonIds.length + 2). The
 * arrival captures circular (default) or into a loose ellipse (`captureApoAlt`). Returns the tour
 * estimate, or null if the schedule/bodies are invalid.
 */
export function planMoonTour(
  sim: Simulation, shipId: string,
  flybyMoonIds: string[], targetMoonId: string, times: number[],
  captureApoAlt?: number,
): MoonTourResult | null {
  const ship = sim.world.ships.get(shipId);
  if (!ship || ship.mode !== "coast" || ship.landed) return null;
  if (ship.transfer || ship.interstellarLeg || ship.spiral || ship.entryLeg) return null;
  const parent = BODY_BY_ID.get(ship.primary);
  const target = BODY_BY_ID.get(targetMoonId);
  if (!parent || !target || target.parent !== ship.primary) return null;
  if (flybyMoonIds.length < 1 || times.length !== flybyMoonIds.length + 2) return null;
  // Every flyby moon must orbit the SAME parent the ship is at; the immediately-final flyby can't
  // be the capture encounter itself (resonant reuse of the target at an EARLIER flyby is fine).
  if (flybyMoonIds.some((id) => BODY_BY_ID.get(id)?.parent !== ship.primary)) return null;
  if (flybyMoonIds[flybyMoonIds.length - 1] === targetMoonId) return null;
  for (let i = 1; i < times.length; i++) if (times[i]! <= times[i - 1]!) return null;

  // Seed the solver with the ship's parent-relative state at departure (the sim re-derives the same
  // state deterministically at execution time, so the planned and flown trajectories agree).
  const dep = shipRelativeState(ship, times[0]!);
  const res = moonTour(ship.primary, dep, flybyMoonIds, targetMoonId, times, captureApoAlt);
  if (!res) return null;

  ship.transfer = {
    targetId: targetMoonId, tDepart: res.tDepart, tArrive: res.tArrive,
    dvDepart: res.dvDepart, dvArrive: res.dvArrive,
    departed: false, inSoi: false, arrived: false, central: ship.primary,
    flybys: res.flybys.map((f) => ({ bodyId: f.moonId, tFlyby: f.t, dvBurn: f.dvFlyby, done: false })),
    ...(captureApoAlt !== undefined ? { captureApoAlt } : {}),
  };
  sim.events.push({ t: res.tDepart, kind: "transfer-depart", entityId: shipId });
  return res;
}

/** A two-stage cross-system mission: the heliocentric Stage-1 cost plus an estimate of the
 *  parent-centric Stage-2 (moon) leg that the sim auto-chains on arrival at the planet. */
export interface MoonMissionPlan extends TransferPlan {
  stage2Dv: number; // estimated Stage-2 injection + capture (m/s)
  parentId: string; // the planet captured at first
}

/** Rough Stage-2 estimate: a Hohmann hop from a default parking orbit about `parent` out to the
 *  moon, plus a hyperbolic capture about the moon. Used only for the planner readout — the real
 *  Stage-2 is searched fresh (searchMoonWindow) when the ship actually captures at the planet. */
function estimateMoonLeg(parent: BodyDef, moon: BodyDef, tArrive: number): number {
  const rPark = parent.radius + DEFAULT_CAPTURE_ALT;
  const rMoon = length(bodyStateRelative(moon, tArrive).r);
  const hoh = hohmann(parent.mu, rPark, rMoon);
  const rCap = moon.radius + DEFAULT_CAPTURE_ALT;
  // Arrival relative speed ≈ the Hohmann arrival-leg velocity defect vs. the moon's circular speed.
  const vMoon = Math.sqrt(parent.mu / rMoon);
  const vArr = Math.sqrt(parent.mu * (2 / rMoon - 2 / (rPark + rMoon)));
  const dvCapture = hyperbolicBurnDv(Math.abs(vMoon - vArr), moon.mu, rCap);
  return hoh.dv1 + dvCapture;
}

/**
 * Plan a CROSS-SYSTEM two-stage mission to a moon whose parent planet is heliocentric and not
 * the ship's current primary (e.g. ship at Earth → Europa@Jupiter). Stage 1 is an ordinary
 * heliocentric transfer to the moon's parent planet (captured into a parking orbit there);
 * the transfer carries `thenMoonId`, so on capture the sim auto-chains a parent-centric Stage-2
 * leg to the moon (see sim.ts). Returns the Stage-1 cost + a Stage-2 estimate, or null.
 */
export function planMoonMission(
  sim: Simulation, shipId: string, moonId: string, tDepart: number, tArrive: number,
  captureMode: "propulsive" | "aerocapture" = "propulsive",
  captureApoAlt?: number, // Stage-1 elliptical capture apoapsis alt at the parent (else circular)
): MoonMissionPlan | null {
  const ship = sim.world.ships.get(shipId);
  const moon = BODY_BY_ID.get(moonId);
  if (!ship || !moon || !moon.parent) return null;
  const parent = BODY_BY_ID.get(moon.parent);
  // Only a cross-system moon (parent is a heliocentric planet, and not where we already are).
  if (!parent || parent.parent !== "sun" || parent.id === ship.primary) return null;

  const stage1 = planTransfer(sim, shipId, parent.id, tDepart, tArrive, captureMode, captureApoAlt);
  if (!stage1) return null;
  // Tag the just-planned transfer so the sim flies the moon leg on arrival.
  ship.transfer!.thenMoonId = moonId;
  const stage2Dv = estimateMoonLeg(parent, moon, tArrive);
  return { ...stage1, stage2Dv, parentId: parent.id };
}

// ── Synchronous (GEO) & Lagrange-point destinations ───────────────────────────

/** Sphere-of-influence radius of a body about its parent at time t. */
function bodySoiRadius(body: BodyDef, t: number): number {
  const parentMu = body.parent ? (BODY_BY_ID.get(body.parent)?.mu ?? MU_SUN) : MU_SUN;
  return soiRadius(length(bodyStateRelative(body, t).r), body.mu, parentMu);
}

/** Is a synchronous (geostationary/areostationary) orbit offered at this body right now? */
export function synchronousOrbitFeasible(body: BodyDef, t: number): boolean {
  return synchronousFeasible(body.mu, body.rotationPeriod, body.radius, bodySoiRadius(body, t));
}

export interface GeoRaisePlan {
  dv1: number; dv2: number; dvTotal: number; tof: number;
  aSync: number; mode: "hohmann" | "bi-elliptic";
}

/** Read-only preview of raising the ship's CURRENT orbit to its primary's synchronous orbit
 *  (the comsat case: Earth LEO → GEO): a Hohmann raise plus the equatorial plane change folded
 *  into the apoapsis burn. null if the primary has no usable synchronous orbit, the ship is
 *  landed, or it is already at/above synchronous radius. */
export function geoRaisePreview(sim: Simulation, shipId: string): GeoRaisePlan | null {
  const ship = sim.world.ships.get(shipId);
  if (!ship || ship.landed) return null;
  const body = BODY_BY_ID.get(ship.primary);
  if (!body || !body.rotationPeriod || !synchronousOrbitFeasible(body, sim.world.t)) return null;
  const el = shipOsculatingElements(ship, sim.world.t);
  const rNow = el.a;
  const aSync = synchronousRadius(body.mu, body.rotationPeriod);
  if (aSync <= rNow) return null;
  const st = shipRelativeState(ship, sim.world.t);
  const di = inclinationToEquator(cross(st.r, st.v), body.obliquityDeg ?? 0);
  const raise = orbitRaise(body.mu, rNow, aSync, di);
  return { ...raise, aSync };
}

/** Plan and schedule a same-primary GEO raise (Earth LEO → GEO). An in-SOI Hohmann transfer to
 *  the synchronous radius with an equatorial plane change; the sim flies the transfer ellipse and
 *  circularizes at apoapsis (see Simulation.executeSyncRaiseDeparture/arriveSyncRaise). */
export function planGeoRaise(sim: Simulation, shipId: string): GeoRaisePlan | null {
  const plan = geoRaisePreview(sim, shipId);
  if (!plan) return null;
  const ship = sim.world.ships.get(shipId)!;
  const t0 = sim.world.t;
  ship.transfer = {
    targetId: ship.primary, central: ship.primary, arrival: { kind: "synchronous" },
    tDepart: t0, tArrive: t0 + plan.tof, dvDepart: plan.dv1, dvArrive: plan.dv2,
    departed: false, inSoi: true, arrived: false,
  };
  sim.events.push({ t: t0, kind: "transfer-depart", entityId: shipId });
  return plan;
}

/** The estimated equatorial plane change (rad) for a remote synchronous capture: the arrival
 *  hyperbola is ~ecliptic, so the rotation to the equator is ≈ the body's obliquity. */
function synchronousPlaneChange(target: BodyDef): number {
  return (target.obliquityDeg ?? 0) * DEG;
}

/** Capture Δv (m/s) for arriving at `vInf` directly into a circular synchronous orbit at `target`:
 *  the periapsis burn slows the hyperbola to circular at a_sync and rotates into the equator. */
function synchronousCaptureDv(target: BodyDef, vInf: number): number {
  const aSync = synchronousRadius(target.mu, target.rotationPeriod!);
  const vHypPeri = Math.sqrt(vInf * vInf + (2 * target.mu) / aSync);
  return combinedPlaneChangeDv(vHypPeri, Math.sqrt(target.mu / aSync), synchronousPlaneChange(target));
}

/** A porkchop to a remote body's SYNCHRONOUS orbit: the heliocentric transfer to the body, but
 *  costed with a direct circular synchronous capture (+ estimated equatorial plane change). */
export function computeSynchronousPorkchop(
  fromId: string, targetId: string, grid: PorkGrid, rParkFrom: number,
): Porkchop | null {
  const from = BODY_BY_ID.get(fromId);
  const to = BODY_BY_ID.get(targetId);
  if (!from || !to || !to.rotationPeriod) return null;
  return computePorkchopTo(
    fromId, targetId, MU_SUN,
    (t) => bodyState(from, t),
    { stateAt: (t) => bodyState(to, t), captureDv: (vInf) => synchronousCaptureDv(to, vInf) },
    (vInf) => hyperbolicBurnDv(vInf, from.mu, rParkFrom),
    grid,
  );
}

/** Plan and schedule a transfer that captures into a remote body's synchronous orbit (Mars
 *  areostationary, etc.). Mirrors planTransfer but aims the hyperbola at a_sync and circularizes
 *  there with an equatorial plane change. null if the body has no usable synchronous orbit. */
export function planSynchronousTransfer(
  sim: Simulation, shipId: string, targetId: string, tDepart: number, tArrive: number,
): TransferPlan | null {
  const ship = sim.world.ships.get(shipId);
  if (!ship || ship.landed || tArrive <= tDepart) return null;
  const depBody = BODY_BY_ID.get(ship.primary);
  const target = BODY_BY_ID.get(targetId);
  if (!depBody || !target || !target.rotationPeriod || !synchronousOrbitFeasible(target, tArrive)) return null;
  const depState = bodyState(depBody, tDepart);
  const arrState = bodyState(target, tArrive);
  const sol = lambert(depState.r, arrState.r, tArrive - tDepart, MU_SUN, true);
  if (!sol) return null;
  const el = shipOsculatingElements(ship, sim.world.t);
  const rParkFrom = periapsisRadius(el.a, el.e);
  const dvDepart = hyperbolicBurnDv(length(sub(sol.v1, depState.v)), depBody.mu, rParkFrom);
  const dvArrive = synchronousCaptureDv(target, length(sub(sol.v2, arrState.v)));
  ship.transfer = {
    targetId, tDepart, tArrive, dvDepart, dvArrive,
    departed: false, inSoi: false, arrived: false, arrival: { kind: "synchronous" },
  };
  sim.events.push({ t: tDepart, kind: "transfer-depart", entityId: shipId });
  return { dvDepart, dvArrive, tof: tArrive - tDepart };
}

/** A porkchop to a Lagrange point of the (parent, `secondaryId`) pair, solved in the L-point's
 *  cruise frame: heliocentric for a planet's Sun–planet points (Oberth escape from the departure
 *  planet's well), geocentric for a moon's planet–moon points (direct injection from the parking
 *  orbit). Arrival is a velocity match (captureDv = v∞). null if the ship isn't positioned to fly
 *  it (a geocentric pair needs the ship to be orbiting the parent planet). */
export function computeLagrangePorkchop(
  sim: Simulation, shipId: string, secondaryId: string, point: LagrangePoint,
  grid: PorkGrid, rParkFrom: number,
): Porkchop | null {
  const ship = sim.world.ships.get(shipId);
  const secondary = BODY_BY_ID.get(secondaryId);
  if (!ship || !secondary || !lagrangeEligible(secondary)) return null;
  const central = lagrangeCentral(secondary);
  if (central !== undefined) {
    const cen = BODY_BY_ID.get(central)!;
    if (ship.primary !== cen.id) return null; // must be orbiting the parent planet
    return computePorkchopTo(
      ship.primary, secondaryId, cen.mu,
      (t) => shipRelativeState(ship, t),
      { stateAt: (t) => lagrangeStateRelative(secondary, point, t), captureDv: (vInf) => vInf },
      (vInf) => vInf, // direct injection — the ship is already in orbit about the parent
      grid,
    );
  }
  const depBody = BODY_BY_ID.get(ship.primary);
  if (!depBody) return null;
  return computePorkchopTo(
    ship.primary, secondaryId, MU_SUN,
    (t) => bodyState(depBody, t),
    { stateAt: (t) => lagrangeState(secondary, point, t), captureDv: (vInf) => vInf },
    (vInf) => hyperbolicBurnDv(vInf, depBody.mu, rParkFrom),
    grid,
  );
}

/** Plan and schedule a transfer to a Lagrange point of the (parent, `secondaryId`) pair. The
 *  Lambert leg is solved in the cruise frame and the arrival is a single velocity match. null if
 *  the geometry is degenerate, the ship is landed, or a geocentric pair's frame doesn't match. */
export function planLagrange(
  sim: Simulation, shipId: string, secondaryId: string, point: LagrangePoint,
  tDepart: number, tArrive: number,
): TransferPlan | null {
  const ship = sim.world.ships.get(shipId);
  const secondary = BODY_BY_ID.get(secondaryId);
  if (!ship || ship.landed || tArrive <= tDepart || !secondary || !lagrangeEligible(secondary)) return null;
  const depBody = BODY_BY_ID.get(ship.primary);
  if (!depBody) return null;
  const central = lagrangeCentral(secondary);
  const tof = tArrive - tDepart;
  let dvDepart: number;
  let dvArrive: number;
  if (central !== undefined) {
    const cen = BODY_BY_ID.get(central)!;
    if (ship.primary !== cen.id) return null;
    const dep = shipRelativeState(ship, tDepart);
    const arr = lagrangeStateRelative(secondary, point, tArrive);
    const sol = lambert(dep.r, arr.r, tof, cen.mu, true);
    if (!sol) return null;
    if (!outboundClearsParent(dep.r, sol.v1, cen.mu, cen.radius)) return null;
    dvDepart = length(sub(sol.v1, dep.v));
    dvArrive = length(sub(sol.v2, arr.v));
  } else {
    const depState = bodyState(depBody, tDepart);
    const arr = lagrangeState(secondary, point, tArrive);
    const sol = lambert(depState.r, arr.r, tof, MU_SUN, true);
    if (!sol) return null;
    const el = shipOsculatingElements(ship, sim.world.t);
    const rPark = periapsisRadius(el.a, el.e);
    dvDepart = hyperbolicBurnDv(length(sub(sol.v1, depState.v)), depBody.mu, rPark);
    dvArrive = length(sub(sol.v2, arr.v)); // velocity match — no well, no Oberth
  }
  ship.transfer = {
    targetId: secondaryId, tDepart, tArrive, dvDepart, dvArrive,
    departed: false, inSoi: false, arrived: false, arrival: { kind: "lagrange", point },
    ...(central !== undefined ? { central } : {}),
  };
  sim.events.push({ t: tDepart, kind: "transfer-depart", entityId: shipId });
  return { dvDepart, dvArrive, tof };
}

/** Forget a planned transfer (a stale scheduled departure is ignored later). */
export function cancelTransfer(sim: Simulation, shipId: string): void {
  const ship = sim.world.ships.get(shipId);
  if (ship) ship.transfer = undefined;
}

/** How a gravity-assist (or chain) arrival captures at the target: a low circular
 *  burn by default, an Oberth-cheap loose ellipse (`captureApoAlt`), or — at a body
 *  with an atmosphere — an aerocapture drag pass. */
export type CaptureMode = "propulsive" | "aerocapture";
export interface CaptureChoice {
  /** Transfer fields to merge (captureApoAlt for an ellipse, aeroPeriAlt for aerocapture). */
  fields: Pick<ShipTransfer, "captureApoAlt" | "aeroPeriAlt">;
  dvArrive: number; // the capture/trim Δv actually paid at arrival (m/s)
}

/**
 * Resolve a gravity-assist arrival's capture at `target` given the hyperbolic excess
 * speed `vInfArrive`. Mirrors `planTransfer`'s capture choices so an assist/chain can
 * insert the realistic way real deep-well orbiters do — a few-km/s elliptical SOI
 * insertion (or an atmospheric pass) instead of a ~17 km/s low-circular burn. Returns
 * null if aerocapture is asked for at an airless body / the corridor is infeasible.
 */
function resolveAssistCapture(
  target: BodyDef, vInfArrive: number, captureMode: CaptureMode, captureApoAlt?: number,
): CaptureChoice | null {
  if (captureMode === "aerocapture") {
    if (!target.atmosphere) return null;
    const ac = aerocapture(target, NOMINAL_ENTRY_VEHICLE, {
      vInf: vInfArrive,
      targetApoAlt: Math.max(2e6, target.radius),
      targetPeriAlt: DEFAULT_CAPTURE_ALT,
    });
    if (!ac || !ac.feasible) return null;
    return { fields: { aeroPeriAlt: ac.periapsisAlt }, dvArrive: ac.trimDv };
  }
  const rParkTo = target.radius + DEFAULT_CAPTURE_ALT;
  const dvArrive = captureApoAlt !== undefined
    ? ellipticalCaptureDv(vInfArrive, target.mu, rParkTo, target.radius + captureApoAlt)
    : hyperbolicBurnDv(vInfArrive, target.mu, rParkTo);
  return { fields: captureApoAlt !== undefined ? { captureApoAlt } : {}, dvArrive };
}

/** Read-only preview of an assist/chain arrival's capture Δv for a given excess speed and
 *  mode — circular, loose ellipse, or aerocapture trim. null if aerocapture is infeasible
 *  here. Lets the planner show the real capture cost (and saving) for a gravity-assist route. */
export function assistCapturePreview(
  targetId: string, vInfArrive: number, captureMode: CaptureMode, captureApoAlt?: number,
): { dvArrive: number; aero: boolean } | null {
  const target = BODY_BY_ID.get(targetId);
  if (!target) return null;
  const cap = resolveAssistCapture(target, vInfArrive, captureMode, captureApoAlt);
  return cap ? { dvArrive: cap.dvArrive, aero: cap.fields.aeroPeriAlt !== undefined } : null;
}

/**
 * Plan and schedule a single-flyby gravity-assist mission: leg 1 to `flybyId`,
 * a slingshot past it, then leg 2 to `targetId`. Records the transfer (with its
 * flyby leg) and queues the departure; the sim flies depart → flyby-pass → capture
 * using the existing patched-conic machinery. `captureMode`/`captureApoAlt` pick the
 * arrival capture (low circular · cheap loose ellipse · aerocapture), exactly as a
 * direct transfer can — so an assist arrival at a giant captures for a few km/s of
 * elliptical insertion, not the ~17 km/s a low circular orbit costs. Returns the
 * assist estimate (its `dvArrive` reflects the chosen capture) or null.
 */
export function planAssist(
  sim: Simulation,
  shipId: string,
  flybyId: string,
  targetId: string,
  tDepart: number,
  tFlyby: number,
  tArrive: number,
  captureMode: CaptureMode = "propulsive",
  captureApoAlt?: number,
): AssistResult | null {
  const ship = sim.world.ships.get(shipId);
  if (!ship || ship.landed || tFlyby <= tDepart || tArrive <= tFlyby) return null; // launch to LEO first
  const depBody = BODY_BY_ID.get(ship.primary);
  const target = BODY_BY_ID.get(targetId);
  if (!depBody || !target) return null;
  const el = shipOsculatingElements(ship, sim.world.t);
  const rParkFrom = periapsisRadius(el.a, el.e);
  const res = assistTransfer(ship.primary, flybyId, targetId, tDepart, tFlyby, tArrive, { rParkFrom });
  if (!res) return null;
  const cap = resolveAssistCapture(target, res.vInfArrive, captureMode, captureApoAlt);
  if (!cap) return null; // aerocapture asked for where it can't be flown
  ship.transfer = {
    targetId, tDepart, tArrive,
    dvDepart: res.dvDepart, dvArrive: cap.dvArrive,
    departed: false, inSoi: false, arrived: false,
    flybys: [{ bodyId: flybyId, tFlyby, dvBurn: res.dvFlyby, done: false }],
    ...cap.fields,
  };
  sim.events.push({ t: tDepart, kind: "transfer-depart", entityId: shipId });
  return { ...res, dvArrive: cap.dvArrive, dvTotal: res.dvDepart + res.dvFlyby + cap.dvArrive };
}

/**
 * Plan and schedule a MULTI-flyby gravity-assist chain: `bodyIds` lists every body
 * in order — origin → flyby₁ → … → target (length ≥ 3) — with `times` the epoch at
 * each (strictly increasing). Records the transfer with one `FlybyLeg` per intermediate
 * body and queues the departure; the sim flies depart → flyby-pass×N → capture. Returns
 * the chain estimate, or null if the schedule is degenerate / the ship's parking orbit
 * is unknown.
 */
export function planChainAssist(
  sim: Simulation,
  shipId: string,
  bodyIds: string[],
  times: number[],
  captureMode: CaptureMode = "propulsive",
  captureApoAlt?: number,
): ChainAssistResult | null {
  const ship = sim.world.ships.get(shipId);
  if (!ship || ship.landed || bodyIds.length < 3 || bodyIds.length !== times.length) return null; // launch to LEO first
  if (bodyIds[0] !== ship.primary) return null; // the chain must start where the ship is
  const targetId = bodyIds[bodyIds.length - 1]!;
  const target = BODY_BY_ID.get(targetId);
  if (!target) return null;
  const el = shipOsculatingElements(ship, sim.world.t);
  const rParkFrom = periapsisRadius(el.a, el.e);
  const res = chainAssist(bodyIds, times, { rParkFrom });
  if (!res) return null;
  const cap = resolveAssistCapture(target, res.vInfArrive, captureMode, captureApoAlt);
  if (!cap) return null; // aerocapture asked for where it can't be flown
  ship.transfer = {
    targetId,
    tDepart: times[0]!, tArrive: times[times.length - 1]!,
    dvDepart: res.dvDepart, dvArrive: cap.dvArrive,
    departed: false, inSoi: false, arrived: false,
    flybys: res.flybys.map((f) => ({ bodyId: f.bodyId, tFlyby: f.t, dvBurn: f.dvFlyby, done: false })),
    ...cap.fields,
  };
  sim.events.push({ t: times[0]!, kind: "transfer-depart", entityId: shipId });
  return { ...res, dvArrive: cap.dvArrive, dvTotal: res.dvDepart + res.dvFlybyTotal + cap.dvArrive };
}

// ── Surface operations: landing & takeoff ────────────────────────────────────

/** The vehicle-specific ascent/descent parameters of a ship at a body: its real
 *  liftoff thrust-to-weight (against the body's surface gravity) and exhaust
 *  velocity, from the active stage. Exported so the ship panel can show the live
 *  budget with the same numbers the land/launch commands will charge. */
export function shipSurfaceParams(ship: Ship, body: { mu: number; radius: number }, parkingAlt: number): AscentParams {
  const stage = activeStage(ship);
  // Liftoff thrust AND exhaust velocity count every strap-on booster igniting with the
  // core (a serial stage reduces to its own thrust/Isp exactly). Using core-only figures
  // understates a boostered launcher's liftoff T/W — a Shuttle/Soyuz/Falcon Heavy/Ariane
  // would read T/W < 1 and "fail" to lift off in the budget integrator.
  // Only forward a POSITIVE exhaust velocity; a degenerate Isp≤0 stage (a corrupt save
  // or hand-built design) would otherwise drive ṁ = T/0 = ∞ in the budget integrator. A
  // non-positive ve falls through to ascentBudget's documented default. (The designer
  // clamps Isp ≥ 1; this is the load-bearing engine-side guard.)
  const veRaw = stage ? stageLiftoffExhaust(stage) : 0;
  const ve = veRaw > 0 ? veRaw : undefined;
  const gSurf = body.mu / (body.radius * body.radius);
  const twr = stage ? stageLiftoffThrust(stage) / (totalMass(ship) * gSurf) : 1;
  return { parkingAlt, twr, ...(ve !== undefined ? { exhaustVelocity: ve } : {}) };
}

/**
 * Dispatch a ship on a constant-proper-acceleration interstellar crossing to a
 * star: a flip-and-burn flown ANALYTICALLY in-sim (watch it cross over years,
 * with the comms light-lag stretching to years too). Returns the relativistic
 * transit estimate, or null. `exhaustVelocity` (default photon-class c) sizes the
 * mass-ratio estimate; the propellant is NOT drawn from the classical staged
 * economy — sustained-g torchships are the relativistic regime the catalog flags
 * (PENDING_RELATIVISTIC), so this commits the trajectory and reports what it would
 * physically require.
 */
export function dispatchInterstellar(
  sim: Simulation,
  shipId: string,
  starId: string,
  properAccel: number,
  exhaustVelocity: number = C,
): InterstellarTransit | null {
  const ship = sim.world.ships.get(shipId);
  const star = STAR_BY_ID.get(starId);
  if (!ship || !star || ship.mode !== "coast" || ship.landed || properAccel <= 0) return null;
  const transit = torchTransit({ exhaustVelocity, properAccel }, star);
  if (!transit) return null;

  const t = sim.world.t;
  const startPos = shipWorldState(ship, t).r;
  // Lead the target: aim at the star's position on arrival, then re-solve the
  // brachistochrone against that actual flight distance so (properAccel, D, T)
  // stay mutually consistent with the leg's read-time shaping. One refinement
  // pass; the residual (the star moves between the estimate and the refined
  // arrival) is second-order over a single voyage.
  const tArrive0 = t + transit.coordinateTimeYr * JULIAN_YEAR;
  const dActual = distance(starPosition(star, tArrive0), startPos);
  const tArrive = t + brachistochrone(properAccel, dActual).coordinateTime;
  ship.interstellarLeg = {
    targetStar: starId,
    tDepart: t,
    tArrive,
    properAccel,
    startPos,
  };
  ship.transfer = undefined;
  ship.primary = "sun";
  ship.mode = "coast";
  ship.r = undefined;
  ship.v = undefined;
  ship.elements = undefined;
  ship.epoch = t;
  return transit;
}

/**
 * The ships currently crossing interstellar space — those on an active
 * `interstellarLeg` and not lost — as `{id, name}`, sorted by name for a stable
 * display order. A pure read-only world query (the established pattern, like
 * `dockCandidates`): it drives the HUD's interstellar FOLLOW selector and is the
 * unit-tested core of the follow feature. The camera follow itself is render-only,
 * so this adds no world state and leaves the golden hash untouched.
 */
export function interstellarFleet(world: WorldState): { id: string; name: string }[] {
  return [...world.ships.values()]
    .filter((s) => s.interstellarLeg && s.status !== "lost")
    .map((s) => ({ id: s.id, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export interface SpiralPlan {
  dv: number; // Edelbaum Δv (m/s)
  time: number; // transfer time (s)
  propellant: number; // kg
}

/**
 * Commit an electric craft to a low-thrust spiral from its current near-circular
 * orbit to one at `targetAltKm`. The Edelbaum Δv/propellant are charged now; the
 * ship flies the analytic spiral (exact at any time-warp) and settles onto the
 * target orbit after the (long) transfer time. Returns the plan, or null if the
 * ship has no electric stage, isn't coasting about a body, or can't afford it.
 */
export function planSpiral(sim: Simulation, shipId: string, targetAltKm: number): SpiralPlan | null {
  const ship = sim.world.ships.get(shipId);
  if (!ship || ship.mode !== "coast" || ship.primary === "sun" || ship.landed || ship.interstellarLeg || ship.spiral) return null;
  const body = BODY_BY_ID.get(ship.primary);
  const stage = activeStage(ship);
  if (!body || !stage?.electric) return null;

  const t = sim.world.t;
  const el = shipOsculatingElements(ship, t);
  const r0 = el.a;
  const r1 = body.radius + targetAltKm * 1000;
  if (r1 <= 0 || Math.abs(r1 - r0) < 1) return null;

  const rHelio = length(shipWorldState(ship, t).r);
  const thrust = thrustAt(stage, rHelio);
  const ve = exhaustVelocity(stage.isp);
  const trans = edelbaumTransfer(body.mu, r0, r1, 0, thrust, ve, totalMass(ship), dvRemaining(ship));
  if (!trans.feasible || !isFinite(trans.time) || !applyImpulsiveDv(ship, trans.dv)) return null;

  ship.spiral = {
    startRadius: r0, endRadius: r1, i: el.i, Omega: el.Omega,
    phase0: wrapPi(el.omega + el.M), tStart: t, tEnd: t + trans.time,
  };
  ship.mode = "coast";
  ship.r = undefined;
  ship.v = undefined;
  ship.elements = undefined;
  ship.epoch = t;
  sim.events.push({ t: t + trans.time, kind: "spiral-arrive", entityId: shipId });
  return { dv: trans.dv, time: trans.time, propellant: trans.propellant };
}

export interface SurfaceOp {
  dv: number; // maneuver Δv (m/s)
  propellant: number; // propellant burned (kg)
  burnTime: number; // s
  feasible: boolean; // ship had the Δv to do it
}

/** Cap on the in-sim ascent/descent arc duration. A real powered launch/landing is a few
 *  hundred seconds; if the budget integrator reports an absurd burn (a very low-TWR body, or
 *  the drag-stall time guard), skip the visual leg and snap instead. */
const MAX_POWERED_LEG_S = 7200;

/**
 * Land the ship on its current primary's surface, paying the descent Δv. On an AIRLESS
 * body the powered descent is flown in-sim as a `DescentLeg` (the ship arcs down to a
 * downrange touchdown site, watchable at any time-warp); on an ATMOSPHERIC body — whose
 * realistic animated descent is the drag pass (`flyEntry`/`EntryLeg`) — and in degenerate
 * cases the touchdown is snapped as before. The Δv/propellant are charged at commit either
 * way. Returns the cost, or null if the body has no surface or the ship isn't coasting in
 * its SOI. When the ship can't afford it, the op is returned with feasible:false and nothing
 * is spent.
 */
export function landShip(sim: Simulation, shipId: string): SurfaceOp | null {
  const ship = sim.world.ships.get(shipId);
  if (!ship || ship.landed || ship.mode !== "coast") return null;
  if (ship.launchLeg || ship.descentLeg) return null; // a powered leg already owns the state
  const body = BODY_BY_ID.get(ship.primary);
  if (!body || body.hasSurface === false) return null;

  const el = shipOsculatingElements(ship, sim.world.t);
  const alt = Math.max(0, periapsisRadius(el.a, el.e) - body.radius);
  const samples: PoweredSample[] = [];
  const desc = descentBudget(body, shipSurfaceParams(ship, body, alt), samples);
  if (!desc) return null;
  const cost = surfaceManeuverCost(ship.stages.slice(ship.activeStage), ship.payloadMass, desc.dvTotal);
  if (cost.feasible < 0 || !applyImpulsiveDv(ship, desc.dvTotal)) {
    return { dv: desc.dvTotal, propellant: cost.propellant, burnTime: cost.burnTime, feasible: false };
  }
  const t = sim.world.t;
  const ret = { dv: desc.dvTotal, propellant: cost.propellant, burnTime: cost.burnTime, feasible: true };

  // Airless body with a real powered-descent duration: fly the descent arc in-sim. The
  // `land-arrive` finalize sets `ship.landed` at the (downrange) touchdown site.
  if (!body.atmosphere && desc.burnTime !== undefined && desc.burnTime > 0 && desc.burnTime < MAX_POWERED_LEG_S && samples.length >= 2) {
    const st = shipRelativeState(ship, t);
    const leg = buildDescentLeg(body, st.r, st.v, t, desc.burnTime, samples);
    ship.descentLeg = leg;
    ship.mode = "coast";
    ship.r = undefined;
    ship.v = undefined;
    ship.elements = undefined;
    ship.epoch = t;
    sim.events.push({ t: leg.tEnd, kind: "land-arrive", entityId: shipId });
    return ret;
  }

  // Snap fallback (atmosphere / degenerate): land directly below the current orbital
  // position; store the site as a body-fixed direction (un-tilt the obliquity + de-rotate by
  // the body's rotation angle) so the ship co-rotates with the surface from here on.
  const dir = normalize(shipRelativeState(ship, t).r);
  const surfaceDir = inertialDirToSurface(body, dir, t);
  ship.mode = "coast";
  ship.r = undefined;
  ship.v = undefined;
  ship.elements = undefined;
  ship.epoch = t;
  ship.landed = { bodyId: body.id, surfaceDir };
  return ret;
}

/** The predicted budget of an entry pass committed by flyEntry, for the UI. */
export interface EntryPlan {
  tStart: number; // s since J2000 — when the pass begins (the interface crossing)
  outcome: "landed" | "captured" | "skip-out" | "crashed";
  peakDecelG: number;
  peakHeatFlux: number;
  peakWallTemp: number;
  heatLoad: number;
}

/**
 * Fly the ship's current orbit into the atmosphere in-sim instead of teleporting it
 * down: schedule an entry pass at the next atmospheric-interface crossing. The ship
 * keeps coasting until then; at the interface it flies a ballistic (no-propellant)
 * drag trajectory you can watch at any time-warp, ending in landed / captured /
 * skip-out / crashed. Returns the predicted budget, or null if the ship isn't a coasting ship
 * in an atmosphere's SOI whose orbit actually dips into the atmosphere.
 */
export function flyEntry(sim: Simulation, shipId: string): EntryPlan | null {
  const ship = sim.world.ships.get(shipId);
  if (!ship || ship.landed || ship.mode !== "coast") return null;
  if (ship.entryLeg || ship.interstellarLeg || ship.spiral || ship.transfer) return null;
  const body = BODY_BY_ID.get(ship.primary);
  if (!body || body.hasSurface === false || !body.atmosphere || ship.primary === "sun") return null;

  const el = shipOsculatingElements(ship, sim.world.t);
  const x = entryInterfaceCrossing(body, el);
  if (!x) return null; // orbit never reaches the atmosphere
  const res = entryTrajectory(body, NOMINAL_ENTRY_VEHICLE, { entrySpeed: x.entrySpeed, flightPathAngle: x.flightPathAngle });
  if (!res) return null;

  const tStart = sim.world.t + x.dtToInterface;
  sim.events.push({ t: tStart, kind: "entry-start", entityId: shipId });
  return {
    tStart, outcome: res.outcome, peakDecelG: res.peakDecelG,
    peakHeatFlux: res.peakHeatFlux, peakWallTemp: res.peakWallTemp, heatLoad: res.heatLoad,
  };
}

/**
 * Launch a landed ship to a circular parking orbit at `altitudeKm`, paying the ascent Δv.
 * The powered ascent is flown in-sim as a `LaunchLeg` (the ship arcs up from the surface to
 * the parking orbit, watchable at any time-warp); a `launch-arrive` finalize seats it on the
 * parking orbit at `tEnd`. A degenerate climb (drag-stalled / absurd burn time) snaps as
 * before. Returns the cost, or null if the ship isn't landed. feasible:false (nothing spent)
 * if it can't afford the climb.
 */
export function launchShip(
  sim: Simulation, shipId: string, altitudeKm: number, opts: { instant?: boolean } = {},
): SurfaceOp | null {
  const ship = sim.world.ships.get(shipId);
  if (!ship || !ship.landed) return null;
  const body = BODY_BY_ID.get(ship.landed.bodyId);
  if (!body) return null;

  const alt = altitudeKm * 1000;
  const samples: PoweredSample[] = [];
  const asc = ascentBudget(body, shipSurfaceParams(ship, body, alt), samples);
  if (!asc) return null;
  const cost = surfaceManeuverCost(ship.stages.slice(ship.activeStage), ship.payloadMass, asc.dvTotal);
  // A NON-CONVERGED ascent (the vehicle drag-stalled below orbital velocity within the
  // ~16 km/s integrator cap — e.g. a thick lower atmosphere) reports a LOWER-BOUND dvTotal;
  // it has not reached orbit, so treat it as infeasible and charge nothing. Guarding it
  // before applyImpulsiveDv keeps launchShip in step with ascentPreview's reachesOrbit and
  // never teleports a stalled vehicle into a parking orbit on a fictitious budget.
  if (!asc.converged || cost.feasible < 0 || !applyImpulsiveDv(ship, asc.dvTotal)) {
    return { dv: asc.dvTotal, propellant: cost.propellant, burnTime: cost.burnTime, feasible: false };
  }
  const t = sim.world.t;
  const ret = { dv: asc.dvTotal, propellant: cost.propellant, burnTime: cost.burnTime, feasible: true };
  // The launch-site latitude is the minimum inclination reachable from there.
  const incl = Math.asin(Math.max(-1, Math.min(1, ship.landed.surfaceDir.z)));

  // Fly the ascent arc in-sim unless the climb is degenerate (drag-stalled, or an absurd
  // multi-hour integration) — then fall back to the instant snap. `opts.instant` (the
  // express-to-LEO path) always snaps: same Δv charge, no animated leg.
  if (!opts.instant && asc.converged && asc.burnTime > 0 && asc.burnTime < MAX_POWERED_LEG_S && samples.length >= 2) {
    const liftoff = landedRelativeState(ship, t); // capture the surface state before clearing landed
    const leg = buildLaunchLeg(body, liftoff.r, liftoff.v, alt, t, asc.burnTime, samples);
    ship.launchLeg = leg;
    ship.landed = undefined;
    ship.mode = "coast";
    ship.r = undefined;
    ship.v = undefined;
    ship.elements = undefined;
    ship.epoch = t;
    sim.events.push({ t: leg.tEnd, kind: "launch-arrive", entityId: shipId });
    return ret;
  }

  // Snap fallback: insert into a circular orbit directly.
  ship.mode = "coast";
  ship.r = undefined;
  ship.v = undefined;
  ship.elements = circularOrbit(body.radius + alt, Math.abs(incl), 0, 0);
  ship.epoch = t;
  ship.landed = undefined;
  return ret;
}
