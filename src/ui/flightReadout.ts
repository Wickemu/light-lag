/**
 * Builders for the flight console's telemetry, split out of {@link ShipPanel} so
 * the per-frame readout has a clear information hierarchy:
 *
 *   • {@link statusBanner} — the single headline state (BURNING / IN TRANSIT / …).
 *   • {@link statusChips}  — cross-cutting flags (order en route, drive hot).
 *   • {@link primaryLines} — the handful of numbers a controller always watches.
 *   • detail groups        — advanced data tucked behind disclosure (orbit/J2 &
 *                            Doppler, electric drive, transfer & flybys, thermal).
 *
 * Every function here is PURE presentation: it reads the (read-only) sim state and
 * returns HTML strings / descriptors. All DOM mutation, button gating and section
 * visibility stays in the panel. {@link flightCtx} computes the light-lag retarded
 * state once per frame so the builders share it.
 */

import { type Simulation } from "../core/sim.ts";
import { type Ship } from "../core/world.ts";
import {
  totalMass,
  dvRemaining,
  activeStage,
  shipOsculatingElements,
  shipRelativeState,
  shipWorldState,
  shipThermalState,
  shipEntryReadout,
  shipTelemetryDoppler,
  type TelemetryDoppler,
  primaryMu,
} from "../core/ships.ts";
import { availablePowerW, thrustAt } from "../core/propulsion.ts";
import { summarizeOrbit, j2Rates } from "../core/orbit.ts";
import { bodyPosition } from "../core/ephemeris.ts";
import { retardedTime, shiftedWavelength } from "../core/comms.ts";
import { STAR_BY_ID } from "../core/stars.ts";
import { type BodyDef, BODY_BY_ID, AU, DAY, RAD, JULIAN_YEAR, IR_BAND_WAVELENGTH, j2RefRadius } from "../core/constants.ts";
import { formatDate } from "../core/time.ts";
import { length } from "../core/math/vec3.ts";
import { kv, formatDur } from "./dom.ts";

/** A disclosure group's rendered body plus whether it has anything to show this frame. */
export interface ReadoutGroup {
  html: string;
  show: boolean;
}

/** A status banner / chip: its text and a state class (`""` for the neutral look). */
export interface StatusChip {
  text: string;
  cls: string;
}

/** Light-lag retarded state for the selected ship, computed once per frame. */
export interface FlightCtx {
  ship: Ship;
  /** Current sim time. */
  t: number;
  /** The retarded time — the instant whose light is only now reaching control. */
  tKnown: number;
  /** One-way light delay (s). */
  ageS: number;
  mu: number;
  /** The body the ship orbits (undefined heliocentrically / for an unknown id). */
  primary: BodyDef | undefined;
  elements: ReturnType<typeof shipOsculatingElements>;
  rel: ReturnType<typeof shipRelativeState>;
  speed: number;
  /** Orbit summary about the primary, or null when heliocentric. */
  summary: ReturnType<typeof summarizeOrbit> | null;
  thermal: ReturnType<typeof shipThermalState>;
  doppler: TelemetryDoppler | null;
}

/** Assemble the shared per-frame context (retarded orbit state + thermal/Doppler). */
export function flightCtx(ship: Ship, sim: Simulation, t: number): FlightCtx {
  // What you KNOW is the ship's retarded state — its state at the instant whose
  // light is only now reaching the control node.
  const controlPos = bodyPosition(sim.world.controlNode, t);
  const tKnown = retardedTime(controlPos, (tt) => shipWorldState(ship, tt).r, t);
  const mu = primaryMu(ship);
  const primary = BODY_BY_ID.get(ship.primary);
  const elements = shipOsculatingElements(ship, tKnown);
  const rel = shipRelativeState(ship, tKnown);
  const summary = ship.primary !== "sun" && primary ? summarizeOrbit(elements, mu, primary.radius) : null;
  return {
    ship,
    t,
    tKnown,
    ageS: t - tKnown,
    mu,
    primary,
    elements,
    rel,
    speed: length(rel.v),
    summary,
    thermal: shipThermalState(ship, t),
    doppler: shipTelemetryDoppler(ship, sim.world.controlNode, t),
  };
}

// ── Status banner & chips ────────────────────────────────────────────────────

/** The one headline state, chosen in priority order so the most urgent wins. */
export function statusBanner(ctx: FlightCtx): StatusChip {
  const { ship, t } = ctx;
  if (ship.status === "lost") {
    const where = BODY_BY_ID.get(ship.landed?.bodyId ?? ship.primary)?.name ?? "a body";
    return { text: `CONTACT LOST · impact with ${where}`, cls: "lost" };
  }
  if (ship.mode === "thrust" && ship.burn) {
    const pct = (100 * ship.burn.dvDone) / ship.burn.dvTarget;
    return { text: `BURNING · ${ship.burn.dvDone.toFixed(0)} / ${ship.burn.dvTarget.toFixed(0)} m/s (${pct.toFixed(0)}%)`, cls: "burning" };
  }
  const entry = shipEntryReadout(ship, t);
  if (entry) {
    return { text: `ENTRY · ${entry.bodyName} → ${entry.outcome} (${(entry.progress * 100).toFixed(0)}%)`, cls: "entry" };
  }
  if (ship.landed) {
    return { text: `LANDED · ${BODY_BY_ID.get(ship.landed.bodyId)?.name ?? ship.landed.bodyId}`, cls: "landed" };
  }
  if (ship.spiral) {
    const alt = (ship.spiral.endRadius - (BODY_BY_ID.get(ship.primary)?.radius ?? 0)) / 1000;
    const left = (ship.spiral.tEnd - t) / DAY;
    return { text: `SPIRALING · → ${alt.toFixed(0)} km · ${left.toFixed(0)} d left`, cls: "active" };
  }
  const tr = ship.transfer;
  if (tr && tr.departed) {
    const name = BODY_BY_ID.get(tr.targetId)?.name ?? tr.targetId;
    if (tr.arrived) return { text: `CAPTURED · ${name}`, cls: "active" };
    if (tr.inSoi) return { text: `ARRIVAL · ${name} — capturing`, cls: "active" };
    return { text: `IN TRANSIT · → ${name} · arrive ${((tr.tArrive - t) / DAY).toFixed(0)} d`, cls: "active" };
  }
  const leg = ship.interstellarLeg;
  if (leg) {
    const starName = STAR_BY_ID.get(leg.targetStar)?.name ?? leg.targetStar;
    return t >= leg.tArrive
      ? { text: `INTERSTELLAR · arrived ${starName}`, cls: "active" }
      : { text: `INTERSTELLAR · → ${starName} · ${((leg.tArrive - t) / JULIAN_YEAR).toFixed(2)} yr left`, cls: "active" };
  }
  // Coasting — a short orbit summary so the headline still carries where it is.
  if (ship.primary === "sun") return { text: "COASTING · heliocentric", cls: "coast" };
  const where = BODY_BY_ID.get(ship.primary)?.name ?? ship.primary;
  if (!ctx.summary) return { text: `COASTING · ${where}`, cls: "coast" };
  const peri = (ctx.summary.periapsisAlt / 1000).toFixed(0);
  const apo = ctx.summary.bound ? (ctx.summary.apoapsisAlt / 1000).toFixed(0) : "escape";
  return { text: `COASTING · ${where} ${peri}×${apo} km`, cls: "coast" };
}

/** Cross-cutting flags that aren't the headline state. */
export function statusChips(ctx: FlightCtx, sim: Simulation): StatusChip[] {
  const { ship, t } = ctx;
  const chips: StatusChip[] = [];
  const inbound = sim.world.messages.find(
    (m) => m.kind === "command" && m.targetId === ship.id && m.tArrive > t,
  );
  if (inbound) chips.push({ text: `ORDER EN ROUTE · ${fmtDelay(inbound.tArrive - t)}`, cls: "" });
  if (ctx.thermal.thrusting) chips.push({ text: "DRIVE HOT", cls: "warn" });
  return chips;
}

// ── Primary readout (always visible) ─────────────────────────────────────────

/** The handful of numbers a controller always watches. */
export function primaryLines(ctx: FlightCtx): string {
  const { ship, ageS, rel, speed, primary, summary } = ctx;
  const lines: string[] = [];
  lines.push(kv("Signal delay (1-way)", fmtDelay(ageS)));
  if (ship.primary === "sun") {
    lines.push(kv("Frame", "heliocentric"));
    lines.push(kv("Distance from Sun", `${(length(rel.r) / AU).toFixed(3)} AU`));
  } else if (primary && summary) {
    lines.push(kv("Orbiting", primary.name));
    lines.push(kv("Periapsis alt", `${(summary.periapsisAlt / 1000).toFixed(0)} km`));
    lines.push(kv("Apoapsis alt", summary.bound ? `${(summary.apoapsisAlt / 1000).toFixed(0)} km` : "escape"));
    lines.push(kv("Period", summary.bound ? formatDur(summary.period) : "—"));
  }
  lines.push(kv("Speed", `${(speed / 1000).toFixed(3)} km/s`));
  lines.push(kv("Mass", `${(totalMass(ship) / 1000).toFixed(2)} t`));
  lines.push(kv("Δv remaining", `${(dvRemaining(ship) / 1000).toFixed(2)} km/s`));
  return lines.join("");
}

/** A prominent one-liner for a PLANNED (not-yet-departed) transfer — the departed
 *  states already read off the status banner, so this surfaces only the upcoming
 *  departure (the per-flyby detail lives in {@link transferDetailGroup}). */
export function transferSummaryLine(ctx: FlightCtx): string {
  const tr = ctx.ship.transfer;
  if (!tr || tr.departed) return "";
  const name = BODY_BY_ID.get(tr.targetId)?.name ?? tr.targetId;
  return kv("Transfer planned", `→ ${name} · depart ${formatDate(tr.tDepart)}`);
}

// ── Advanced detail groups (behind disclosure) ───────────────────────────────

/** Orbit detail: J2 precession of the plane/apsides, plus the telemetry Doppler. */
export function orbitDetailGroup(ctx: FlightCtx): ReadoutGroup {
  const { ship, mu, elements, primary, summary, doppler } = ctx;
  const lines: string[] = [];
  if (doppler) lines.push(kv("Telemetry Doppler", fmtDoppler(doppler)));
  if (ship.primary !== "sun" && primary && summary?.bound && primary.J2) {
    const r = j2Rates(mu, j2RefRadius(primary), primary.J2, elements.a, elements.e, elements.i);
    lines.push(kv("Node precession", `${(r.nodeDot * RAD * DAY).toFixed(3)}°/day`));
    lines.push(kv("Apsidal precession", `${(r.periDot * RAD * DAY).toFixed(3)}°/day`));
  }
  return { html: lines.join(""), show: lines.length > 0 };
}

/** Electric-drive detail: power-limited thrust (falls as 1/r²) and the spiral leg. */
export function driveDetailGroup(ctx: FlightCtx): ReadoutGroup {
  const { ship, tKnown, t } = ctx;
  const stage = activeStage(ship);
  const lines: string[] = [];
  if (stage?.electric) {
    const rHelio = length(shipWorldState(ship, tKnown).r);
    const power = availablePowerW(stage.electric, rHelio);
    const thr = thrustAt(stage, rHelio);
    const accel = thr / totalMass(ship);
    lines.push(kv("Drive power", `${(power / 1000).toFixed(2)} kW${stage.electric.solar ? ` @ ${(rHelio / AU).toFixed(2)} AU` : " (reactor)"}`));
    lines.push(kv("Drive thrust", `${(thr * 1000).toFixed(1)} mN · a = ${(accel * 1e6).toFixed(2)} mm/s²`));
  }
  if (ship.spiral) {
    const alt = (ship.spiral.endRadius - (BODY_BY_ID.get(ship.primary)?.radius ?? 0)) / 1000;
    const left = (ship.spiral.tEnd - t) / DAY;
    lines.push(kv("Spiraling", `to ${alt.toFixed(0)} km · ${left.toFixed(0)} d left`));
  }
  return { html: lines.join(""), show: lines.length > 0 };
}

/** Transfer detail: capture cost, per-flyby B-plane geometry, and the interstellar
 *  leg's relativistic clocks. */
export function transferDetailGroup(ctx: FlightCtx): ReadoutGroup {
  const { ship, t } = ctx;
  const tr = ship.transfer;
  const leg = ship.interstellarLeg;
  const lines: string[] = [];
  if (tr) {
    const tName = BODY_BY_ID.get(tr.targetId)?.name ?? tr.targetId;
    if (!tr.departed) {
      lines.push(kv("Transfer", `→ ${tName}, depart ${formatDate(tr.tDepart)}`));
    } else if (tr.arrived) {
      lines.push(kv("Captured", `${tName} orbit · capture Δv ${(tr.dvArrive / 1000).toFixed(2)} km/s`));
    } else if (tr.inSoi) {
      lines.push(kv("Arrival", `in ${tName} SOI — capturing`));
    } else {
      lines.push(kv("In transit", `→ ${tName}, arrive in ${((tr.tArrive - t) / DAY).toFixed(0)} d`));
      lines.push(kv("Capture Δv", `${(tr.dvArrive / 1000).toFixed(2)} km/s`));
    }
    // Per-flyby B-plane geometry: a flown pass carries the targeting it achieved —
    // periapsis altitude, impact parameter b (in body radii), the bend, and whether
    // the bend was free or bought with a periapsis burn. Pending passes show their time.
    if (tr.flybys) {
      for (const f of tr.flybys) {
        const fb = BODY_BY_ID.get(f.bodyId);
        const fName = fb?.name ?? f.bodyId;
        if (f.done && f.rpAchieved !== undefined) {
          const periAlt = (f.rpAchieved - (fb?.radius ?? 0)) / 1000;
          const bRadii = fb ? f.bMag! / fb.radius : 0;
          const free = (f.residualTurn ?? 0) < 1e-6 && f.dvBurn < 1;
          lines.push(kv(`Flyby ${fName}`,
            `peri ${periAlt.toFixed(0)} km · b ${bRadii.toFixed(1)} R · turn ${((f.turn ?? 0) * RAD).toFixed(0)}°` +
            (free ? " · free" : ` · burn ${f.dvBurn.toFixed(0)} m/s`)));
        } else {
          lines.push(kv(`Flyby ${fName}`, `pending · ${formatDate(f.tFlyby)}`));
        }
      }
    }
  }
  if (leg) {
    const starName = STAR_BY_ID.get(leg.targetStar)?.name ?? leg.targetStar;
    lines.push(kv("Interstellar", t >= leg.tArrive
      ? `arrived at ${starName}`
      : `→ ${starName} · ${((leg.tArrive - t) / JULIAN_YEAR).toFixed(2)} yr left (Earth frame)`));
    lines.push(kv("Crew clock (τ)", `${(ship.tau / JULIAN_YEAR).toFixed(2)} yr elapsed`));
  }
  return { html: lines.join(""), show: lines.length > 0 };
}

/** Thermal & detection — there is no stealth in space. */
export function thermalDetailGroup(ctx: FlightCtx): ReadoutGroup {
  const th = ctx.thermal;
  const lines = [
    kv("Solar flux", `${th.solarFlux.toFixed(0)} W/m² @ ${(th.distanceFromSun / AU).toFixed(2)} AU`),
    kv("Hull temp", `${th.hullTempK.toFixed(0)} K`),
    kv("IR signature", fmtPower(th.signatureW) + (th.thrusting ? " — drive HOT" : "")),
    kv("Detectable to", `${fmtRange(th.detectionRangeM)} (${th.snrThreshold}σ, τ=${(th.integrationTimeS / 3600).toFixed(0)}h)`),
    kv("Min signal", `${(th.minDetectablePowerW * 1e18).toFixed(1)} aW`),
  ];
  if (th.thrusting) {
    lines.push(kv("Drive waste heat", fmtPower(th.driveWasteW)));
    lines.push(kv("Radiator needed", `${Math.round(th.radiatorAreaM2).toLocaleString("en-US")} m²`));
  }
  return { html: lines.join(""), show: true };
}

// ── ship-specific formatters ─────────────────────────────────────────────────

/** Light-delay readout: live for the local case, then seconds → minutes → hours. */
export function fmtDelay(s: number): string {
  if (s < 1) return "live";
  if (s < 90) return `${s.toFixed(0)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(2)} hr`;
}

/** The telemetry Doppler shift: redshift z (scientific for the tiny in-system
 *  values, decimal for a relativistic torchship) and where the 10 µm sensing band
 *  lands when the signal arrives. z > 0 reddens (receding), z < 0 blues. */
export function fmtDoppler(d: TelemetryDoppler): string {
  const word = d.z > 0 ? "redshift" : d.z < 0 ? "blueshift" : "none";
  const zStr = Math.abs(d.z) >= 1e-3 ? d.z.toFixed(3) : d.z.toExponential(1);
  const sign = d.z >= 0 ? "+" : "";
  const lamObs = (shiftedWavelength(IR_BAND_WAVELENGTH, d.factor) * 1e6).toFixed(2); // µm
  return `z ${sign}${zStr} (${word}) · 10 → ${lamObs} µm`;
}

export function fmtPower(w: number): string {
  if (w < 1e3) return `${w.toFixed(0)} W`;
  if (w < 1e6) return `${(w / 1e3).toFixed(1)} kW`;
  if (w < 1e9) return `${(w / 1e6).toFixed(1)} MW`;
  return `${(w / 1e9).toFixed(2)} GW`;
}

export function fmtRange(m: number): string {
  if (m < 1e9) return `${(m / 1e3).toLocaleString("en-US", { maximumFractionDigits: 0 })} km`;
  return `${(m / 1.495978707e11).toFixed(3)} AU`;
}
