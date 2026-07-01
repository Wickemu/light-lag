/**
 * The rocket equation — the heart of the game's economy.
 *
 * There is no money in LIGHTLAG; there is mass, and the violence with which you
 * can throw it. Tsiolkovsky's equation, Δv = vₑ·ln(m₀/m_f), is the iron law:
 * every maneuver costs propellant, and propellant is mass you first had to haul.
 * High exhaust velocity (Isp) buys Δv cheaply but, for a given power, comes with
 * low thrust; high thrust burns propellant fast. That tension IS ship design.
 *
 * SI throughout: mass kg, velocity m/s, thrust N, Isp s, power W.
 */

import { AU, C, G0 } from "./constants.ts";

/**
 * Power source for an electric (ion/Hall/MPD) stage. Electric thrusters are
 * POWER-limited, not propellant-limited: F = 2·η·P/vₑ. A solar array's power
 * falls as 1/r², so a solar-electric craft loses thrust as it moves away from the
 * Sun; a reactor's power is constant. `powerW` is the rated electrical power at
 * 1 AU (solar) or always (nuclear).
 */
export interface ElectricSource {
  powerW: number; // rated electrical power at 1 AU (W)
  eta: number; // electrical → jet efficiency
  solar: boolean; // true: P ∝ (AU/r)²; false: nuclear (constant)
}

/**
 * A strap-on booster: an independent engine + tank bolted to a parent stage that
 * ignites WITH it and burns concurrently (parallel staging), dropping the instant
 * its own propellant is spent while the core keeps firing. This is the real
 * liftoff configuration of the Space Shuttle, Soyuz, Falcon Heavy, Ariane 5, and
 * the SRB-augmented EELVs. A booster has the same shape as a chemical/solid
 * `Stage` minus the nesting and electric power source — boosters never nest and
 * are always thrust-limited (chemical/solid).
 *
 * `count` (default 1) aggregates identical boosters that ignite and drop together
 * (e.g. Soyuz's four), letting the catalog state true PER-UNIT figures; the
 * budget and integrator multiply `thrust`, `dryMass`, `propMass`, and ṁ by it.
 * A drop tank (a propellant reservoir feeding the core's engine, no engine of its
 * own) is NOT a booster — a zero-thrust booster would never drain — and is out of
 * scope; fold such a tank into its core stage (e.g. the Shuttle's external tank).
 */
export interface Booster {
  name: string;
  dryMass: number; // kg, structure dropped when this booster is spent (per unit)
  propMass: number; // kg, propellant (per unit)
  isp: number; // s, specific impulse
  thrust: number; // N — rated/max thrust (per unit)
  count?: number; // identical units igniting/dropping together (default 1)
}

/** A propulsion stage: its own structure (dry) and propellant, plus its engine.
 *  An `electric` stage is power-limited: its `thrust` is the rated value at full
 *  power (1 AU for solar), and the real thrust derates with distance. Optional
 *  `boosters` ignite WITH this stage and burn in parallel (see `Booster`). */
export interface Stage {
  name: string;
  dryMass: number; // kg, structure that is dropped when the stage is spent
  propMass: number; // kg, propellant remaining
  isp: number; // s, specific impulse
  thrust: number; // N — rated/max thrust (at full power for an electric stage)
  electric?: ElectricSource;
  boosters?: Booster[]; // strap-ons igniting with this stage (parallel staging)
  /** Tank capacity (kg): the as-built full propellant load, the structural ceiling
   *  an orbital REFUELLING (see refuel.ts) may fill this stage back up to. Set at
   *  spawn (= the design's propMass); absent ⇒ the stage was never tracked, so its
   *  capacity is taken as the current propMass (it cannot be over-filled). Burns and
   *  staging only ever lower propMass; capacity is fixed once set. */
  propCapacity?: number;
  /** Cryogenic-propellant BOIL-OFF rate: the fraction of this stage's propellant lost
   *  per DAY at 1 AU (see boiloff.ts). Set only on cryogenic stages (LH₂/LOX, LCH₄/LOX);
   *  storable, solid, and electric stages omit it entirely (⇒ no boil-off). The actual
   *  rate scales with solar flux — (AU/r)² at the ship's heliocentric distance — so cryo
   *  storage is far easier in the outer system. Absent ⇒ the stage never boils off, so a
   *  storable design (and the golden scenario) serialize identically to before the model. */
  boiloff?: number;
}

/** Effective exhaust velocity vₑ = Isp · g₀ (g₀ defines Isp; it is not gravity). */
export function exhaustVelocity(isp: number): number {
  return isp * G0;
}

/** Propellant mass flow rate ṁ = F / vₑ (kg/s). */
export function massFlow(thrust: number, ve: number): number {
  return thrust / ve;
}

/** Tsiolkovsky: the Δv unlocked by burning from wet mass m0 to dry mass mf. */
export function tsiolkovsky(ve: number, m0: number, mf: number): number {
  return ve * Math.log(m0 / mf);
}

/** Propellant needed to achieve `dv` starting from mass m0: m0·(1 − e^(−Δv/vₑ)). */
export function propellantForDv(ve: number, m0: number, dv: number): number {
  return m0 * (1 - Math.exp(-dv / ve));
}

/** Δv delivered by burning `mProp` propellant from mass m0. */
export function dvForPropellant(ve: number, m0: number, mProp: number): number {
  return ve * Math.log(m0 / (m0 - mProp));
}

/** Electric-propulsion thrust from input power: F = 2·η·P / vₑ (jet power = ½F·vₑ). */
export function electricThrust(power: number, ve: number, eta: number): number {
  return (2 * eta * power) / ve;
}

/** Available electrical power (W) of an electric source at heliocentric distance
 *  r (m): a solar array falls as (AU/r)² (capped at its rated value closer in,
 *  where the array/PPU regulate); a reactor is constant. */
export function availablePowerW(src: ElectricSource, r: number): number {
  return src.solar ? src.powerW * Math.min(1, (AU / r) ** 2) : src.powerW;
}

/** The ACTUAL thrust (N) of a stage at heliocentric distance r (m). For an
 *  electric stage this is the power-limited F = 2ηP(r)/vₑ, capped at the rated
 *  thrust; for a chemical stage it is simply the rated thrust (distance-independent). */
export function thrustAt(stage: Stage, r: number): number {
  if (!stage.electric) return stage.thrust;
  const ve = exhaustVelocity(stage.isp);
  return Math.min(stage.thrust, electricThrust(availablePowerW(stage.electric, r), ve, stage.electric.eta));
}

/** Jet (beam) power ½·ΣF·vₑ (W) of a stage's LIVE reservoirs at heliocentric
 *  distance r: the core's distance-derated `thrustAt()` (a solar-electric stage
 *  falls as 1/r²; a chemical core is the flat rated thrust) — counted only while
 *  the core still has propellant — plus every strap-on booster still carrying
 *  propellant (`b.thrust·count·vₑ`, dropped once empty). Mirrors the burn
 *  integrator (`advanceBoosteredSegment`, sim.ts), which drops the core burner
 *  once `stage.propMass` empties: in the "dead core, live booster" phase (a
 *  longer-lived booster still firing past a drained core) the inert core produces
 *  no jet. The single source of truth for "what the live engine set is actually
 *  putting out", shared by that integrator's energetics and the thermal
 *  waste-heat model so a derated, boostered, or part-spent drive can never report
 *  two different signatures. ½·F·vₑ is the jet power: jet KE flow = ½·ṁ·vₑ² = ½·F·vₑ. */
export function liveJetPowerW(stage: Stage, r: number): number {
  // Core only while fuelled (1e-9 kg floor matches stagePhases / advanceBoosteredSegment).
  let jet = stage.propMass > 1e-9 ? 0.5 * thrustAt(stage, r) * exhaustVelocity(stage.isp) : 0;
  if (stage.boosters) {
    for (const b of stage.boosters) {
      if (b.propMass > 0) jet += 0.5 * b.thrust * boosterCount(b) * exhaustVelocity(b.isp);
    }
  }
  return jet;
}

// ── Variable specific impulse (constant-power throttling) ────────────────────
//
// A fixed-Isp ion engine throws mass at one speed; a VARIABLE-Isp drive (VASIMR,
// a throttled gridded ion PPU) trades thrust for exhaust velocity at a fixed input
// power. The constraint is the jet-power identity F·vₑ = 2·η·P: at constant power,
// dialling the Isp UP (more vₑ) drops the thrust proportionally — frugal with
// propellant but slow — while dialling it DOWN buys thrust at the cost of mass
// flow. Same hardware, same watts; the pilot picks the operating point per leg.

/** Jet (beam) power η·P (W) delivered to the exhaust — the budget F·vₑ/2 is drawn
 *  from. Half the input electrical power lost to η goes nowhere useful. */
export function jetPower(power: number, eta: number): number {
  return eta * power;
}

/** The exhaust velocity vₑ (m/s) a constant-power drive must run at to produce a
 *  given `thrust`: vₑ = 2·η·P / F. The variable-Isp knob inverted — choose a
 *  thrust, read off the Isp (vₑ/g₀) it forces. Higher thrust ⇒ lower Isp. */
export function exhaustForThrust(power: number, eta: number, thrust: number): number {
  return (2 * eta * power) / thrust;
}

export interface VariableIspBurn {
  ve: number; // chosen exhaust velocity (m/s)
  isp: number; // = ve/g₀ (s)
  thrust: number; // resulting thrust at the fixed power (N) — F = 2ηP/vₑ
  propellant: number; // kg burned to deliver dv from m0
  mdot: number; // mass-flow ṁ = F/vₑ (kg/s)
  time: number; // burn time = propellant / ṁ (s)
}

/**
 * Operate a constant-power electric drive at a CHOSEN exhaust velocity vₑ (the
 * variable-Isp knob) to deliver `dv` from start mass `m0`. At fixed power the
 * thrust follows F = 2ηP/vₑ, so a higher Isp spends less propellant (∝ 1/vₑ for
 * small Δv) but produces less thrust and a longer burn (time ∝ vₑ). This is the
 * thrust↔Isp↔time trade made explicit; `power` is the power actually available
 * at the craft's distance (use availablePowerW). Reduces to the fixed-Isp case
 * when vₑ is held at the engine's nominal value.
 */
export function variableIspBurn(
  power: number, eta: number, ve: number, m0: number, dv: number,
): VariableIspBurn {
  const thrust = electricThrust(power, ve, eta);
  const propellant = propellantForDv(ve, m0, dv);
  const mdot = ve > 0 ? thrust / ve : 0;
  const time = mdot > 0 ? propellant / mdot : Infinity;
  return { ve, isp: ve / G0, thrust, propellant, mdot, time };
}

/** A booster's unit multiplier as a positive integer. Guards the model against a
 *  corrupt save or hand-edited `count` (0, negative, fractional, or non-finite),
 *  which would otherwise drive negative/zero mass through the budget and the sim.
 *  The designer UI clamps on input; this is the load-bearing engine-side guard. */
export function boosterCount(b: Booster): number {
  const n = b.count ?? 1;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** A stage's propellant CAPACITY (kg) — the as-built full load it may be refuelled
 *  back up to. Falls back to the current propMass when untracked, so a stage with no
 *  recorded capacity can never be over-filled. */
export function stageCapacity(stage: Stage): number {
  return stage.propCapacity ?? stage.propMass;
}

/** Free tank headroom (kg) a stage can still accept on a refuelling — capacity minus
 *  the propellant already aboard, never negative. */
export function stageHeadroom(stage: Stage): number {
  return Math.max(0, stageCapacity(stage) - stage.propMass);
}

/** Wet mass of one stage, including any strap-on boosters (count-aggregated). */
export function stageWetMass(stage: Stage): number {
  let m = stage.dryMass + stage.propMass;
  if (stage.boosters) {
    for (const b of stage.boosters) m += (b.dryMass + b.propMass) * boosterCount(b);
  }
  return m;
}

/** Liftoff thrust of one stage: its engine plus every booster igniting with it. */
export function stageLiftoffThrust(stage: Stage): number {
  let f = stage.thrust;
  if (stage.boosters) {
    for (const b of stage.boosters) f += b.thrust * boosterCount(b);
  }
  return f;
}

/** Effective exhaust velocity at LIFTOFF: the thrust-weighted vₑ_eff = F_total/ṁ_total
 *  of the core plus every booster igniting with it (NOT an Isp average) — the same
 *  combination `stagePhases` uses for a boostered stage's first phase. For a serial
 *  stage (no boosters) this is exactly `exhaustVelocity(stage.isp)`, so it changes
 *  nothing for non-boostered launchers. Used to size the ascent budget honestly for
 *  strap-on launchers (Shuttle, Soyuz, Falcon Heavy, Ariane). */
export function stageLiftoffExhaust(stage: Stage): number {
  const veCore = exhaustVelocity(stage.isp);
  if (!stage.boosters || stage.boosters.length === 0) return veCore;
  let f = stage.thrust;
  let mdot = veCore > 0 ? stage.thrust / veCore : 0;
  for (const b of stage.boosters) {
    const n = boosterCount(b);
    const veB = exhaustVelocity(b.isp);
    f += b.thrust * n;
    mdot += veB > 0 ? (b.thrust * n) / veB : 0;
  }
  return mdot > 0 ? f / mdot : veCore;
}

/** Which reservoir a slice of propellant comes from, and its share of the flow.
 *  `idx === -1` is the core stage; `idx >= 0` indexes `stage.boosters`. */
interface PhaseBurner {
  idx: number;
  mdot: number; // count-aggregated mass flow of this reservoir (kg/s)
}

/**
 * One parallel sub-phase of a (possibly boostered) stage's burn: a fixed set of
 * reservoirs burning together at a constant effective exhaust velocity, ending
 * when the soonest reservoir empties and its dry mass is jettisoned.
 */
interface StagePhase {
  veEff: number; // effective exhaust velocity F_total/ṁ_total while this set burns
  propBurned: number; // total propellant consumed in this phase (kg)
  dryDropped: number; // dry mass jettisoned at the end of this phase (kg)
  burners: PhaseBurner[]; // the reservoirs burning in this phase, with flow shares
}

/**
 * Decompose a stage into its parallel burn phases. A serial stage (no boosters)
 * is a single phase — burn all propellant at vₑ, drop the dry mass — identical to
 * the old per-stage step. A boostered stage burns core + boosters concurrently:
 * each phase uses the thrust-weighted vₑ_eff = F/ṁ (NOT an Isp average) of the
 * live reservoirs, and ends when the shortest-burning one empties and drops. The
 * core's dry mass is held until the stage fully ends (the core structure carries
 * the boosters); a booster that outlasts the core keeps pushing the dead core
 * until it too empties.
 */
function stagePhases(stage: Stage): StagePhase[] {
  const veCore = exhaustVelocity(stage.isp);
  if (!stage.boosters || stage.boosters.length === 0) {
    // Serial stage: one phase. Arithmetic matches the legacy per-stage step
    // exactly, so existing stacks (and the golden scenario) are unchanged.
    return [{
      veEff: veCore, propBurned: stage.propMass, dryDropped: stage.dryMass,
      burners: [{ idx: -1, mdot: veCore > 0 ? massFlow(stage.thrust, veCore) : 0 }],
    }];
  }
  interface Res {
    idx: number; // -1 core, else booster index
    prop: number;
    mdot: number;
    thrust: number;
    dry: number;
    isCore: boolean;
  }
  // A reservoir with vₑ ≤ 0 (Isp ≤ 0) or thrust ≤ 0 is INERT: mdot = 0 keeps it out
  // of `burning`, so it is carried as permanent ballast instead of producing
  // Infinity/NaN mass flow. (A real chemical/solid booster never hits this; it
  // defends against degenerate hand-built designs.)
  const live: Res[] = [
    { idx: -1, prop: stage.propMass, mdot: veCore > 0 ? massFlow(stage.thrust, veCore) : 0, thrust: stage.thrust, dry: stage.dryMass, isCore: true },
  ];
  stage.boosters.forEach((b, i) => {
    const n = boosterCount(b);
    const veB = exhaustVelocity(b.isp);
    const mdotB = veB > 0 ? massFlow(b.thrust * n, veB) : 0;
    live.push({ idx: i, prop: b.propMass * n, mdot: mdotB, thrust: b.thrust * n, dry: b.dryMass * n, isCore: false });
  });
  const phases: StagePhase[] = [];
  let heldCoreDry = 0; // core dry deferred while boosters still burn
  // If stagePhases is ENTERED with the core already drained while a booster is
  // still live (the booster-outlasts-core state, reached mid-burn via dvRemaining
  // or a restored save), the core never enters `burning`, so the in-loop deferral
  // below never fires and the core's dry mass would linger in finalMass forever.
  // Seed the deferral here so the final release still drops it and the budget
  // telescopes (delivered + remaining == original).
  const coreRes = live[0]!;
  // "A booster is still live" means it can still BURN (mdot > 0) — an inert
  // reservoir (Isp/thrust ≤ 0) never empties, so holding the core for it would
  // strand the core dry forever.
  const burningBoosterLeft = (): boolean => live.some((r) => !r.isCore && r.prop > 1e-9 && r.mdot > 0);
  if (coreRes.prop <= 1e-9 && burningBoosterLeft()) {
    heldCoreDry = coreRes.dry;
    coreRes.mdot = 0;
    coreRes.dry = 0;
  }
  for (;;) {
    const burning = live.filter((r) => r.prop > 1e-9 && r.mdot > 0);
    if (burning.length === 0) break;
    const F = burning.reduce((s, r) => s + r.thrust, 0);
    const mdot = burning.reduce((s, r) => s + r.mdot, 0);
    const veEff = mdot > 0 ? F / mdot : veCore;
    const tMin = Math.min(...burning.map((r) => r.prop / r.mdot));
    const propBurned = mdot * tMin;
    const burners: PhaseBurner[] = burning.map((r) => ({ idx: r.idx, mdot: r.mdot }));
    const emptied: Res[] = [];
    for (const r of burning) {
      r.prop = Math.max(r.prop - r.mdot * tMin, 0);
      if (r.prop <= 1e-9) emptied.push(r);
    }
    let dryDropped = 0;
    for (const r of emptied) {
      r.prop = 0;
      if (r.isCore && burningBoosterLeft()) {
        heldCoreDry = r.dry; // core spent but a booster still burns: carry the structure
        r.mdot = 0;
      } else {
        dryDropped += r.dry;
      }
    }
    // Stage fully done once nothing can still burn (inert ballast may remain):
    // release the held core dry so it isn't stranded in finalMass.
    if (!live.some((r) => r.prop > 1e-9 && r.mdot > 0) && heldCoreDry > 0) {
      dryDropped += heldCoreDry;
      heldCoreDry = 0;
    }
    phases.push({ veEff, propBurned, dryDropped, burners });
  }
  return phases;
}

/**
 * Δv a single stage delivers starting from total mass `m0` (payload + this stage
 * + everything above), and the mass remaining after the stage and all its
 * boosters are spent and dropped. The one source of truth for a stage's Δv,
 * shared by `deltaVBudget` and the impulsive consumption walk so the affordability
 * check and the actual burn can never disagree.
 */
export function stageDeltaV(stage: Stage, m0: number): { dv: number; finalMass: number } {
  let m = m0;
  let dv = 0;
  for (const ph of stagePhases(stage)) {
    const mBurnEnd = m - ph.propBurned;
    dv += mBurnEnd > 0 ? ph.veEff * Math.log(m / mBurnEnd) : 0;
    m = mBurnEnd - ph.dryDropped;
  }
  return { dv, finalMass: m };
}

/**
 * Impulsively deliver up to `dvWanted` of Δv from one stage (core + any boosters)
 * starting at total mass `m0`, MUTATING the reservoirs in place — draining
 * `stage.propMass` and each booster's per-unit `propMass` (spent booster groups
 * are left at zero for the caller to splice). Returns the Δv delivered and the
 * mass remaining; stops mid-phase once `dvWanted` is met, otherwise spends the
 * whole stage. Walks the SAME `stagePhases` decomposition as `stageDeltaV`, so a
 * stack's affordability (`deltaVBudget`) and its actual consumption can never
 * disagree. Reduces to the legacy closed-form serial burn when there are no
 * boosters (a single phase whose only burner is the core).
 */
export function consumeStageDv(stage: Stage, m0: number, dvWanted: number): { dvDelivered: number; finalMass: number } {
  if (dvWanted <= 0) return { dvDelivered: 0, finalMass: m0 };
  const drain = (br: PhaseBurner, kg: number): void => {
    if (br.idx === -1) stage.propMass = Math.max(stage.propMass - kg, 0);
    else {
      const b = stage.boosters![br.idx]!;
      b.propMass = Math.max(b.propMass - kg / boosterCount(b), 0);
    }
  };
  let m = m0;
  let delivered = 0;
  for (const ph of stagePhases(stage)) {
    const mBurnEnd = m - ph.propBurned;
    const phaseDv = mBurnEnd > 0 ? ph.veEff * Math.log(m / mBurnEnd) : 0;
    const need = dvWanted - delivered;
    const mdotSum = ph.burners.reduce((s, br) => s + br.mdot, 0);
    if (phaseDv <= need + 1e-9) {
      // Full phase: each reservoir gives its share of this phase's propellant.
      for (const br of ph.burners) drain(br, ph.propBurned * (br.mdot / mdotSum));
      m = mBurnEnd - ph.dryDropped;
      delivered += phaseDv;
      if (delivered >= dvWanted - 1e-9) break;
    } else {
      // Partial phase: drain just enough to reach dvWanted; nothing drops.
      const burnTotal = m * (1 - Math.exp(-need / ph.veEff));
      for (const br of ph.burners) drain(br, burnTotal * (br.mdot / mdotSum));
      m -= burnTotal;
      delivered = dvWanted;
      break;
    }
  }
  return { dvDelivered: delivered, finalMass: m };
}

/**
 * Read-only cost of burning up to `dvWanted` from one stage (core + boosters) at
 * mass `m0`: the propellant spent, wall-clock burn time (concurrent reservoirs
 * share the time), Δv delivered, and mass remaining. The cost analog of
 * `consumeStageDv` (it mutates nothing), walking the same `stagePhases`
 * decomposition so it agrees with the budget. Reduces to the serial closed form
 * (one phase, burner = core) when there are no boosters.
 */
export function stageBurnCost(
  stage: Stage, m0: number, dvWanted: number,
): { dvDelivered: number; propUsed: number; burnTime: number; finalMass: number } {
  let m = m0;
  let delivered = 0;
  let propUsed = 0;
  let burnTime = 0;
  if (dvWanted <= 0) return { dvDelivered: 0, propUsed: 0, burnTime: 0, finalMass: m0 };
  for (const ph of stagePhases(stage)) {
    const mBurnEnd = m - ph.propBurned;
    const phaseDv = mBurnEnd > 0 ? ph.veEff * Math.log(m / mBurnEnd) : 0;
    const mdotTotal = ph.burners.reduce((s, br) => s + br.mdot, 0);
    const need = dvWanted - delivered;
    if (phaseDv >= need) {
      const p = m * (1 - Math.exp(-need / ph.veEff)); // propellant for the rest
      propUsed += p;
      burnTime += mdotTotal > 0 ? p / mdotTotal : 0;
      m -= p;
      delivered = dvWanted;
      break;
    }
    propUsed += ph.propBurned;
    burnTime += mdotTotal > 0 ? ph.propBurned / mdotTotal : 0;
    delivered += phaseDv;
    m = mBurnEnd - ph.dryDropped;
  }
  return { dvDelivered: delivered, propUsed, burnTime, finalMass: m };
}

export interface DvBudget {
  total: number; // m/s, sum over all stages
  perStage: number[]; // m/s per stage, in firing order
  wetMass: number; // kg, fully fuelled
  finalMass: number; // kg, after all stages spent (= payload)
}

/**
 * Total Δv of a staged stack with `payload` (non-propulsive mass) on top and
 * stages firing in array order (index 0 first). Each stage lifts everything
 * above it; spent stages (and their boosters) are dropped.
 */
export function deltaVBudget(stages: Stage[], payload: number): DvBudget {
  let current = payload + stages.reduce((s, st) => s + stageWetMass(st), 0);
  const wetMass = current;
  const perStage: number[] = [];
  let total = 0;
  for (const st of stages) {
    const { dv, finalMass } = stageDeltaV(st, current);
    perStage.push(dv);
    total += dv;
    current = finalMass; // drop the spent stage (and its boosters)
  }
  return { total, perStage, wetMass, finalMass: current };
}

/** Initial thrust-to-weight (against g₀) of the first stage of a fuelled stack,
 *  counting every booster that ignites with it. */
export function initialTWR(stages: Stage[], payload: number): number {
  if (stages.length === 0) return 0;
  const wet = payload + stages.reduce((s, st) => s + stageWetMass(st), 0);
  return stageLiftoffThrust(stages[0]!) / (wet * G0);
}

// ── Relativistic propulsion ──────────────────────────────────────────────────
//
// At a meaningful fraction of c, classical Tsiolkovsky badly mispredicts the
// mass ratio (and ignores time dilation). The honest relativistic forms below sit
// ALONGSIDE the classical ones — they reduce to them exactly at v≪c, ve≪c (locked
// by a test). Velocities add as RAPIDITIES φ = c·atanh(v/c), which is why the
// relativistic rocket equation is Tsiolkovsky in rapidity space. Exact special
// relativity; no approximation. All quantities are stable to v→c (built from
// atanh/tanh/asinh, never differences of nearly-equal large numbers).

/** Rapidity φ = c·atanh(v/c) (m/s-dimensioned, so it composes with vₑ). */
export function rapidity(v: number): number {
  return C * Math.atanh(v / C);
}

/** Velocity from a rapidity: v = c·tanh(φ/c). Always < c. */
export function velocityFromRapidity(phi: number): number {
  return C * Math.tanh(phi / C);
}

/** Lorentz factor γ = 1/√(1 − (v/c)²). */
export function lorentzFactor(v: number): number {
  return 1 / Math.sqrt(1 - (v / C) * (v / C));
}

/** Relativistic rocket equation: the mass ratio m₀/m_f to add a velocity change
 *  of rapidity Δφ at exhaust velocity vₑ. m₀/m_f = exp(Δφ/vₑ). Reduces to the
 *  classical e^(Δv/vₑ) when Δv ≪ c (then Δφ ≈ Δv). */
export function relativisticMassRatio(ve: number, dvRapidity: number): number {
  return Math.exp(dvRapidity / ve);
}

/** Velocity reached by burning from wet mass m₀ to dry mass m_f at exhaust
 *  velocity vₑ ≤ c: v = c·tanh((vₑ/c)·ln(m₀/m_f)). Caps at c for any finite mass
 *  ratio; the photon-rocket boundary vₑ = c is finite and sane. */
export function relativisticBurnVelocity(ve: number, m0: number, mf: number): number {
  return C * Math.tanh((ve / C) * Math.log(m0 / mf));
}

export interface RelAccelLeg {
  t: number; // coordinate (rest-frame) time of the leg (s)
  tau: number; // proper (ship-frame) time of the leg (s)
  v: number; // speed at the end of the leg (m/s)
  gamma: number; // Lorentz factor at the end of the leg
}

/** A single leg of constant PROPER acceleration `a` (m/s²) from rest over a
 *  rest-frame distance `d` (m). Exact constant-acceleration SR:
 *    t = √((d/c)² + 2d/a),  γ = 1 + a·d/c²,  v = c·√(1 − 1/γ²),  τ = (c/a)·asinh(a·t/c). */
export function relAccelLeg(a: number, d: number): RelAccelLeg {
  const t = Math.sqrt((d / C) * (d / C) + (2 * d) / a);
  const gamma = 1 + (a * d) / (C * C);
  const v = C * Math.sqrt(1 - 1 / (gamma * gamma));
  const tau = (C / a) * Math.asinh((a * t) / C);
  return { t, tau, v, gamma };
}

export interface Brachistochrone {
  coordinateTime: number; // total rest-frame time (s)
  properTime: number; // total ship-frame (crew) time (s) — < coordinateTime
  peakVelocity: number; // speed at the midpoint flip (m/s)
  peakLorentz: number; // γ at the midpoint
}

/** A coast-free "torchship" crossing of distance `d` at constant proper
 *  acceleration `a`: accelerate to the midpoint, flip, decelerate to rest —
 *  two symmetric half-distance legs. The classic 1g-to-the-stars trajectory. */
export function brachistochrone(a: number, d: number): Brachistochrone {
  const leg = relAccelLeg(a, d / 2);
  return {
    coordinateTime: 2 * leg.t,
    properTime: 2 * leg.tau,
    peakVelocity: leg.v,
    peakLorentz: leg.gamma,
  };
}
