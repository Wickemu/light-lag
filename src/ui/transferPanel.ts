/**
 * The mission planner: choose a destination, a route (direct, an auto-suggested
 * gravity-assist, or hand-picked flybys), and what to optimize for — then read the
 * real launch window off the porkchop and commit.
 *
 * The canvas sweeps departure date (x) against time-of-flight (y); each pixel is a
 * Lambert solution coloured by total Δv. The blue low-Δv island IS the launch window —
 * it falls out of where the planets are. The crosshair marks the cell that wins under
 * the chosen criterion (least Δv / shortest time / balanced); the white ring marks the
 * absolute Δv floor. Commit schedules the departure; it fires when the clock reaches it.
 */

import { type Simulation } from "@lightlag/engine/sim";
import { type Ship, type LagrangePoint } from "@lightlag/engine/world";
import { type SceneManager } from "../render/SceneManager.ts";
import { type TrajectoryViews } from "../render/trajectoryViews.ts";
import { computePorkchop, type Porkchop, type PorkCell } from "@lightlag/engine/maneuver/porkchop";
import { type AssistResult, type ChainAssistResult } from "@lightlag/engine/maneuver/assist";
import { type Criterion } from "@lightlag/engine/maneuver/criteria";
import {
  suggestRoutes, transferWindow, bestAssist, bestChain, bestPorkCell, type SuggestedRoute,
} from "@lightlag/engine/maneuver/suggest";
import { planTransfer, planAssist, planChainAssist, planMoonTransfer, planMoonMission, planMoonTour, searchMoonTour, aerocapturePreview, captureDvPreview, assistCapturePreview, looseCaptureApoAlt, planGeoRaise, geoRaisePreview, planSynchronousTransfer, computeSynchronousPorkchop, synchronousOrbitFeasible, planLagrange, computeLagrangePorkchop, type MoonTourResult } from "../app/commands.ts";
import { computeMoonPorkchop } from "@lightlag/engine/maneuver/moon";
import { hohmann } from "@lightlag/engine/maneuver/hohmann";
import { lagrangeEligible, lagrangeCentral } from "@lightlag/engine/maneuver/lagrange";
import { dvRemaining, shipWorldState, shipOsculatingElements, shipRelativeState } from "@lightlag/engine/ships";
import { bodyStateRelative } from "@lightlag/engine/ephemeris";
import { length } from "@lightlag/engine/math/vec3";
import { periapsisRadius } from "@lightlag/engine/orbit";
import { impactParameter } from "@lightlag/engine/maneuver/flyby";
import { formatDate } from "@lightlag/engine/time";
import { type BodyDef, type BodyKind, BODIES, BODY_BY_ID, DAY, DEFAULT_CAPTURE_ALT } from "@lightlag/engine/constants";
import { div, btn, kvAuto, setDisabled, formatLength, formatLengthPair } from "./dom.ts";
import { markTerm } from "./tooltip.ts";

/** A `.section-label` div tagged as a hover term. */
function sectionLabel(text: string): HTMLElement {
  const e = div("section-label", text);
  markTerm(e, text);
  return e;
}

const CANVAS_W = 300;
const CANVAS_H = 210;

/** Body groups for the destination/flyby dropdowns — the HUD's ordering, minus the Sun. */
const GROUPS: { kind: BodyKind; label: string }[] = [
  { kind: "planet", label: "Planets" },
  { kind: "dwarf", label: "Dwarf planets" },
  { kind: "asteroid", label: "Asteroids" },
  { kind: "comet", label: "Comets" },
  { kind: "moon", label: "Moons" },
];

type RouteMode = "direct" | "suggest" | "via1" | "via2";
/** Same-parent moon arrival: a single Direct hop, or a Flyby tour past sibling moons (pump-down). */
type MoonMode = "direct" | "tour";
/**
 * What orbit / point the mission ends at — the second-level "DESTINATION ORBIT" selector, picked
 * after the primary body. Body-capture slots (low circular · Oberth-cheap loose ellipse ·
 * aerocapture) plus the new synchronous (GEO) orbit and the five Lagrange points of the body's
 * system. Filtered per body by `orbitSlots()`.
 */
type OrbitSlot = "leo" | "ellipse" | "aerocapture" | "geo" | LagrangePoint;

/** A body is a useful gravity-assist flyby only if it has real mass: a planet (or Ceres). */
function isAssistBody(b: BodyDef): boolean {
  return b.parent === "sun" && (b.kind === "planet" || b.id === "ceres");
}

/** Eligibility of an option: whether to show it, whether it's selectable, and an optional note. */
interface Eligible {
  show: boolean;
  enabled: boolean;
  note?: string;
}

export class TransferPanel {
  private panel!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private readout!: HTMLElement;
  private suggestEl!: HTMLElement;
  private commitBtn!: HTMLButtonElement;
  private optBtn!: HTMLButtonElement;
  private targetSel!: HTMLSelectElement;
  private axisEl!: HTMLElement;
  private originEl!: HTMLElement;
  private viaSel!: HTMLSelectElement;
  private via2Sel!: HTMLSelectElement;
  private viaRow!: HTMLElement;
  private via2Row!: HTMLElement;
  private captureSel!: HTMLSelectElement;
  private capRow!: HTMLElement;
  private critSel!: HTMLSelectElement;
  private critRow!: HTMLElement;
  private modeRow!: HTMLElement;
  private modeBtns: Partial<Record<RouteMode, HTMLButtonElement>> = {};
  // Moon-target sub-mode: a single Direct hop, or a gravity-assist Flyby tour past sibling moons.
  private moonModeRow!: HTMLElement;
  private moonModeBtns: Partial<Record<MoonMode, HTMLButtonElement>> = {};
  private moonTourEl!: HTMLElement;
  private moonMode: MoonMode = "direct";
  private moonTours: { flybyMoonIds: string[]; result: MoonTourResult }[] = [];
  private selectedTour: { flybyMoonIds: string[]; result: MoonTourResult } | null = null;

  private orbitSlot: OrbitSlot = "leo";
  private routeMode: RouteMode = "direct";
  private criterion: Criterion = "dv";
  private shipId: string | null = null;
  private targetId = "mars";
  private viaId = ""; // first flyby body id (via1/via2 modes)
  private via2Id = ""; // second flyby body id (via2 mode)
  private assist: AssistResult | null = null;
  private chain: { result: ChainAssistResult; times: number[]; bodyIds: string[] } | null = null;
  private suggestions: SuggestedRoute[] = [];
  private pork: Porkchop | null = null;
  private selI = -1;
  private selJ = -1;

  constructor(
    private root: HTMLElement,
    private sim: Simulation,
    private sm: SceneManager,
    private traj: TrajectoryViews,
  ) {
    this.build();
  }

  // ── Origin / eligibility ─────────────────────────────────────────────────────

  /** The body the ship departs from: its current primary (or Earth, heliocentrically). */
  private originId(): string {
    const ship = this.shipId ? this.sim.world.ships.get(this.shipId) : undefined;
    return ship && ship.primary !== "sun" ? ship.primary : "earth";
  }

  /** Can the ship reach this moon? Same-parent moons fly directly about the parent; a moon of
   *  a different (heliocentric) planet flies as a two-stage mission that auto-chains on arrival. */
  private moonEligible(moon: BodyDef): Eligible {
    if (moon.parent === this.originId()) return { show: true, enabled: true };
    const parent = BODY_BY_ID.get(moon.parent ?? "");
    if (parent && parent.parent === "sun") return { show: true, enabled: true, note: `(via ${parent.name})` };
    return { show: true, enabled: false, note: "(unreachable)" };
  }

  /** A same-parent moon hop: a single parent-centric Lambert (ship at Earth → Moon, …). */
  private isMoonTarget(): boolean {
    const b = BODY_BY_ID.get(this.targetId);
    return !!b && b.kind === "moon" && b.parent === this.originId();
  }

  /** The OTHER moons of the ship's current parent (potential gravity-assist bodies for a tour to
   *  `targetId`), outer-first so the natural pump-down order is offered first. */
  private siblingMoons(): BodyDef[] {
    const parent = this.originId();
    const t0 = this.sim.world.t;
    return BODIES
      .filter((b) => b.kind === "moon" && b.parent === parent && b.id !== this.targetId)
      .map((b) => ({ b, r: length(bodyStateRelative(b, t0).r) }))
      .sort((a, z) => z.r - a.r)
      .map((x) => x.b);
  }

  /** A flyby tour is offered only when the target is a same-parent moon and the parent has ≥2
   *  other moons to slingshot past. */
  private canMoonTour(): boolean {
    return this.isMoonTarget() && this.siblingMoons().length >= 2;
  }

  /** A cross-system two-stage mission: the moon's parent is a heliocentric planet we're not at
   *  (Earth → Jupiter → Europa). Stage 1 is a heliocentric leg to the parent; the sim chains the
   *  parent-centric moon leg on capture. */
  private isMoonMission(): boolean {
    const b = BODY_BY_ID.get(this.targetId);
    if (!b || b.kind !== "moon" || b.parent === this.originId()) return false;
    const parent = BODY_BY_ID.get(b.parent ?? "");
    return !!parent && parent.parent === "sun";
  }

  /** The body the heliocentric leg actually targets — the parent planet for a cross-system moon
   *  mission, otherwise the chosen target. */
  private effectiveTarget(): string {
    return this.isMoonMission() ? BODY_BY_ID.get(this.targetId)!.parent! : this.targetId;
  }

  /** Apoapsis altitude for an elliptical capture at the effective target (a loose half-SOI
   *  ellipse), or undefined for the default low circular capture. */
  private captureApoAlt(): number | undefined {
    return this.orbitSlot === "ellipse"
      ? looseCaptureApoAlt(this.effectiveTarget(), this.sim.world.t) : undefined;
  }

  /** The command-layer capture mode the current selection maps to (the planner's "ellipse"
   *  is a propulsive capture with an apoapsis; aerocapture only where there's an atmosphere). */
  private commandCaptureMode(): "propulsive" | "aerocapture" {
    return this.orbitSlot === "aerocapture" && BODY_BY_ID.get(this.effectiveTarget())?.atmosphere
      ? "aerocapture" : "propulsive";
  }

  /** A Lagrange-point destination slot (L1–L5)? */
  private isLagrangeSlot(): boolean {
    return this.orbitSlot.length === 2 && this.orbitSlot[0] === "L";
  }

  /** The selected Lagrange point, or null if the slot isn't a Lagrange point. */
  private lagrangePoint(): LagrangePoint | null {
    return this.isLagrangeSlot() ? (this.orbitSlot as LagrangePoint) : null;
  }

  /** A same-primary GEO raise: the GEO slot at the body the ship is already orbiting. */
  private isGeoRaise(): boolean {
    return this.orbitSlot === "geo" && this.targetId === this.originId();
  }

  /** The new destination-orbit slots (synchronous / Lagrange) drive a direct arrival of their own,
   *  bypassing the route-mode / flyby / moon-tour machinery. */
  private isNewSlot(): boolean {
    return this.orbitSlot === "geo" || this.isLagrangeSlot();
  }

  /** The "Sun–Earth" / "Earth–Moon" system label for a body's Lagrange points. */
  private systemLabel(body: BodyDef): string {
    const parent = body.parent ? BODY_BY_ID.get(body.parent) : undefined;
    return parent ? `${parent.name}–${body.name}` : body.name;
  }

  /** The DESTINATION ORBIT options for the currently-selected body: low-circular / ellipse /
   *  aerocapture for a remote capture, plus synchronous (GEO) where feasible and the five
   *  Lagrange points of the body's system. The body you're already at offers only the non-trivial
   *  slots (a low circular orbit at your own body is a no-op). */
  private orbitSlots(): { slot: OrbitSlot; label: string; enabled: boolean; note?: string }[] {
    const target = BODY_BY_ID.get(this.targetId);
    if (!target) return [];
    const t = this.sim.world.t;
    const atOrigin = this.targetId === this.originId();
    const out: { slot: OrbitSlot; label: string; enabled: boolean; note?: string }[] = [];
    if (!atOrigin) {
      out.push({ slot: "leo", label: "Low circular (LEO)", enabled: true });
      out.push({ slot: "ellipse", label: "Loose ellipse (cheap)", enabled: true });
      // Aerocapture brakes against the body the arrival actually captures at (the parent planet for
      // a cross-system moon mission), so gate it on THAT body's atmosphere.
      if (BODY_BY_ID.get(this.effectiveTarget())?.atmosphere) {
        out.push({ slot: "aerocapture", label: "Aerocapture (drag pass)", enabled: true });
      }
    }
    // Synchronous orbit: at your own primary (a GEO raise) or a heliocentric body you transfer to
    // (areostationary, etc.). Tidally-locked moons whose a_sync exceeds the SOI are excluded.
    const geoReachable = atOrigin || target.parent === "sun";
    if (geoReachable && synchronousOrbitFeasible(target, t)) {
      out.push({ slot: "geo", label: atOrigin ? "Geostationary (GEO)" : `Synchronous (${target.name}-stationary)`, enabled: true });
    } else if (geoReachable && target.rotationPeriod) {
      out.push({ slot: "geo", label: "Synchronous", enabled: false, note: "exceeds SOI" });
    }
    // Lagrange points of the body's system. A planet's Sun–planet points are reached heliocentrically
    // from anywhere; a moon's planet–moon points need the ship already at that planet.
    if (lagrangeEligible(target)) {
      const central = lagrangeCentral(target);
      if (central === undefined || this.originId() === central) {
        const sys = this.systemLabel(target);
        for (const p of ["L1", "L2", "L3", "L4", "L5"] as LagrangePoint[]) {
          out.push({ slot: p, label: `${sys} ${p}`, enabled: true });
        }
      }
    }
    return out;
  }

  /**
   * The budget verdict for a committed leg, honest about the WHOLE mission cost.
   * `preCapture` is everything paid before arrival (injection, plus any flyby Δv);
   * `capture` is the arrival burn. With no in-flight refuelling, a capture the ship
   * can't afford strands it on a hyperbola at the target — so the planner must not
   * green-light it. Returns the readout line and whether Commit should be allowed.
   */
  private budgetVerdict(
    preCapture: number, capture: number, haveDv: number, aeroNote = false,
  ): { html: string; ok: boolean } {
    if (preCapture > haveDv) {
      return { ok: false, html: `<div class="warn">✗ injection exceeds Δv budget</div>` };
    }
    if (preCapture + capture > haveDv) {
      return {
        ok: false,
        html: `<div class="warn">✗ capture Δv exceeds remaining budget — the ship would arrive but can't capture. Try a loose-ellipse or aerocapture arrival.</div>`,
      };
    }
    return {
      ok: true,
      html: aeroNote
        ? `<div class="ok">✓ within budget — the atmosphere does the braking</div>`
        : `<div class="ok">✓ injection + capture within budget</div>`,
    };
  }

  /** The capture line for a gravity-assist/chain arrival at `vInfArrive` under the current
   *  capture selection: the Δv paid, a human label, and feasibility (aerocapture can fail). */
  private assistCaptureLine(vInfArrive: number): { dvArrive: number; label: string; feasible: boolean } {
    const mode = this.commandCaptureMode();
    const apoAlt = this.captureApoAlt();
    const cap = assistCapturePreview(this.targetId, vInfArrive, mode, apoAlt);
    if (!cap) return { dvArrive: 0, label: "aerocapture not possible here", feasible: false };
    const label = cap.aero ? " (aerocapture)" : apoAlt !== undefined ? " (loose ellipse)" : " (circular)";
    return { dvArrive: cap.dvArrive, label, feasible: true };
  }

  private destEligible = (b: BodyDef): Eligible => {
    if (b.id === "sun") return { show: false, enabled: false };
    // The body you're already at is selectable — not for a (no-op) transfer to its low orbit, but
    // for its own GEO and Lagrange points (the comsat / space-telescope case).
    if (b.id === this.originId()) return { show: true, enabled: true, note: "(local orbits)" };
    if (b.kind === "moon") return this.moonEligible(b);
    return { show: true, enabled: true };
  };

  private flybyEligible = (exclude: string): ((b: BodyDef) => Eligible) => (b: BodyDef) => {
    if (!isAssistBody(b)) return { show: false, enabled: false };
    const origin = this.originId();
    if (b.id === origin || b.id === this.targetId || b.id === exclude) return { show: false, enabled: false };
    return { show: true, enabled: true };
  };

  /** (Re)populate a grouped select from the body catalog under an eligibility predicate. */
  private fillSelect(sel: HTMLSelectElement, none: string | null, choose: (b: BodyDef) => Eligible, selected: string): void {
    sel.innerHTML = "";
    if (none !== null) {
      const o = document.createElement("option");
      o.value = ""; o.textContent = none;
      sel.appendChild(o);
    }
    for (const g of GROUPS) {
      const members = BODIES.filter((b) => b.kind === g.kind).map((b) => ({ b, e: choose(b) })).filter((x) => x.e.show);
      if (members.length === 0) continue;
      const og = document.createElement("optgroup");
      og.label = g.label;
      for (const { b, e } of members) {
        const o = document.createElement("option");
        o.value = b.id;
        o.textContent = e.note ? `${b.name} ${e.note}` : b.name;
        o.disabled = !e.enabled;
        og.appendChild(o);
      }
      sel.appendChild(og);
    }
    sel.value = selected;
  }

  private refreshSelects(): void {
    this.fillSelect(this.targetSel, null, this.destEligible, this.targetId);
    // Snap the target to a valid enabled option if the origin made the old one invalid.
    if (this.targetSel.value !== this.targetId) {
      this.targetId = this.targetSel.value || this.firstEnabledDestination();
      this.targetSel.value = this.targetId;
    }
    this.refreshOrbitSlots();
    this.fillSelect(this.viaSel, "— pick a flyby —", this.flybyEligible(this.via2Id), this.viaId);
    this.fillSelect(this.via2Sel, "— pick a flyby —", this.flybyEligible(this.viaId), this.via2Id);
    this.originEl.textContent = `From: ${this.originId() === "earth" && (!this.shipId || this.sim.world.ships.get(this.shipId!)?.primary === "sun")
      ? "Earth (heliocentric)" : BODY_BY_ID.get(this.originId())?.name ?? "—"}`;
  }

  private firstEnabledDestination(): string {
    for (const g of GROUPS) for (const b of BODIES) if (b.kind === g.kind && this.destEligible(b).enabled) return b.id;
    return "mars";
  }

  /** (Re)populate the DESTINATION ORBIT selector for the current target, snapping a stale slot to
   *  the first enabled option (e.g. when switching to a body with no synchronous orbit). */
  private refreshOrbitSlots(): void {
    const slots = this.orbitSlots();
    this.captureSel.innerHTML = "";
    for (const s of slots) {
      const o = document.createElement("option");
      o.value = s.slot;
      o.textContent = s.note ? `${s.label} — ${s.note}` : s.label;
      o.disabled = !s.enabled;
      this.captureSel.appendChild(o);
    }
    if (!slots.some((s) => s.slot === this.orbitSlot && s.enabled)) {
      this.orbitSlot = (slots.find((s) => s.enabled)?.slot ?? "leo") as OrbitSlot;
    }
    this.captureSel.value = this.orbitSlot;
  }

  // ── Build ────────────────────────────────────────────────────────────────────

  private build(): void {
    this.panel = div("panel transfer-panel");
    this.panel.style.display = "none";

    const head = div("transfer-head");
    head.appendChild(div("panel-title", "MISSION PLANNER"));
    this.targetSel = document.createElement("select");
    this.targetSel.className = "target-sel";
    this.targetSel.onchange = () => { this.targetId = this.targetSel.value; this.refreshSelects(); this.recompute(); };
    head.appendChild(this.targetSel);
    this.panel.appendChild(head);

    this.originEl = div("transfer-origin", "From: —");
    this.panel.appendChild(this.originEl);

    // Route mode — Direct / Suggest / Via 1 / Via 2 (mutually exclusive).
    this.modeRow = div("transfer-modes");
    for (const [m, label] of [["direct", "Direct"], ["suggest", "Suggest"], ["via1", "1 flyby"], ["via2", "2 flybys"]] as const) {
      const b = btn(label, () => this.setRouteMode(m));
      markTerm(b, label, { decorate: false });
      this.modeBtns[m] = b;
      this.modeRow.appendChild(b);
    }
    this.panel.appendChild(this.modeRow);

    // Moon sub-mode — Direct hop / Flyby tour (shown only when the ship is at the moon's parent
    // AND that parent has ≥2 other moons to slingshot past).
    this.moonModeRow = div("transfer-modes");
    for (const [m, label] of [["direct", "Direct hop"], ["tour", "Flyby tour"]] as const) {
      const b = btn(label, () => this.setMoonMode(m));
      markTerm(b, label, { decorate: false });
      this.moonModeBtns[m] = b;
      this.moonModeRow.appendChild(b);
    }
    this.panel.appendChild(this.moonModeRow);

    // Flyby pickers (shown only in via1/via2).
    this.viaRow = div("transfer-head");
    this.viaRow.appendChild(sectionLabel("VIA FLYBY"));
    this.viaSel = document.createElement("select");
    this.viaSel.className = "target-sel";
    this.viaSel.onchange = () => { this.viaId = this.viaSel.value; this.refreshSelects(); this.recompute(); };
    this.viaRow.appendChild(this.viaSel);
    this.panel.appendChild(this.viaRow);

    this.via2Row = div("transfer-head");
    this.via2Row.appendChild(sectionLabel("VIA FLYBY 2"));
    this.via2Sel = document.createElement("select");
    this.via2Sel.className = "target-sel";
    this.via2Sel.onchange = () => { this.via2Id = this.via2Sel.value; this.refreshSelects(); this.recompute(); };
    this.via2Row.appendChild(this.via2Sel);
    this.panel.appendChild(this.via2Row);

    // Optimize for — drives the porkchop crosshair and the assist/suggest ranking.
    this.critRow = div("transfer-head");
    const critRow = this.critRow;
    critRow.appendChild(sectionLabel("OPTIMIZE FOR"));
    this.critSel = document.createElement("select");
    this.critSel.className = "target-sel";
    for (const [val, label] of [["dv", "Least Δv (fuel)"], ["time", "Shortest flight"], ["balanced", "Balanced"]] as const) {
      const o = document.createElement("option");
      o.value = val; o.textContent = label;
      this.critSel.appendChild(o);
    }
    this.critSel.onchange = () => { this.criterion = this.critSel.value as Criterion; this.recompute(); };
    critRow.appendChild(this.critSel);
    this.panel.appendChild(critRow);

    // Destination orbit — the second-level selector (low circular / loose ellipse / aerocapture /
    // geostationary / Lagrange points), filtered per body. Options are filled by refreshOrbitSlots.
    this.capRow = div("transfer-head");
    this.capRow.appendChild(sectionLabel("DESTINATION ORBIT"));
    this.captureSel = document.createElement("select");
    this.captureSel.className = "target-sel";
    this.captureSel.onchange = () => {
      this.orbitSlot = this.captureSel.value as OrbitSlot;
      // Switching slot can change the whole route shape (a Lagrange point, a GEO raise, or a plain
      // capture), so recompute from scratch rather than re-reading a cell.
      this.recompute();
    };
    this.capRow.appendChild(this.captureSel);
    this.panel.appendChild(this.capRow);

    this.canvas = document.createElement("canvas");
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.canvas.className = "porkchop";
    this.canvas.onclick = (e) => this.onCanvasClick(e);
    this.panel.appendChild(this.canvas);

    this.axisEl = div("pork-axis");
    this.panel.appendChild(this.axisEl);

    this.suggestEl = div("transfer-suggest");
    this.panel.appendChild(this.suggestEl);

    this.moonTourEl = div("transfer-suggest");
    this.panel.appendChild(this.moonTourEl);

    this.readout = div("transfer-readout");
    this.panel.appendChild(this.readout);

    const btns = div("transfer-btns");
    this.optBtn = btn("Use optimum", () => this.selectBest());
    this.optBtn.title = "Jump to the window that wins under the chosen criterion.";
    this.commitBtn = btn("Commit", () => this.commit());
    this.commitBtn.className = "primary";
    const close = btn("Close", () => this.close());
    btns.append(this.optBtn, this.commitBtn, close);
    this.panel.appendChild(btns);

    this.root.appendChild(this.panel);
  }

  open(shipId: string): void {
    this.shipId = shipId;
    this.panel.style.display = "flex";
    this.refreshSelects();
    this.setRouteMode(this.routeMode);
  }

  isOpen(): boolean {
    return this.panel.style.display !== "none";
  }

  close(): void {
    this.panel.style.display = "none";
    this.traj.setPreviewRoute(null);
  }

  private setRouteMode(m: RouteMode): void {
    this.routeMode = m;
    if (m === "direct" || m === "suggest") { this.viaId = ""; this.via2Id = ""; }
    if (m === "via1") this.via2Id = "";
    for (const k of ["direct", "suggest", "via1", "via2"] as RouteMode[]) {
      this.modeBtns[k]?.classList.toggle("active", k === m);
    }
    this.refreshSelects();
    this.recompute(); // recompute → layoutForTarget sets the per-mode control visibility
  }

  private setMoonMode(m: MoonMode): void {
    this.moonMode = m;
    for (const k of ["direct", "tour"] as MoonMode[]) this.moonModeBtns[k]?.classList.toggle("active", k === m);
    this.recompute();
  }

  // ── Preview ──────────────────────────────────────────────────────────────────

  private updatePreview(): void {
    const ship = this.shipId ? this.sim.world.ships.get(this.shipId) : undefined;
    if (!ship) { this.traj.setPreviewRoute(null); return; }
    // A synchronous/Lagrange arrival's geometry (a moving point / a synchronous ring) isn't drawn
    // by the heliocentric route overlay yet; a same-parent moon hop is a parent-centric arc.
    if (this.isNewSlot() || this.isMoonTarget()) { this.traj.setPreviewRoute(null); return; }
    const fromId = this.originId();
    const target = BODY_BY_ID.get(this.targetId);
    const rParkTo = target ? target.radius + DEFAULT_CAPTURE_ALT : undefined;
    const el = shipOsculatingElements(ship, this.sim.world.t);
    const rParkFrom = periapsisRadius(el.a, el.e);
    if (this.chain) {
      const result = this.chain.result;
      this.traj.setPreviewRoute({
        fromId, targetId: this.targetId, tDepart: result.tDepart, tArrive: result.tArrive,
        flybys: result.flybys.map((f) => ({ bodyId: f.bodyId, tFlyby: f.t })), rParkFrom, rParkTo,
      });
      return;
    }
    if (this.viaId && this.assist) {
      const a = this.assist;
      this.traj.setPreviewRoute({
        fromId, targetId: this.targetId, tDepart: a.tDepart, tArrive: a.tArrive,
        flybys: [{ bodyId: this.viaId, tFlyby: a.tFlyby }], rParkFrom, rParkTo,
      });
      return;
    }
    const cell = this.selectedCell();
    if (!cell || !isFinite(cell.total)) { this.traj.setPreviewRoute(null); return; }
    this.traj.setPreviewRoute({
      fromId, targetId: this.targetId, tDepart: cell.depT, tArrive: cell.arrT, rParkFrom, rParkTo,
    });
  }

  // ── Recompute ────────────────────────────────────────────────────────────────

  /** The departure/arrival parking radii for the current ship + target. */
  private parkRadii(): { rParkFrom: number; rParkTo: number } {
    const ship = this.sim.world.ships.get(this.shipId!)!;
    const rParkFrom = ship.primary === "sun"
      ? BODY_BY_ID.get("earth")!.radius + DEFAULT_CAPTURE_ALT
      : periapsisRadius(shipOsculatingElements(ship, this.sim.world.t).a, shipOsculatingElements(ship, this.sim.world.t).e);
    const rParkTo = BODY_BY_ID.get(this.effectiveTarget())!.radius + DEFAULT_CAPTURE_ALT;
    return { rParkFrom, rParkTo };
  }

  /** Heliocentric controls (route mode, criterion, capture, porkchop) apply to interplanetary
   *  transfers; a moon transfer is a single parent-centric hop, so they're hidden. A synchronous /
   *  Lagrange destination is a direct arrival of its own and hides the route machinery entirely. */
  private layoutForTarget(): void {
    // Synchronous (GEO) or Lagrange destination — no route modes, flybys, or moon tour. A
    // same-primary GEO raise is a single Hohmann (no porkchop/criterion); remote GEO and every
    // Lagrange point read off a porkchop. The DESTINATION ORBIT selector always stays.
    if (this.isNewSlot()) {
      const sameGeo = this.isGeoRaise();
      this.modeRow.style.display = "none";
      this.moonModeRow.style.display = "none";
      this.viaRow.style.display = "none";
      this.via2Row.style.display = "none";
      this.capRow.style.display = "flex";
      this.critRow.style.display = sameGeo ? "none" : "flex";
      this.canvas.style.display = sameGeo ? "none" : "block";
      this.suggestEl.style.display = "none";
      this.moonTourEl.style.display = "none";
      return;
    }
    const moon = this.isMoonTarget();       // same-parent parent-centric hop
    const mission = this.isMoonMission();   // cross-system two-stage (heliocentric Stage 1)
    const canTour = this.canMoonTour();     // the parent has ≥2 other moons to slingshot past
    if (!canTour && this.moonMode !== "direct") this.moonMode = "direct";
    const tour = moon && canTour && this.moonMode === "tour";
    const moonDirect = moon && !tour;       // a single parent-centric hop (now porkchop-driven)
    // Aerocapture is a heliocentric/tour arrival choice; a single moon hop offers only the
    // propulsive circular / loose-ellipse split, so hide it and drop any stale selection.
    const aeroOpt = Array.from(this.captureSel.options).find((o) => o.value === "aerocapture");
    if (aeroOpt) aeroOpt.hidden = moonDirect;
    if (moonDirect && this.orbitSlot === "aerocapture") { this.orbitSlot = "leo"; this.captureSel.value = "leo"; }
    // A same-parent hop hides every heliocentric control. A mission flies a Direct heliocentric
    // Stage-1 to the parent planet, so it keeps the porkchop + criterion + capture, but offers no
    // flyby/suggest variants (planMoonMission plans a direct Stage 1).
    this.modeRow.style.display = moon || mission ? "none" : "flex";
    this.moonModeRow.style.display = moon && canTour ? "flex" : "none";
    for (const k of ["direct", "tour"] as MoonMode[]) this.moonModeBtns[k]?.classList.toggle("active", k === this.moonMode);
    this.critRow.style.display = moon ? "none" : "flex";
    this.viaRow.style.display = !moon && !mission && (this.routeMode === "via1" || this.routeMode === "via2") ? "flex" : "none";
    this.via2Row.style.display = !moon && !mission && this.routeMode === "via2" ? "flex" : "none";
    // The DESTINATION ORBIT selector is the primary second-level control — always shown.
    this.capRow.style.display = "flex";
    // The porkchop canvas backs every route except the heliocentric Suggest list and the moon tour.
    this.canvas.style.display = tour || (!moon && !mission && this.routeMode === "suggest") ? "none" : "block";
    this.suggestEl.style.display = !moon && !mission && this.routeMode === "suggest" ? "block" : "none";
    this.moonTourEl.style.display = tour ? "block" : "none";
  }

  private recomputeMoon(): void {
    const ship = this.sim.world.ships.get(this.shipId!)!;
    const t0 = this.sim.world.t;
    this.pork = null; this.assist = null; this.chain = null;
    this.traj.setPreviewRoute(null); // the parent-centric hop/tour isn't drawn by the heliocentric overlay
    if (this.moonMode === "tour" && this.canMoonTour()) {
      this.computeMoonTours(ship, t0);
      this.updateReadout();
    } else {
      this.moonTours = []; this.selectedTour = null;
      // A single moon hop now reads off a parent-centric porkchop (the intra-system twin of the
      // heliocentric one) — circular or the cheap loose ellipse per the chosen capture mode.
      const aPark = shipOsculatingElements(ship, t0).a;
      this.pork = computeMoonPorkchop(
        ship.primary, this.targetId, t0, (t) => shipRelativeState(ship, t), aPark, this.captureApoAlt(),
      );
      this.selectBest(); // positions the crosshair on the cheapest cell and updates the readout
    }
  }

  /** Search a curated set of sibling-moon flyby sequences (each outer moon alone, plus the two
   *  outermost together — outer-first pumps the apoapsis down), rank by total Δv, keep the best few. */
  private computeMoonTours(ship: Ship, t0: number): void {
    const siblings = this.siblingMoons(); // outer-first
    const seqs: string[][] = siblings.map((m) => [m.id]);
    if (siblings.length >= 2) seqs.push([siblings[0]!.id, siblings[1]!.id]);
    const apoAlt = this.captureApoAlt();
    const shipState = (t: number) => shipRelativeState(ship, t);
    const found: { flybyMoonIds: string[]; result: MoonTourResult }[] = [];
    for (const seq of seqs) {
      const r = searchMoonTour(ship.primary, seq, this.targetId, {
        tDepart: t0, shipState, steps: 4, phaseSteps: 20, captureApoAlt: apoAlt,
      });
      if (r) found.push({ flybyMoonIds: seq, result: r });
    }
    found.sort((a, z) => a.result.dvTotal - z.result.dvTotal);
    this.moonTours = found.slice(0, 4);
    this.selectedTour = this.moonTours[0] ?? null;
    this.renderMoonTours();
  }

  private renderMoonTours(): void {
    this.moonTourEl.innerHTML = "";
    if (this.moonTours.length === 0) {
      this.moonTourEl.appendChild(div("transfer-readout", "No flyby tour found — try the Direct hop."));
      return;
    }
    const cheapest = Math.min(...this.moonTours.map((t) => t.result.dvTotal));
    this.moonTourEl.appendChild(div("section-label", "FLYBY TOURS — least Δv"));
    for (const t of this.moonTours) {
      const names = t.result.flybys.map((f) => BODY_BY_ID.get(f.moonId)!.name).join(" → ");
      const row = btn(
        `${names}  ·  ${(t.result.dvTotal / 1000).toFixed(2)} km/s  ·  ${((t.result.tArrive - t.result.tDepart) / DAY).toFixed(0)} d${t.result.dvTotal === cheapest ? "  (cheapest)" : ""}`,
        () => { this.selectedTour = t; this.renderMoonTours(); this.updateReadout(); },
      );
      row.className = "suggest-row";
      if (this.selectedTour === t) row.classList.add("active");
      this.moonTourEl.appendChild(row);
    }
  }

  private recompute(): void {
    if (!this.shipId || !this.sim.world.ships.get(this.shipId)) return;
    this.layoutForTarget();
    // A synchronous (GEO) or Lagrange-point destination is a direct arrival of its own — it takes
    // over the route entirely (no flybys / suggest / moon tour).
    if (this.isLagrangeSlot()) { this.recomputeLagrange(); return; }
    if (this.orbitSlot === "geo") { this.recomputeSync(); return; }
    if (this.isMoonTarget()) { this.recomputeMoon(); return; }
    const t0 = this.sim.world.t;
    const fromId = this.originId();
    const toId = this.effectiveTarget(); // the parent planet for a cross-system moon mission
    const { rParkFrom, rParkTo } = this.parkRadii();
    const win = transferWindow(fromId, toId, t0);

    // The porkchop underpins Direct and Via modes (and the Suggest list's Direct option).
    this.pork = computePorkchop({
      fromId, toId, depStart: t0, depEnd: t0 + win.depSpan, depN: 64,
      tofMin: win.tofMin, tofMax: win.tofMax, tofN: 48, rParkFrom, rParkTo,
    });
    this.assist = null;
    this.chain = null;
    this.suggestions = [];

    // A cross-system moon mission flies a Direct heliocentric Stage-1 to the parent planet
    // (the sim auto-chains the moon leg on capture) — no flyby/suggest variants in this cut.
    if (this.isMoonMission()) { this.selectBest(); return; }

    if (this.routeMode === "suggest") {
      this.suggestions = suggestRoutes(fromId, this.targetId, t0, { rParkFrom, rParkTo }, this.criterion);
      this.renderSuggestions();
      return;
    }

    if (this.routeMode === "via2" && this.viaId && this.via2Id) {
      const bodyIds = [fromId, this.viaId, this.via2Id, this.targetId];
      if (new Set(bodyIds).size === 4) {
        const refs = this.balancedRefs();
        const best = bestChain(bodyIds, t0, { rParkFrom, rParkTo, depSpan: win.depSpan, criterion: this.criterion, refs });
        this.chain = best ? { ...best, bodyIds } : null;
      }
      this.selectBest();
      return;
    }

    if (this.routeMode === "via1" && this.viaId && this.viaId !== this.targetId && this.viaId !== fromId) {
      const refs = this.balancedRefs();
      this.assist = bestAssist(fromId, this.viaId, this.targetId, t0, { rParkFrom, rParkTo, depSpan: win.depSpan, criterion: this.criterion, refs });
    }
    this.selectBest();
  }

  /** Same-primary GEO raise (no porkchop — a single in-SOI Hohmann), or a remote synchronous-orbit
   *  capture (a porkchop to the body costed with a direct circular synchronous capture). */
  private recomputeSync(): void {
    this.assist = null; this.chain = null; this.suggestions = [];
    this.traj.setPreviewRoute(null);
    const t0 = this.sim.world.t;
    if (this.isGeoRaise()) {
      this.pork = null;
      this.selI = -1; this.selJ = -1;
      this.draw();
      this.updateReadout();
      return;
    }
    const fromId = this.originId();
    const { rParkFrom } = this.parkRadii();
    const win = transferWindow(fromId, this.targetId, t0);
    this.pork = computeSynchronousPorkchop(fromId, this.targetId, {
      depStart: t0, depEnd: t0 + win.depSpan, depN: 64, tofMin: win.tofMin, tofMax: win.tofMax, tofN: 48,
    }, rParkFrom);
    this.selectBest();
  }

  /** A transfer to a Lagrange point — a porkchop in the L-point's cruise frame: heliocentric for a
   *  planet's Sun–planet points, geocentric (parent-period span) for a moon's planet–moon points. */
  private recomputeLagrange(): void {
    this.assist = null; this.chain = null; this.suggestions = [];
    this.traj.setPreviewRoute(null);
    const point = this.lagrangePoint()!;
    const t0 = this.sim.world.t;
    const { rParkFrom } = this.parkRadii();
    const secondary = BODY_BY_ID.get(this.targetId)!;
    const central = lagrangeCentral(secondary);
    let grid;
    if (central === undefined) {
      const win = transferWindow(this.originId(), this.targetId, t0);
      grid = { depStart: t0, depEnd: t0 + win.depSpan, depN: 56, tofMin: win.tofMin, tofMax: win.tofMax, tofN: 44 };
    } else {
      const parent = BODY_BY_ID.get(central)!;
      const rSec = length(bodyStateRelative(secondary, t0).r);
      const secPeriod = 2 * Math.PI * Math.sqrt((rSec * rSec * rSec) / parent.mu);
      const hTof = hohmann(parent.mu, rParkFrom, rSec).tof;
      grid = { depStart: t0, depEnd: t0 + secPeriod, depN: 48, tofMin: 0.5 * hTof, tofMax: 1.8 * hTof, tofN: 40 };
    }
    this.pork = computeLagrangePorkchop(this.sim, this.shipId!, this.targetId, point, grid, rParkFrom);
    this.selectBest();
  }

  /** Reference scales for the "balanced" criterion = the porkchop's min-Δv cell. */
  private balancedRefs(): { dvRef: number; tofRef: number } {
    const dvMin = this.pork ? bestPorkCell(this.pork, "dv") : null;
    return dvMin ? { dvRef: dvMin.total, tofRef: dvMin.tof } : { dvRef: 1, tofRef: 1 };
  }

  private selectBest(): void {
    const cell = this.pork ? bestPorkCell(this.pork, this.criterion) : null;
    if (!cell) {
      this.draw();
      if (this.viaId) { this.updateReadout(); this.updatePreview(); return; }
      this.readout.textContent = "No transfer solution in range.";
      this.traj.setPreviewRoute(null);
      return;
    }
    this.selI = Math.round((cell.depT - this.pork!.depStart) / this.pork!.depStep);
    this.selJ = Math.round((cell.tof - this.pork!.tofStart) / this.pork!.tofStep);
    this.draw();
    this.updateReadout();
    this.updatePreview();
  }

  private onCanvasClick(e: MouseEvent): void {
    if (!this.pork) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * CANVAS_W;
    const py = ((e.clientY - rect.top) / rect.height) * CANVAS_H;
    const cellW = CANVAS_W / this.pork.depN;
    const cellH = CANVAS_H / this.pork.tofN;
    const i = Math.floor(px / cellW);
    const jFromTop = Math.floor(py / cellH);
    const j = this.pork.tofN - 1 - jFromTop;
    if (i < 0 || i >= this.pork.depN || j < 0 || j >= this.pork.tofN) return;
    this.selI = i; this.selJ = j;
    this.draw();
    this.updateReadout();
    this.updatePreview();
  }

  private draw(): void {
    const ctx = this.canvas.getContext("2d")!;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    if (!this.pork) return;
    const { cells, depN, tofN, best } = this.pork;
    const cellW = CANVAS_W / depN;
    const cellH = CANVAS_H / tofN;
    const lo = best ? best.total : 0;
    const hi = best ? best.total * 2.2 : 1;
    for (let i = 0; i < depN; i++) {
      for (let j = 0; j < tofN; j++) {
        const cell = cells[i]![j]!;
        const x = i * cellW;
        const y = (tofN - 1 - j) * cellH;
        if (!isFinite(cell.total)) {
          ctx.fillStyle = "#0a0e16";
        } else {
          const tt = Math.max(0, Math.min(1, (cell.total - lo) / (hi - lo)));
          ctx.fillStyle = `hsl(${240 * (1 - tt)}, 72%, 52%)`;
        }
        ctx.fillRect(x, y, cellW + 0.6, cellH + 0.6);
      }
    }
    if (best) {
      const bi = Math.round((best.depT - this.pork.depStart) / this.pork.depStep);
      const bj = Math.round((best.tof - this.pork.tofStart) / this.pork.tofStep);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(bi * cellW + cellW / 2, (tofN - 1 - bj) * cellH + cellH / 2, 4, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (this.selI >= 0) {
      const cx = this.selI * cellW + cellW / 2;
      const cy = (tofN - 1 - this.selJ) * cellH + cellH / 2;
      // Match the live accent palette (the canvas can't read CSS vars itself).
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#4fd1e0";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy);
      ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6);
      ctx.stroke();
    }
  }

  private selectedCell(): PorkCell | null {
    if (!this.pork || this.selI < 0 || this.selJ < 0) return null;
    return this.pork.cells[this.selI]?.[this.selJ] ?? null;
  }

  // ── Suggest list ─────────────────────────────────────────────────────────────

  private renderSuggestions(): void {
    this.suggestEl.innerHTML = "";
    if (this.suggestions.length === 0) {
      this.suggestEl.appendChild(div("transfer-readout", "No route found to this destination."));
      setDisabled(this.commitBtn, true, "No route found.");
      return;
    }
    const cheapest = Math.min(...this.suggestions.map((r) => r.dvTotal));
    this.suggestEl.appendChild(div("section-label", `BEST ROUTES — ${this.criterionLabel()}`));
    for (const r of this.suggestions) {
      const row = btn(
        `${r.label}  ·  ${(r.dvTotal / 1000).toFixed(2)} km/s  ·  ${((r.tArrive - r.tDepart) / DAY).toFixed(0)} d${r.dvTotal === cheapest ? "  (cheapest)" : ""}`,
        () => this.selectSuggestion(r),
      );
      row.className = "suggest-row";
      this.suggestEl.appendChild(row);
    }
    this.updateReadout();
    this.traj.setPreviewRoute(null);
  }

  /** Adopt a suggested route: switch to the matching concrete mode with its state preloaded. */
  private selectSuggestion(r: SuggestedRoute): void {
    if (r.kind === "direct") {
      this.routeMode = "direct";
      this.viaId = ""; this.via2Id = "";
    } else if (r.kind === "assist" && r.assist) {
      this.routeMode = "via1";
      this.viaId = r.bodyIds[1]!; this.via2Id = "";
      this.assist = r.assist;
    } else if (r.kind === "chain" && r.chain) {
      this.routeMode = "via2";
      this.viaId = r.bodyIds[1]!; this.via2Id = r.bodyIds[2]!;
      this.chain = { ...r.chain, bodyIds: r.bodyIds };
    }
    for (const k of ["direct", "suggest", "via1", "via2"] as RouteMode[]) this.modeBtns[k]?.classList.toggle("active", k === this.routeMode);
    this.viaRow.style.display = this.routeMode === "via1" || this.routeMode === "via2" ? "flex" : "none";
    this.via2Row.style.display = this.routeMode === "via2" ? "flex" : "none";
    this.suggestEl.style.display = "none";
    this.canvas.style.display = "block";
    this.refreshSelects();
    // For direct, recompute the porkchop selection; for assist/chain the result is preloaded.
    if (r.kind === "direct") { this.recompute(); } else { this.selectBest(); }
  }

  private criterionLabel(): string {
    return { dv: "least Δv", time: "shortest flight", balanced: "balanced" }[this.criterion];
  }

  // ── Readout + commit ─────────────────────────────────────────────────────────

  /** Readout for the selected moon flyby tour: the per-flyby ledger + a whole-tour budget gate. */
  private updateMoonTourReadout(ship: Ship): void {
    const moon = BODY_BY_ID.get(this.targetId)!;
    this.axisEl.innerHTML = `<span>${BODY_BY_ID.get(this.originId())?.name} orbit → ${moon.name} (flyby tour)</span>`;
    // A moon has no atmosphere, so a tour captures propulsively — circular or a loose ellipse.
    const aeroOpt = this.captureSel.querySelector('option[value="aerocapture"]') as HTMLOptionElement | null;
    if (aeroOpt) aeroOpt.disabled = true;
    if (this.orbitSlot === "aerocapture") { this.orbitSlot = "leo"; this.captureSel.value = "leo"; }
    this.captureSel.disabled = false;

    const sel = this.selectedTour;
    if (!sel) {
      this.readout.innerHTML = `No flyby tour to ${moon.name} found — try the Direct hop.`;
      setDisabled(this.commitBtn, true, "No flyby tour found.");
      return;
    }
    const r = sel.result;
    const haveDv = dvRemaining(ship);
    const loose = this.captureApoAlt() !== undefined;
    const feasible = r.dvTotal <= haveDv;
    this.readout.innerHTML =
      kvAuto("Tour", `via ${r.flybys.map((f) => BODY_BY_ID.get(f.moonId)!.name).join(" → ")}`) +
      kvAuto("Depart", formatDate(r.tDepart)) +
      r.flybys.map((f) => kvAuto(`Flyby ${BODY_BY_ID.get(f.moonId)!.name}`,
        `${formatDate(f.t)} · ${(f.dvFlyby / 1000).toFixed(3)} km/s${f.unpowered ? " (free)" : ""}`)).join("") +
      kvAuto("Arrive", formatDate(r.tArrive)) +
      kvAuto("Flight time", `${((r.tArrive - r.tDepart) / DAY).toFixed(1)} days`) +
      kvAuto("Injection Δv", `${(r.dvDepart / 1000).toFixed(3)} km/s`) +
      kvAuto("Flyby Δv (total)", `${(r.dvFlybyTotal / 1000).toFixed(3)} km/s${r.unpowered ? " (all free)" : ""}`) +
      kvAuto("Capture Δv", `${(r.dvArrive / 1000).toFixed(3)} km/s${loose ? " (loose ellipse)" : " (circular)"}`) +
      kvAuto("Total Δv", `${(r.dvTotal / 1000).toFixed(3)} km/s`) +
      kvAuto("Ship Δv available", `${(haveDv / 1000).toFixed(2)} km/s`) +
      (feasible ? `<div class="ok">✓ within budget</div>` : `<div class="warn">✗ exceeds Δv budget</div>`);
    setDisabled(this.commitBtn, !feasible, "Tour Δv exceeds the ship's budget.");
  }

  /** Readout for a same-primary GEO raise: the in-SOI Hohmann ledger and a budget gate. */
  private updateGeoRaiseReadout(ship: Ship): void {
    const body = BODY_BY_ID.get(this.originId())!;
    this.axisEl.innerHTML = `<span>${body.name} orbit → geostationary (synchronous raise)</span>`;
    const plan = geoRaisePreview(this.sim, this.shipId!);
    if (!plan) {
      this.readout.innerHTML = `No synchronous orbit available at ${body.name}.`;
      setDisabled(this.commitBtn, true, "No synchronous orbit here.");
      return;
    }
    const haveDv = dvRemaining(ship);
    const feasible = plan.dvTotal <= haveDv;
    this.readout.innerHTML =
      kvAuto("Raise to", `GEO — ${formatLength(plan.aSync - body.radius)} circular (synchronous)`) +
      kvAuto("Transfer burn", `${(plan.dv1 / 1000).toFixed(3)} km/s`) +
      kvAuto("Circularize + plane change", `${(plan.dv2 / 1000).toFixed(3)} km/s`) +
      kvAuto("Total Δv", `${(plan.dvTotal / 1000).toFixed(3)} km/s`) +
      kvAuto("Transfer time", `${(plan.tof / DAY).toFixed(2)} days`) +
      kvAuto("Ship Δv available", `${(haveDv / 1000).toFixed(2)} km/s`) +
      (feasible ? `<div class="ok">✓ within budget</div>` : `<div class="warn">✗ exceeds Δv budget</div>`);
    setDisabled(this.commitBtn, !feasible, "GEO raise Δv exceeds the ship's budget.");
  }

  /** Readout for a remote synchronous capture or a Lagrange-point transfer: the selected porkchop
   *  cell's injection + arrival ledger (arrival = circularize+plane for GEO, a velocity match for L). */
  private updateNewOrbitReadout(ship: Ship): void {
    const target = BODY_BY_ID.get(this.targetId)!;
    const isLagr = this.isLagrangeSlot();
    const label = isLagr ? `${this.systemLabel(target)} ${this.orbitSlot}` : `${target.name} synchronous`;
    this.axisEl.innerHTML = `<span>${BODY_BY_ID.get(this.originId())?.name} → ${label} &nbsp;·&nbsp; ↑ flight time &nbsp; → departure date</span>`;
    const cell = this.selectedCell();
    if (!cell || !isFinite(cell.total)) {
      this.readout.innerHTML = `No transfer window to ${label} found.`;
      setDisabled(this.commitBtn, true, "No window found.");
      return;
    }
    const haveDv = dvRemaining(ship);
    const feasible = cell.total <= haveDv;
    this.readout.innerHTML =
      kvAuto("Destination", label) + kvAuto("Optimizing", this.criterionLabel()) +
      kvAuto("Depart", formatDate(cell.depT)) + kvAuto("Arrive", formatDate(cell.arrT)) +
      kvAuto("Flight time", `${(cell.tof / DAY).toFixed(0)} days`) +
      kvAuto("Injection Δv", `${(cell.dvDepart / 1000).toFixed(3)} km/s`) +
      kvAuto(isLagr ? "Station-keeping Δv" : "Capture Δv (circ + plane)", `${(cell.dvArrive / 1000).toFixed(3)} km/s`) +
      kvAuto("Total Δv", `${(cell.total / 1000).toFixed(3)} km/s`) +
      kvAuto("Ship Δv available", `${(haveDv / 1000).toFixed(2)} km/s`) +
      (feasible ? `<div class="ok">✓ within budget</div>` : `<div class="warn">✗ exceeds Δv budget</div>`);
    setDisabled(this.commitBtn, !feasible, "Transfer Δv exceeds the ship's budget.");
  }

  private updateReadout(): void {
    const ship = this.shipId ? this.sim.world.ships.get(this.shipId) : undefined;

    // Same-primary GEO raise: a single in-SOI Hohmann ledger (no porkchop cell).
    if (this.isGeoRaise() && ship) { this.updateGeoRaiseReadout(ship); return; }
    // Remote synchronous capture or any Lagrange-point transfer: read the selected porkchop cell.
    if (this.isNewSlot() && ship) { this.updateNewOrbitReadout(ship); return; }

    // Moon flyby tour: a parent-centric gravity-assist chain, costed by searchMoonTour.
    if (this.isMoonTarget() && ship && this.moonMode === "tour" && this.canMoonTour()) {
      this.updateMoonTourReadout(ship);
      return;
    }

    // Moon transfer: a single parent-centric hop, read off the moon porkchop's selected cell
    // (its dvArrive is already circular or the cheap loose ellipse per the chosen capture mode).
    if (this.isMoonTarget() && ship) {
      const moon = BODY_BY_ID.get(this.targetId)!;
      const cell = this.selectedCell();
      this.axisEl.innerHTML = `<span>${BODY_BY_ID.get(this.originId())?.name} orbit → ${moon.name} &nbsp;·&nbsp; ↑ flight time &nbsp; → departure date</span>`;
      if (!cell || !isFinite(cell.total)) {
        this.readout.innerHTML = `No transfer window to ${moon.name} found.`;
        setDisabled(this.commitBtn, true, "No window found."); return;
      }
      const apoAlt = this.captureApoAlt();
      const ellipseLine = apoAlt !== undefined
        ? kvAuto("Capture orbit", `${formatLengthPair(DEFAULT_CAPTURE_ALT, apoAlt)} (ellipse)`) : "";
      const haveDv = dvRemaining(ship);
      const feasible = cell.total <= haveDv;
      this.readout.innerHTML =
        kvAuto("Depart", formatDate(cell.depT)) + kvAuto("Arrive", formatDate(cell.arrT)) +
        kvAuto("Flight time", `${(cell.tof / DAY).toFixed(1)} days`) +
        kvAuto("Injection Δv", `${(cell.dvDepart / 1000).toFixed(3)} km/s`) +
        kvAuto("Capture Δv", `${(cell.dvArrive / 1000).toFixed(3)} km/s`) +
        ellipseLine +
        kvAuto("Total Δv", `${(cell.total / 1000).toFixed(3)} km/s`) +
        kvAuto("Ship Δv available", `${(haveDv / 1000).toFixed(2)} km/s`) +
        (feasible ? `<div class="ok">✓ within budget</div>` : `<div class="warn">✗ exceeds Δv budget</div>`);
      setDisabled(this.commitBtn, !feasible, "Transfer Δv exceeds the ship's budget.");
      return;
    }

    // A cross-system mission flies a Direct heliocentric Stage-1 to the parent planet — its
    // capture options and porkchop cell are read against that planet, not the moon.
    const mission = this.isMoonMission();
    const directLike = mission || this.routeMode === "direct";
    // A gravity-assist / chain arrival captures at the target too, so it offers the same
    // capture choice (cheap elliptical insertion is how Cassini/Galileo really arrived).
    const assistLike = !mission && (this.routeMode === "via1" || this.routeMode === "via2");
    const capturing = directLike || assistLike;

    // Capture mode is an arrival choice. Propulsive (circular or loose ellipse) is always
    // available; aerocapture needs an atmosphere, so that option is disabled at airless targets.
    const hasAtm = !!BODY_BY_ID.get(this.effectiveTarget())?.atmosphere;
    this.captureSel.disabled = !capturing;
    this.capRow.style.display = capturing ? "flex" : "none";
    const aeroOpt = this.captureSel.querySelector('option[value="aerocapture"]') as HTMLOptionElement | null;
    if (aeroOpt) aeroOpt.disabled = !hasAtm;
    if (!hasAtm && this.orbitSlot === "aerocapture") {
      this.orbitSlot = "leo"; this.captureSel.value = "leo";
    }

    if (!mission && this.routeMode === "suggest") return; // the list is the readout

    const optLine = kvAuto("Optimizing", this.criterionLabel());

    if (this.chain && ship) {
      const r = this.chain.result;
      const haveDv = dvRemaining(ship);
      const names = r.flybys.map((f) => BODY_BY_ID.get(f.bodyId)!.name).join(" → ");
      const cap = this.assistCaptureLine(r.vInfArrive);
      const verdict = cap.feasible
        ? this.budgetVerdict(r.dvDepart + r.dvFlybyTotal, cap.dvArrive, haveDv)
        : { ok: false, html: `<div class="warn">✗ ${cap.label}</div>` };
      this.axisEl.innerHTML = `<span>gravity-assist chain via ${names}</span>`;
      this.readout.innerHTML =
        optLine +
        kvAuto("Depart", formatDate(r.tDepart)) +
        r.flybys.map((f) => {
          const fb = BODY_BY_ID.get(f.bodyId)!;
          const bRadii = (impactParameter(f.vInfIn, fb.mu, f.rp) / fb.radius).toFixed(1);
          return kvAuto(`Flyby ${fb.name}`,
            `${formatDate(f.t)} · b ${bRadii} R, turn ${((f.turnRequired * 180) / Math.PI).toFixed(0)}° · ${(f.dvFlyby / 1000).toFixed(3)} km/s${f.unpowered ? " (free)" : ""}`);
        }).join("") +
        kvAuto("Arrive", formatDate(r.tArrive)) +
        kvAuto("Flight time", `${((r.tArrive - r.tDepart) / DAY).toFixed(0)} days`) +
        kvAuto("Injection Δv", `${(r.dvDepart / 1000).toFixed(3)} km/s`) +
        kvAuto("Flyby Δv (total)", `${(r.dvFlybyTotal / 1000).toFixed(3)} km/s${r.unpowered ? " (all free)" : ""}`) +
        kvAuto("Capture Δv", cap.feasible ? `${(cap.dvArrive / 1000).toFixed(3)} km/s${cap.label}` : cap.label) +
        kvAuto("Total Δv", `${((r.dvDepart + r.dvFlybyTotal + cap.dvArrive) / 1000).toFixed(3)} km/s`) +
        verdict.html;
      setDisabled(this.commitBtn, !verdict.ok, "Injection + flyby + capture Δv exceeds the ship's budget, or aerocapture infeasible.");
      return;
    }

    if (!mission && this.routeMode === "via2" && ship && !this.chain) {
      this.readout.innerHTML = optLine + "No usable two-flyby chain in range — try different via bodies.";
      setDisabled(this.commitBtn, true, "No usable gravity-assist chain in range.");
      return;
    }

    if (!mission && this.viaId && ship) {
      const a = this.assist;
      if (!a) {
        this.readout.innerHTML = optLine + `No usable ${BODY_BY_ID.get(this.viaId)?.name ?? this.viaId} assist in range.`;
        setDisabled(this.commitBtn, true, "No usable gravity-assist solution in range.");
        return;
      }
      const haveDv = dvRemaining(ship);
      const directBest = this.pork ? bestPorkCell(this.pork, "dv")?.total : undefined;
      const cap = this.assistCaptureLine(a.vInfArrive);
      const verdict = cap.feasible
        ? this.budgetVerdict(a.dvDepart + a.dvFlyby, cap.dvArrive, haveDv)
        : { ok: false, html: `<div class="warn">✗ ${cap.label}</div>` };
      const vb = BODY_BY_ID.get(this.viaId)!;
      const bRadii = (impactParameter(a.vInfIn, vb.mu, a.flybyRadius) / vb.radius).toFixed(1);
      this.axisEl.innerHTML = `<span>gravity assist via ${vb.name}</span>`;
      this.readout.innerHTML =
        optLine +
        kvAuto("Depart", formatDate(a.tDepart)) +
        kvAuto(`Flyby ${vb.name}`, `${formatDate(a.tFlyby)} · peri ${formatLength(a.flybyRadius)}, b ${bRadii} R, turn ${((a.turnRequired * 180) / Math.PI).toFixed(0)}°`) +
        kvAuto("Arrive", formatDate(a.tArrive)) +
        kvAuto("Flight time", `${((a.tArrive - a.tDepart) / DAY).toFixed(0)} days`) +
        kvAuto("Injection Δv", `${(a.dvDepart / 1000).toFixed(3)} km/s`) +
        kvAuto("Flyby Δv", `${(a.dvFlyby / 1000).toFixed(3)} km/s${a.unpowered ? " (free)" : ""}`) +
        kvAuto("Capture Δv", cap.feasible ? `${(cap.dvArrive / 1000).toFixed(3)} km/s${cap.label}` : cap.label) +
        kvAuto("Total Δv", `${((a.dvDepart + a.dvFlyby + cap.dvArrive) / 1000).toFixed(3)} km/s`) +
        (directBest ? kvAuto("Direct best Δv", `${(directBest / 1000).toFixed(3)} km/s`) : "") +
        verdict.html;
      setDisabled(this.commitBtn, !verdict.ok, "Injection + flyby + capture Δv exceeds the ship's budget, or aerocapture infeasible.");
      return;
    }

    const cell = this.selectedCell();
    if (!cell || !ship || !isFinite(cell.total)) {
      this.readout.innerHTML = optLine + "No solution for this cell.";
      setDisabled(this.commitBtn, true, "No transfer solution for this cell — pick another or use the optimum.");
      return;
    }
    const haveDv = dvRemaining(ship);
    const effId = this.effectiveTarget();
    const target = BODY_BY_ID.get(effId);
    const fromId = this.originId();
    // For a cross-system mission the porkchop targets the parent planet (Stage 1); name both legs.
    const moonName = mission ? BODY_BY_ID.get(this.targetId)!.name : "";
    const stage2 = mission
      ? kvAuto("Stage 2", `${target!.name} → ${moonName} (auto on arrival)`) : "";
    this.axisEl.innerHTML = mission
      ? `<span>Stage 1: ${BODY_BY_ID.get(fromId)?.name} → ${target!.name} &nbsp;·&nbsp; → departure date</span>`
      : `<span>↑ flight time &nbsp; → departure date</span>`;
    const dvMin = this.pork ? bestPorkCell(this.pork, "dv") : null;
    const trade = this.criterion !== "dv" && dvMin
      ? kvAuto("Min-Δv flight time", `${(dvMin.tof / DAY).toFixed(0)} days @ ${(dvMin.total / 1000).toFixed(2)} km/s`) : "";

    const aero = this.orbitSlot === "aerocapture" && target?.atmosphere
      ? aerocapturePreview(effId, fromId, cell.depT, cell.arrT) : null;
    if (this.orbitSlot === "aerocapture" && target?.atmosphere) {
      // Aerocapture pays only a small post-pass trim, so the budget verdict folds that in.
      const verdict = aero?.feasible
        ? this.budgetVerdict(cell.dvDepart, aero.trimDv, haveDv, true)
        : { ok: false, html: `<div class="warn">✗ arrival too fast to aerocapture here</div>` };
      this.readout.innerHTML =
        optLine +
        kvAuto("Depart", formatDate(cell.depT)) + kvAuto("Arrive", formatDate(cell.arrT)) +
        kvAuto("Flight time", `${(cell.tof / DAY).toFixed(0)} days`) + trade +
        kvAuto("Injection Δv", `${(cell.dvDepart / 1000).toFixed(3)} km/s`) +
        kvAuto("Capture", aero?.feasible ? "aerocapture — drag pass" : "aerocapture not possible") +
        (aero?.feasible ? kvAuto("Arrival trim Δv", `${(aero.trimDv / 1000).toFixed(3)} km/s`) : "") +
        (aero ? kvAuto("Saved vs propulsive", `${(aero.propulsiveDv / 1000).toFixed(3)} km/s`) : "") +
        stage2 +
        verdict.html;
      setDisabled(this.commitBtn, !verdict.ok, "Aerocapture infeasible or injection exceeds budget.");
      return;
    }

    // Capture Δv: the porkchop cell is a low circular capture; an elliptical capture is cheaper,
    // so recompute it (and the saving) for the chosen apoapsis.
    const apoAlt = this.captureApoAlt();
    const captureDv = apoAlt !== undefined
      ? (captureDvPreview(effId, fromId, cell.depT, cell.arrT, apoAlt) ?? cell.dvArrive)
      : cell.dvArrive;
    const ellipseLine = apoAlt !== undefined
      ? kvAuto("Capture orbit", `${(DEFAULT_CAPTURE_ALT / 1000).toFixed(0)} × ${(apoAlt / 1000).toFixed(0)} km (ellipse)`) +
        kvAuto("Saved vs circular", `${((cell.dvArrive - captureDv) / 1000).toFixed(3)} km/s`)
      : "";
    const totalDv = cell.dvDepart + captureDv;
    // Gate on the WHOLE mission (injection + capture), not just injection — a deep-well
    // arrival can be captured the cheap elliptical/aero way, and the planner should say so
    // honestly rather than green-light a low-circular capture the ship can't afford.
    const verdict = this.budgetVerdict(cell.dvDepart, captureDv, haveDv);
    this.readout.innerHTML =
      optLine +
      kvAuto("Depart", formatDate(cell.depT)) + kvAuto("Arrive", formatDate(cell.arrT)) +
      kvAuto("Flight time", `${(cell.tof / DAY).toFixed(0)} days`) + trade +
      kvAuto("Injection Δv", `${(cell.dvDepart / 1000).toFixed(3)} km/s`) +
      kvAuto(mission ? "Stage 1 capture Δv" : "Arrival (capture) Δv", `${(captureDv / 1000).toFixed(3)} km/s`) +
      ellipseLine +
      kvAuto("Total Δv", `${(totalDv / 1000).toFixed(3)} km/s`) +
      stage2 +
      kvAuto("Ship Δv available", `${(haveDv / 1000).toFixed(2)} km/s`) +
      verdict.html;
    setDisabled(this.commitBtn, !verdict.ok, "Injection + capture Δv exceeds the ship's budget — pick a cheaper capture (loose ellipse / aerocapture).");
  }

  private commit(): void {
    if (!this.shipId) return;
    // Same-primary GEO raise — a single in-SOI Hohmann, no porkchop cell.
    if (this.isGeoRaise()) {
      if (!planGeoRaise(this.sim, this.shipId)) return;
      this.focusAndClose();
      return;
    }
    // Remote synchronous capture, or a Lagrange-point transfer — read the selected porkchop cell.
    if (this.isNewSlot()) {
      const cell = this.selectedCell();
      if (!cell || !isFinite(cell.total)) return;
      const ok = this.isLagrangeSlot()
        ? planLagrange(this.sim, this.shipId, this.targetId, this.lagrangePoint()!, cell.depT, cell.arrT)
        : planSynchronousTransfer(this.sim, this.shipId, this.targetId, cell.depT, cell.arrT);
      if (!ok) return;
      this.focusAndClose();
      return;
    }
    if (this.isMoonTarget() && this.moonMode === "tour" && this.selectedTour) {
      const sel = this.selectedTour;
      if (!planMoonTour(this.sim, this.shipId, sel.flybyMoonIds, this.targetId, sel.result.times, this.captureApoAlt())) return;
      this.focusAndClose();
      return;
    }
    if (this.isMoonTarget()) {
      const cell = this.selectedCell();
      if (!cell || !isFinite(cell.total)) return;
      if (!planMoonTransfer(this.sim, this.shipId, this.targetId, cell.depT, cell.arrT, this.captureApoAlt())) return;
      this.focusAndClose();
      return;
    }
    if (this.chain) {
      const mode = this.commandCaptureMode();
      const apoAlt = this.captureApoAlt();
      if (!planChainAssist(this.sim, this.shipId, this.chain.bodyIds, this.chain.times, mode, apoAlt)) return;
      this.focusAndClose();
      return;
    }
    if (this.viaId && this.assist) {
      const a = this.assist;
      const mode = this.commandCaptureMode();
      const apoAlt = this.captureApoAlt();
      if (!planAssist(this.sim, this.shipId, this.viaId, this.targetId, a.tDepart, a.tFlyby, a.tArrive, mode, apoAlt)) return;
      this.focusAndClose();
      return;
    }
    const cell = this.selectedCell();
    if (!cell) return;
    const target = BODY_BY_ID.get(this.effectiveTarget());
    const mode = this.orbitSlot === "aerocapture" && target?.atmosphere ? "aerocapture" : "propulsive";
    const apoAlt = this.captureApoAlt(); // set ⇒ elliptical (loose) capture; undefined ⇒ circular
    // A cross-system mission plans the Stage-1 heliocentric leg to the parent planet and tags the
    // final moon; the sim auto-chains Stage 2 on capture. A plain transfer otherwise.
    if (this.isMoonMission()) {
      if (!planMoonMission(this.sim, this.shipId, this.targetId, cell.depT, cell.arrT, mode, apoAlt)) return;
      this.focusAndClose();
      return;
    }
    if (!planTransfer(this.sim, this.shipId, this.targetId, cell.depT, cell.arrT, mode, apoAlt)) return;
    this.focusAndClose();
  }

  private focusAndClose(): void {
    this.sm.setFocusTarget(this.shipId!, (t) => {
      const s = this.sim.world.ships.get(this.shipId!);
      return s ? shipWorldState(s, t).r : { x: 0, y: 0, z: 0 };
    }, 500);
    this.close();
  }
}
