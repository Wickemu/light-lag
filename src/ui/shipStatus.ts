/**
 * Shared ship-status derivations and formatters, used by both the docked flight
 * console ({@link ShipPanel}) and the closed-panel HUD ({@link MissionHud}) so the
 * headline state, the mini-orbit view, and the unit formatting agree everywhere.
 *
 * Everything here is PURE: it reads the read-only world and returns descriptors /
 * strings. No DOM, no mutation.
 */

import { type Ship } from "@lightlag/engine/world";
import {
  shipOsculatingElements,
  shipRelativeState,
  shipEntryReadout,
  primaryMu,
  type TelemetryDoppler,
} from "@lightlag/engine/ships";
import { summarizeOrbit, type OrbitSummary } from "@lightlag/engine/orbit";
import { STAR_BY_ID } from "@lightlag/engine/stars";
import { BODY_BY_ID, AU, DAY, JULIAN_YEAR, IR_BAND_WAVELENGTH, type BodyDef } from "@lightlag/engine/constants";
import { solveKeplerElliptic, solveKeplerHyperbolic, trueAnomalyFromE, trueAnomalyFromF } from "@lightlag/engine/math/kepler";
import { shiftedWavelength } from "@lightlag/engine/comms";
import { length } from "@lightlag/engine/math/vec3";
import { type OrbitView, type InstrumentState } from "./instruments.ts";
import { formatLength, formatLengthPair, formatDur } from "./dom.ts";

export function clamp01(x: number): number { return Math.max(0, Math.min(1, isFinite(x) ? x : 0)); }

/** True anomaly from the osculating elements (elliptic or hyperbolic). */
export function trueAnomalyOf(e: number, M: number): number {
  if (e < 1) return trueAnomalyFromE(solveKeplerElliptic(M, e), e);
  return trueAnomalyFromF(solveKeplerHyperbolic(M, e), e);
}

/** The headline state, chosen in priority order so the most urgent wins. */
export function bannerOf(ship: Ship, t: number, sum: OrbitSummary | null, primary: BodyDef): { text: string; state: InstrumentState } {
  if (ship.status === "lost") {
    const where = BODY_BY_ID.get(ship.landed?.bodyId ?? ship.primary)?.name ?? "a body";
    return { text: `CONTACT LOST · impact with ${where}`, state: "danger" };
  }
  if (ship.mode === "thrust" && ship.burn) {
    const pct = (100 * ship.burn.dvDone) / ship.burn.dvTarget;
    return { text: `BURNING · ${ship.burn.dvDone.toFixed(0)}/${ship.burn.dvTarget.toFixed(0)} m/s (${pct.toFixed(0)}%)`, state: "warn" };
  }
  const entry = shipEntryReadout(ship, t);
  if (entry) return { text: `ENTRY · ${entry.bodyName} → ${entry.outcome} (${(entry.progress * 100).toFixed(0)}%)`, state: "warn" };
  if (ship.landed) return { text: `LANDED · ${BODY_BY_ID.get(ship.landed.bodyId)?.name ?? ship.landed.bodyId}`, state: "info" };
  if (ship.spiral) {
    const alt = (ship.spiral.endRadius - primary.radius) / 1000;
    return { text: `SPIRALING · → ${alt.toFixed(0)} km · ${((ship.spiral.tEnd - t) / DAY).toFixed(0)} d`, state: "active" };
  }
  const tr = ship.transfer;
  if (tr && tr.departed) {
    const name = BODY_BY_ID.get(tr.targetId)?.name ?? tr.targetId;
    if (tr.arrived) return { text: `CAPTURED · ${name}`, state: "ok" };
    if (tr.inSoi) return { text: `ARRIVAL · ${name} — capturing`, state: "active" };
    return { text: `IN TRANSIT · → ${name} · ${((tr.tArrive - t) / DAY).toFixed(0)} d`, state: "active" };
  }
  const leg = ship.interstellarLeg;
  if (leg) {
    const star = STAR_BY_ID.get(leg.targetStar)?.name ?? leg.targetStar;
    return t >= leg.tArrive
      ? { text: `INTERSTELLAR · arrived ${star}`, state: "ok" }
      : { text: `INTERSTELLAR · → ${star} · ${((leg.tArrive - t) / JULIAN_YEAR).toFixed(2)} yr`, state: "active" };
  }
  if (ship.primary === "sun") return { text: "COASTING · heliocentric", state: "info" };
  if (!sum) return { text: `COASTING · ${primary.name}`, state: "info" };
  const bounds = sum.bound
    ? formatLengthPair(sum.periapsisAlt, sum.apoapsisAlt)
    : `${formatLength(sum.periapsisAlt)} · escape`;
  return { text: `COASTING · ${primary.name} ${bounds}`, state: "info" };
}

/** A one-word status for the fleet list / HUD pill. */
export function shortStatusOf(ship: Ship, t: number): { text: string; state: InstrumentState } {
  if (ship.status === "lost") return { text: "LOST", state: "danger" };
  if (ship.mode === "thrust") return { text: "BURN", state: "warn" };
  if (shipEntryReadout(ship, t)) return { text: "ENTRY", state: "warn" };
  if (ship.landed) return { text: "LANDED", state: "info" };
  if (ship.spiral) return { text: "SPIRAL", state: "active" };
  if (ship.transfer && ship.transfer.departed && !ship.transfer.arrived) return { text: "TRANSIT", state: "active" };
  if (ship.interstellarLeg && t < ship.interstellarLeg.tArrive) return { text: "ISL", state: "active" };
  return { text: "COAST", state: "info" };
}

/** The mini-orbit view for a ship: a conic (ship at true anomaly), a transfer /
 *  interstellar progress schematic, a landed marker, or nothing. */
export function orbitViewOf(ship: Ship, t: number): OrbitView {
  if (ship.status === "lost") return { kind: "none" };
  if (ship.landed) return { kind: "landed" };
  const leg = ship.interstellarLeg;
  if (leg) return { kind: "interstellar", frac: clamp01((t - leg.tDepart) / (leg.tArrive - leg.tDepart)) };
  const tr = ship.transfer;
  if (tr && tr.departed && !tr.arrived) return { kind: "transfer", frac: clamp01((t - tr.tDepart) / (tr.tArrive - tr.tDepart)) };
  const el = shipOsculatingElements(ship, t);
  return { kind: "orbit", e: el.e, nu: trueAnomalyOf(el.e, el.M), bound: el.e < 1 && el.a > 0 };
}

/** A short caption for the mini-orbit. */
export function orbitCaptionOf(ship: Ship, t: number): string {
  if (ship.landed) return `landed · ${BODY_BY_ID.get(ship.landed.bodyId)?.name ?? ship.landed.bodyId}`;
  const leg = ship.interstellarLeg;
  if (leg) {
    const f = clamp01((t - leg.tDepart) / (leg.tArrive - leg.tDepart));
    return `→ ${STAR_BY_ID.get(leg.targetStar)?.name ?? leg.targetStar} · ${(f * 100).toFixed(0)}%`;
  }
  const tr = ship.transfer;
  if (tr && tr.departed && !tr.arrived) {
    const f = clamp01((t - tr.tDepart) / (tr.tArrive - tr.tDepart));
    return `→ ${BODY_BY_ID.get(tr.targetId)?.name ?? tr.targetId} · ${(f * 100).toFixed(0)}%`;
  }
  if (ship.primary === "sun") return `heliocentric · ${(length(shipRelativeState(ship, t).r) / AU).toFixed(2)} AU`;
  const primary = BODY_BY_ID.get(ship.primary);
  if (!primary) return "";
  const sum = summarizeOrbit(shipOsculatingElements(ship, t), primaryMu(ship), primary.radius);
  // Caption shows the orbital PERIOD, not periapsis×apoapsis — those bounds already
  // appear in the banner and the NAV tab, so repeating them here was redundant.
  if (sum.bound) return `${primary.name} · ${formatDur(sum.period)}`;
  return `${primary.name} · escape`;
}

// ── formatters ────────────────────────────────────────────────────────────────

/** Light-delay readout: live for the local case, then seconds → minutes → hours. */
export function fmtDelay(s: number): string {
  if (s < 1) return "live";
  if (s < 90) return `${s.toFixed(0)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(2)} hr`;
}

/** The telemetry Doppler shift: redshift z and where the 10 µm band lands. */
export function fmtDoppler(d: TelemetryDoppler): string {
  const word = d.z > 0 ? "redshift" : d.z < 0 ? "blueshift" : "none";
  const zStr = Math.abs(d.z) >= 1e-3 ? d.z.toFixed(3) : d.z.toExponential(1);
  const sign = d.z >= 0 ? "+" : "";
  const lamObs = (shiftedWavelength(IR_BAND_WAVELENGTH, d.factor) * 1e6).toFixed(2);
  return `z ${sign}${zStr} (${word}) · 10 → ${lamObs} µm`;
}

export function fmtPower(w: number): string {
  if (w < 1e3) return `${w.toFixed(0)} W`;
  if (w < 1e6) return `${(w / 1e3).toFixed(1)} kW`;
  if (w < 1e9) return `${(w / 1e6).toFixed(1)} MW`;
  return `${(w / 1e9).toFixed(2)} GW`;
}

/** Distance readout — delegates to the shared adaptive length ladder so every
 *  panel's distances scale the same way (km · Mm · Gm · AU). */
export function fmtRange(m: number): string {
  return formatLength(m);
}
