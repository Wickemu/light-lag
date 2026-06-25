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

import { G0 } from "./constants.ts";

/** A propulsion stage: its own structure (dry) and propellant, plus its engine. */
export interface Stage {
  name: string;
  dryMass: number; // kg, structure that is dropped when the stage is spent
  propMass: number; // kg, propellant remaining
  isp: number; // s, specific impulse
  thrust: number; // N
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
