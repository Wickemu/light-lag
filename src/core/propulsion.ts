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

/** A propulsion stage: its own structure (dry) and propellant, plus its engine.
 *  An `electric` stage is power-limited: its `thrust` is the rated value at full
 *  power (1 AU for solar), and the real thrust derates with distance. */
export interface Stage {
  name: string;
  dryMass: number; // kg, structure that is dropped when the stage is spent
  propMass: number; // kg, propellant remaining
  isp: number; // s, specific impulse
  thrust: number; // N — rated/max thrust (at full power for an electric stage)
  electric?: ElectricSource;
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

export interface DvBudget {
  total: number; // m/s, sum over all stages
  perStage: number[]; // m/s per stage, in firing order
  wetMass: number; // kg, fully fuelled
  finalMass: number; // kg, after all stages spent (= payload)
}

/**
 * Total Δv of a staged stack with `payload` (non-propulsive mass) on top and
 * stages firing in array order (index 0 first). Each stage lifts everything
 * above it; spent stages are dropped.
 */
export function deltaVBudget(stages: Stage[], payload: number): DvBudget {
  let current = payload + stages.reduce((s, st) => s + st.dryMass + st.propMass, 0);
  const wetMass = current;
  const perStage: number[] = [];
  let total = 0;
  for (const st of stages) {
    const ve = exhaustVelocity(st.isp);
    const m0 = current;
    const mf = current - st.propMass;
    const dv = mf > 0 ? ve * Math.log(m0 / mf) : 0;
    perStage.push(dv);
    total += dv;
    current = mf - st.dryMass; // drop the spent stage
  }
  return { total, perStage, wetMass, finalMass: current };
}

/** Initial thrust-to-weight (against g₀) of the first stage of a fuelled stack. */
export function initialTWR(stages: Stage[], payload: number): number {
  if (stages.length === 0) return 0;
  const wet = payload + stages.reduce((s, st) => s + st.dryMass + st.propMass, 0);
  return stages[0]!.thrust / (wet * G0);
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
