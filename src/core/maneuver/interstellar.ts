/**
 * Interstellar transit estimation — Δv, mass ratio, and (relativistic) travel
 * time to a nearby star, for two flight profiles:
 *
 *   • ballistic cruise — burn hard to a cruise speed, coast, then brake to rest
 *     at the destination (rendezvous). The boost/brake burns are idealized as
 *     impulsive (honest for the fusion-class cruise fractions where the coast
 *     dominates; documented).
 *   • constant-proper-acceleration torch — the flip-and-burn "1g to the stars"
 *     trajectory: accelerate to the midpoint, flip, decelerate to rest. Exact SR.
 *
 * Both arrive at rest (a rendezvous, not a flyby). Times are reported in BOTH the
 * rest frame (coordinate time — what Earth waits) and the ship frame (proper time
 * — what the crew ages); the two diverge by the Lorentz factor. The one-way
 * light-lag is just the distance in light-years — the comms floor that no ship
 * can beat.
 *
 * Reuses the relativistic rocket equation in propulsion.ts and the star catalog
 * in stars.ts. SI throughout.
 */

import { type StarDef, LIGHT_YEAR } from "../stars.ts";
import { C, JULIAN_YEAR } from "../constants.ts";
import {
  rapidity, relativisticMassRatio, relativisticBurnVelocity,
  brachistochrone, lorentzFactor,
} from "../propulsion.ts";

export interface InterstellarShipSpec {
  /** Effective exhaust velocity vₑ (m/s); ≤ c (vₑ = c is a photon rocket). */
  exhaustVelocity: number;
  /** Propellant mass fraction m_prop/m₀ ∈ (0,1) — the ballistic-cruise profile. */
  fuelFraction?: number;
  /** Constant proper acceleration a (m/s²) — the torch profile. */
  properAccel?: number;
}

export interface InterstellarTransit {
  profile: "cruise" | "torch";
  distanceLy: number;
  cruiseVelocity: number; // cruise (or peak) speed (m/s)
  cruiseFraction: number; // v/c
  coordinateTimeYr: number; // rest-frame transit (years) — what Earth waits
  properTimeYr: number; // ship-frame transit (years) — what the crew ages
  massRatio: number; // m₀/m_f required
  peakLorentz: number; // γ at cruise/midpoint
  oneWayLightLagYr: number; // = distanceLy — the comms floor
}

/**
 * Ballistic cruise: split the propellant between an accelerate-to-cruise burn and
 * a brake-to-rest burn (total mass ratio m₀/m_f = 1/(1−fuelFraction)), so each
 * leg contributes half the rapidity. Coast between them. Boost/brake are treated
 * as impulsive (the coast dominates at fusion-class speeds).
 */
export function ballisticCruise(spec: InterstellarShipSpec, target: StarDef): InterstellarTransit | null {
  const f = spec.fuelFraction;
  if (f === undefined || f <= 0 || f >= 1) return null;
  const massRatio = 1 / (1 - f);
  // Half the total mass ratio accelerates, half brakes ⇒ cruise speed comes from
  // a √(massRatio) burn (half the rapidity budget).
  const cruiseVelocity = relativisticBurnVelocity(spec.exhaustVelocity, Math.sqrt(massRatio), 1);
  const d = target.distanceLy * LIGHT_YEAR;
  const gamma = lorentzFactor(cruiseVelocity);
  const coordTime = d / cruiseVelocity; // boost time neglected (impulsive idealization)
  return {
    profile: "cruise",
    distanceLy: target.distanceLy,
    cruiseVelocity,
    cruiseFraction: cruiseVelocity / C,
    coordinateTimeYr: coordTime / JULIAN_YEAR,
    properTimeYr: coordTime / gamma / JULIAN_YEAR,
    massRatio,
    peakLorentz: gamma,
    oneWayLightLagYr: target.distanceLy,
  };
}

/**
 * Constant-proper-acceleration torch: a coast-free flip-and-burn at proper
 * acceleration a. The brachistochrone closed form gives the exact rest-frame and
 * proper times; the mass ratio follows from the total rapidity expended
 * (2·φ_peak, accelerate + decelerate) via the relativistic rocket equation.
 */
export function torchTransit(spec: InterstellarShipSpec, target: StarDef): InterstellarTransit | null {
  const a = spec.properAccel;
  if (a === undefined || a <= 0) return null;
  const d = target.distanceLy * LIGHT_YEAR;
  const b = brachistochrone(a, d);
  const massRatio = relativisticMassRatio(spec.exhaustVelocity, 2 * rapidity(b.peakVelocity));
  return {
    profile: "torch",
    distanceLy: target.distanceLy,
    cruiseVelocity: b.peakVelocity,
    cruiseFraction: b.peakVelocity / C,
    coordinateTimeYr: b.coordinateTime / JULIAN_YEAR,
    properTimeYr: b.properTime / JULIAN_YEAR,
    massRatio,
    peakLorentz: b.peakLorentz,
    oneWayLightLagYr: target.distanceLy,
  };
}

/** Pick the profile from whichever field the spec provides (torch wins if both). */
export function interstellarTransit(spec: InterstellarShipSpec, target: StarDef): InterstellarTransit | null {
  if (spec.properAccel !== undefined) return torchTransit(spec, target);
  return ballisticCruise(spec, target);
}
