/**
 * The flight console — the fly-it half of the Mission panel (building a vehicle
 * lives in the full-viewport {@link Shipyard}).
 *
 * Rather than a wall of telemetry lines, it reads like an instrument panel: a
 * colour-coded STATUS banner, a live MINI-ORBIT diagram, the handful of VITALS a
 * controller always watches as bars + trends, and the deep telemetry tucked into
 * disclosure TABLES (NAV / PROPULSION / THERMAL & SIGNATURE / COMMS / TRANSFER)
 * shown only when they carry content. Contextual ACTIONS (transfer, surface ops,
 * spiral, dock) and the burn console surface only when viable.
 *
 * Built once; the per-frame {@link update} only mutates instrument values, so the
 * rich readout costs about what the old text dump did.
 */

import { type Simulation } from "@lightlag/engine/sim";
import { type SceneManager } from "../render/SceneManager.ts";
import { type BurnDir, type BurnGoal, type Ship } from "@lightlag/engine/world";
import {
  sendBurn,
  landShip,
  launchShip,
  flyEntry,
  planSpiral,
  deleteShip,
  shipSurfaceParams,
  dockCandidates,
  transferPropellant,
  assembleShips,
  shipPropStatus,
} from "../app/commands.ts";
import {
  ascentBudget,
  descentBudget,
  surfaceManeuverCost,
  DEFAULT_ENTRY_BETA,
} from "@lightlag/engine/surface";
import { entryTrajectory, entryInterfaceAlt, type EntryVehicle } from "@lightlag/engine/maneuver/entry";
import { availablePowerW, thrustAt } from "@lightlag/engine/propulsion";
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
} from "@lightlag/engine/ships";
import { summarizeOrbit, periapsisRadius, orbitalPeriod, j2Rates, type OrbitSummary } from "@lightlag/engine/orbit";
import { bodyPosition, bodyState } from "@lightlag/engine/ephemeris";
import { selectPerturbers } from "@lightlag/engine/perturbed";
import { thirdBodyAccel } from "@lightlag/engine/perturbations";
import { retardedTime } from "@lightlag/engine/comms";
import { STAR_BY_ID } from "@lightlag/engine/stars";
import { type BodyDef, BODY_BY_ID, AU, DAY, DEG, RAD, JULIAN_YEAR, j2RefRadius } from "@lightlag/engine/constants";
import { formatDate } from "@lightlag/engine/time";
import { length, sub } from "@lightlag/engine/math/vec3";
import { el, button, kv, setDisabled, numberField, formatDur } from "./dom.ts";
import { collapsible, type Collapsible } from "./collapsible.ts";
import { markTerm } from "./tooltip.ts";
import {
  statPill, meter, statTable, miniOrbit, sparkline,
  type StatPill, type Meter, type StatTable, type MiniOrbit, type InstrumentState,
} from "./instruments.ts";
import {
  bannerOf, shortStatusOf, orbitViewOf, orbitCaptionOf,
  fmtDelay, fmtDoppler, fmtPower, fmtRange,
} from "./shipStatus.ts";
import { type EventFeed } from "./events.ts";

/** A `.section-label` div tagged as a hover term (SURFACE OPS, ELECTRIC SPIRAL). */
function sectionLabel(text: string): HTMLElement {
  const e = el("div", "section-label", text);
  markTerm(e, text);
  return e;
}

const DIRS: BurnDir[] = ["prograde", "retrograde", "radial-out", "radial-in", "normal", "antinormal"];
const DIR_LABEL: Record<BurnDir, string> = {
  prograde: "Prograde",
  retrograde: "Retrograde",
  "radial-out": "Radial out",
  "radial-in": "Radial in",
  normal: "Normal",
  antinormal: "Anti-normal",
};

/** One label/value row destined for a stat table. */
interface Row { key: string; value: string; state?: InstrumentState; }

/** A live trend vital: a label, a sparkline, and a right-aligned numeric value. */
interface Vital { root: HTMLElement; set(text: string, sample?: number): void; reset(): void; }

export class ShipPanel {
  private selectedId: string | null = null;
  private dir: BurnDir = "prograde";
  private guidanceMode: "open" | "closed" = "open";
  private goalType: "periapsis" | "apoapsis" | "circularize" = "periapsis";

  private panelEl!: HTMLElement;
  private shipListEl!: HTMLElement;
  private flightEl!: HTMLElement;
  private dvInput!: HTMLInputElement;
  private dirRow!: HTMLElement;
  private guidanceRow!: HTMLElement;
  private goalRow!: HTMLElement;
  private goalTypeRow!: HTMLElement;
  private goalAltInput!: HTMLInputElement;
  private guidanceHint!: HTMLElement;
  private executeBtn!: HTMLButtonElement;
  private planBtn!: HTMLButtonElement;
  private interstellarBtn!: HTMLButtonElement;
  private warpDepartBtn!: HTMLButtonElement;
  private actionsEl!: HTMLElement;
  private deleteBtn!: HTMLButtonElement;

  // Instruments.
  private nameEl!: HTMLElement;
  private banner!: StatPill;
  private chipRow!: HTMLElement;
  private orderChip!: StatPill;
  private hotChip!: StatPill;
  private orbitViz!: MiniOrbit;
  private vitalsEl!: HTMLElement;
  private dvMeter!: Meter;
  private fuelMeter!: Meter;
  private speedVital!: Vital;
  private signalVital!: Vital;
  private burnRow!: HTMLElement;
  private burnMeter!: Meter;
  private navTable!: StatTable; private navSec!: Collapsible; private navKeys = new Set<string>();
  private propTable!: StatTable; private propSec!: Collapsible; private propKeys = new Set<string>();
  private thermTable!: StatTable; private thermSec!: Collapsible; private thermKeys = new Set<string>();
  private commsTable!: StatTable; private commsSec!: Collapsible; private commsKeys = new Set<string>();
  private xferTable!: StatTable; private xferSec!: Collapsible; private xferKeys = new Set<string>();
  /** Reference Δv (the most a ship has had) so the Δv bar reads as "fuel for maneuvering". */
  private maxDv = new Map<string, number>();

  // Contextual operations (surface ops / electric spiral / dock), folded into one card.
  private opsSec!: Collapsible;
  private surfaceEl!: HTMLElement;
  private surfaceReadout!: HTMLElement;
  private surfaceAltInput!: HTMLInputElement;
  private landBtn!: HTMLButtonElement;
  private launchBtn!: HTMLButtonElement;
  private flyEntryBtn!: HTMLButtonElement;
  private electricEl!: HTMLElement;
  private spiralAltInput!: HTMLInputElement;
  private spiralBtn!: HTMLButtonElement;
  private fidelityEl!: HTMLElement;
  private fidelityReadout!: HTMLElement;
  private fidelityBtn!: HTMLButtonElement;
  private dockEl!: HTMLElement;
  private dockReadout!: HTMLElement;
  private dockSelect!: HTMLSelectElement;
  private dockAmountInput!: HTMLInputElement;
  private sendBtn!: HTMLButtonElement;
  private receiveBtn!: HTMLButtonElement;
  private assembleBtn!: HTMLButtonElement;
  private dockPartnerId: string | null = null;
  private lastDockSig = "";

  // Fleet rows, kept persistent so per-frame status pills mutate cheaply.
  private fleetSection!: Collapsible;
  private fleetRows = new Map<string, { row: HTMLButtonElement; pill: StatPill }>();
  private fleetSig = "";

  // Rolling mission-event log (shared feed; attached after construction).
  private eventFeed?: EventFeed;
  private eventsSec!: Collapsible;
  private eventsList!: HTMLElement;
  private lastEventsKey = "";

  constructor(
    private root: HTMLElement,
    private sim: Simulation,
    private sm: SceneManager,
    private onPlanTransfer?: (shipId: string) => void,
    private onPlanInterstellar?: (shipId: string) => void,
    private onOpenShipyard?: () => void,
  ) {
    this.build();
  }

  toggle(): void {
    this.panelEl.style.display = this.isOpen() ? "none" : "flex";
  }
  isOpen(): boolean {
    return this.panelEl.style.display !== "none";
  }
  /** Select a ship by id — used by the Shipyard after a launch, and internally. */
  selectShip(id: string): void { this.select(id); }
  /** The currently-selected ship id (or null) — for the closed-panel HUD. */
  get selected(): string | null { return this.selectedId; }
  /** Attach the shared mission-event feed (rendered as the console's Events log). */
  attachEventFeed(feed: EventFeed): void { this.eventFeed = feed; }

  private build(): void {
    const panel = el("div", "panel ship-panel");
    this.panelEl = panel;

    const head = el("div", "panel-head");
    head.appendChild(el("div", "panel-title", "MISSION"));
    const close = button("✕", () => this.toggle());
    close.className = "panel-close";
    close.title = "Close (F or Esc)";
    head.appendChild(close);
    panel.appendChild(head);

    const buildBtn = button("✚ Build a ship — Shipyard ▸", () => this.onOpenShipyard?.());
    buildBtn.className = "wide-btn yard-open-btn";
    buildBtn.title = "Open the Shipyard (B) to design and launch a vehicle.";
    panel.appendChild(buildBtn);

    // ── Fleet ────────────────────────────────────────────────────────────────
    this.fleetSection = collapsible("Fleet", { id: "fleet", open: true });
    this.shipListEl = el("div", "ship-list");
    this.fleetSection.body.appendChild(this.shipListEl);
    panel.appendChild(this.fleetSection.root);

    // ── Selected-ship console (shown once a ship is selected) ─────────────────
    this.flightEl = el("div", "console");

    this.nameEl = el("div", "console-name");
    this.flightEl.appendChild(this.nameEl);

    // Status banner + cross-cutting chips.
    this.banner = statPill("", "neutral");
    this.banner.root.classList.add("banner");
    this.flightEl.appendChild(this.banner.root);
    this.chipRow = el("div", "ins-chip-row console-chips");
    this.orderChip = statPill("", "info");
    this.hotChip = statPill("DRIVE HOT", "warn");
    this.chipRow.append(this.orderChip.root, this.hotChip.root);
    this.flightEl.appendChild(this.chipRow);

    // Mini-orbit hero.
    this.orbitViz = miniOrbit({ width: 244, height: 150 });
    this.flightEl.appendChild(this.orbitViz.root);

    // Vitals: Δv, fuel, speed (+trend), signal (+trend), and the burn meter.
    this.vitalsEl = el("div", "vitals");
    this.dvMeter = meter("Δv");
    this.fuelMeter = meter("Fuel", { term: false });
    this.speedVital = this.makeVital("Speed");
    this.signalVital = this.makeVital("Signal");
    this.burnRow = el("div", "burn-row");
    this.burnMeter = meter("Burn", { term: false });
    this.burnRow.appendChild(this.burnMeter.root);
    this.burnRow.style.display = "none";
    this.vitalsEl.append(this.dvMeter.root, this.fuelMeter.root, this.speedVital.root, this.signalVital.root, this.burnRow);
    this.flightEl.appendChild(this.vitalsEl);

    // Disclosure tables.
    ({ table: this.navTable, sec: this.navSec } = this.makeTable("NAV", "nav", true,
      ["Frame", "Distance from Sun", "Orbiting", "Periapsis", "Apoapsis", "Period", "Node precession", "Apsidal precession"]));
    ({ table: this.propTable, sec: this.propSec } = this.makeTable("Propulsion", "propulsion", false,
      ["Mass", "Δv remaining", "Active stage", "Drive power", "Drive thrust", "Spiraling"]));
    ({ table: this.thermTable, sec: this.thermSec } = this.makeTable("Thermal & signature", "thermal", false,
      ["Solar flux", "Hull temp", "IR signature", "Detectable to", "Min signal", "Waste heat", "Radiator"]));
    ({ table: this.commsTable, sec: this.commsSec } = this.makeTable("Comms", "comms", false,
      ["Signal delay", "Doppler", "Order ETA"]));
    ({ table: this.xferTable, sec: this.xferSec } = this.makeTable("Transfer", "transfer", true,
      ["Transfer", "Capture Δv", "Interstellar", "Crew clock τ"]));
    for (const sec of [this.navSec, this.propSec, this.thermSec, this.commsSec, this.xferSec]) {
      this.flightEl.appendChild(sec.root);
    }

    // ── Actions ───────────────────────────────────────────────────────────────
    this.actionsEl = el("div", "console-actions");
    this.planBtn = button("Plan transfer ▸", () => { if (this.selectedId && this.onPlanTransfer) this.onPlanTransfer(this.selectedId); });
    this.planBtn.className = "wide-btn";
    this.interstellarBtn = button("Interstellar ▸", () => { if (this.selectedId && this.onPlanInterstellar) this.onPlanInterstellar(this.selectedId); });
    this.interstellarBtn.className = "wide-btn";
    this.warpDepartBtn = button("⏩ Warp to departure", () => this.warpToDeparture());
    this.warpDepartBtn.className = "wide-btn";
    this.warpDepartBtn.style.display = "none";
    this.actionsEl.append(this.planBtn, this.interstellarBtn, this.warpDepartBtn);
    this.flightEl.appendChild(this.actionsEl);

    // ── Maneuver ──────────────────────────────────────────────────────────────
    const maneuverSection = collapsible("Maneuver", { id: "maneuver", open: true });
    const mnv = maneuverSection.body;
    this.dirRow = el("div", "dir-row");
    for (const d of DIRS) {
      const b = button(DIR_LABEL[d], () => { this.dir = d; this.syncDirButtons(); });
      b.className = "dir-btn";
      b.dataset.dir = d;
      markTerm(b, DIR_LABEL[d], { decorate: false });
      this.dirRow.appendChild(b);
    }
    mnv.appendChild(this.dirRow);

    this.guidanceRow = el("div", "dir-row");
    const GUIDANCE: { mode: "open" | "closed"; label: string }[] = [
      { mode: "open", label: "Open-loop" },
      { mode: "closed", label: "Closed-loop" },
    ];
    for (const g of GUIDANCE) {
      const b = button(g.label, () => { this.guidanceMode = g.mode; this.syncGuidanceButtons(); });
      b.className = "dir-btn";
      b.dataset.mode = g.mode;
      markTerm(b, g.label, { decorate: false });
      this.guidanceRow.appendChild(b);
    }
    mnv.appendChild(this.guidanceRow);

    this.goalRow = el("div", "goal-row");
    this.goalTypeRow = el("div", "dir-row");
    const GOALS: { key: "periapsis" | "apoapsis" | "circularize"; label: string }[] = [
      { key: "periapsis", label: "Periapsis" },
      { key: "apoapsis", label: "Apoapsis" },
      { key: "circularize", label: "Circularize" },
    ];
    for (const g of GOALS) {
      const b = button(g.label, () => { this.goalType = g.key; this.syncGuidanceButtons(); });
      b.className = "dir-btn";
      b.dataset.goal = g.key;
      markTerm(b, g.label, { decorate: false });
      this.goalTypeRow.appendChild(b);
    }
    this.goalRow.appendChild(this.goalTypeRow);
    this.goalAltInput = numberField(this.goalRow, "Target alt (km)", 1000, () => {});
    this.guidanceHint = el("div", "guidance-hint");
    this.goalRow.appendChild(this.guidanceHint);
    mnv.appendChild(this.goalRow);

    const dvRow = el("div", "dv-row");
    this.dvInput = document.createElement("input");
    this.dvInput.type = "number";
    this.dvInput.value = "500";
    this.dvInput.min = "0";
    this.dvInput.className = "dv-input";
    const dvLabel = el("span", "dv-label", "Δv (m/s)");
    markTerm(dvLabel, "Δv (m/s)");
    this.executeBtn = button("Execute burn", () => this.execute());
    this.executeBtn.className = "primary";
    dvRow.append(dvLabel, this.dvInput, this.executeBtn);
    mnv.appendChild(dvRow);
    this.flightEl.appendChild(maneuverSection.root);

    // ── Operations (surface / spiral / dock — only when viable) ───────────────
    this.opsSec = collapsible("Operations", { id: "operations", open: true });
    this.buildOperations(this.opsSec.body);
    this.flightEl.appendChild(this.opsSec.root);

    // Rolling event log.
    this.eventsSec = collapsible("Events", { id: "events", open: false });
    this.eventsList = el("div", "events-list");
    this.eventsSec.body.appendChild(this.eventsList);
    this.eventsSec.root.style.display = "none";
    this.flightEl.appendChild(this.eventsSec.root);

    this.deleteBtn = button("🗑 Delete ship", () => this.doDelete());
    this.deleteBtn.className = "wide-btn danger";
    this.deleteBtn.title = "Remove this ship from the simulation. Cannot be undone.";
    this.flightEl.appendChild(this.deleteBtn);

    panel.appendChild(this.flightEl);
    this.root.appendChild(panel);

    this.syncFleet(this.sim.world.t);
    this.syncDirButtons();
    this.syncGuidanceButtons();
    this.flightEl.style.display = "none";
  }

  /** Build the three contextual operation sub-cards into the OPERATIONS body. */
  private buildOperations(host: HTMLElement): void {
    this.surfaceEl = el("div", "surface-ops");
    this.surfaceEl.appendChild(sectionLabel("SURFACE OPS"));
    this.surfaceReadout = el("div", "surface-readout");
    this.surfaceEl.appendChild(this.surfaceReadout);
    const surfRow = el("div", "dv-row");
    this.surfaceAltInput = document.createElement("input");
    this.surfaceAltInput.type = "number";
    this.surfaceAltInput.value = "200";
    this.surfaceAltInput.min = "0";
    this.surfaceAltInput.className = "dv-input";
    surfRow.append(el("span", "dv-label", "orbit (km)"), this.surfaceAltInput);
    this.landBtn = button("⬇ Land", () => this.doLand());
    this.launchBtn = button("⬆ Launch", () => this.doLaunch());
    surfRow.append(this.landBtn, this.launchBtn);
    this.surfaceEl.appendChild(surfRow);
    const entryRow = el("div", "dv-row");
    this.flyEntryBtn = button("🜂 Fly entry", () => this.doFlyEntry());
    entryRow.append(this.flyEntryBtn);
    this.surfaceEl.appendChild(entryRow);
    host.appendChild(this.surfaceEl);

    this.electricEl = el("div", "surface-ops");
    this.electricEl.appendChild(sectionLabel("ELECTRIC SPIRAL"));
    const elRow = el("div", "dv-row");
    this.spiralAltInput = document.createElement("input");
    this.spiralAltInput.type = "number";
    this.spiralAltInput.value = "35786"; // GEO
    this.spiralAltInput.min = "0";
    this.spiralAltInput.className = "dv-input";
    this.spiralBtn = button("⟳ Spiral", () => this.doSpiral());
    elRow.append(el("span", "dv-label", "to (km)"), this.spiralAltInput, this.spiralBtn);
    this.electricEl.appendChild(elRow);
    host.appendChild(this.electricEl);

    this.fidelityEl = el("div", "surface-ops");
    this.fidelityEl.appendChild(sectionLabel("FIDELITY"));
    this.fidelityReadout = el("div", "surface-readout");
    this.fidelityEl.appendChild(this.fidelityReadout);
    this.fidelityBtn = button("✦ Fly perturbed", () => this.doFidelity());
    this.fidelityBtn.className = "wide-btn";
    this.fidelityBtn.title = "Fly this ship under continuous third-body gravity (Sun/Moon on a high orbit, Earth at an L-point) instead of the default two-body coast. Toggle the Perturbed layer to also see the forecast arc.";
    this.fidelityEl.appendChild(this.fidelityBtn);
    host.appendChild(this.fidelityEl);

    this.dockEl = el("div", "surface-ops");
    this.dockEl.appendChild(sectionLabel("DOCK / TRANSFER"));
    this.dockReadout = el("div", "surface-readout");
    this.dockEl.appendChild(this.dockReadout);
    this.dockSelect = document.createElement("select");
    this.dockSelect.className = "preset-sel";
    this.dockSelect.onchange = () => { this.dockPartnerId = this.dockSelect.value || null; };
    this.dockEl.appendChild(this.dockSelect);
    const dockRow = el("div", "dv-row");
    this.dockAmountInput = document.createElement("input");
    this.dockAmountInput.type = "number";
    this.dockAmountInput.placeholder = "max";
    this.dockAmountInput.min = "0";
    this.dockAmountInput.className = "dv-input";
    this.receiveBtn = button("⛽ Receive", () => this.doTransfer("receive"));
    this.sendBtn = button("⛽ Send", () => this.doTransfer("send"));
    dockRow.append(el("span", "dv-label", "prop (t)"), this.dockAmountInput, this.receiveBtn, this.sendBtn);
    this.dockEl.appendChild(dockRow);
    this.assembleBtn = button("⊕ Assemble (merge)", () => this.doAssemble());
    this.assembleBtn.className = "wide-btn";
    this.assembleBtn.title = "Dock-merge the selected ship into this one — its stages and payload join this vehicle and it is consumed. In-orbit construction; cannot be undone.";
    this.dockEl.appendChild(this.assembleBtn);
    host.appendChild(this.dockEl);
  }

  /** A labelled disclosure section wrapping a stat table; rows predeclared in order. */
  private makeTable(label: string, id: string, open: boolean, rows: string[]): { table: StatTable; sec: Collapsible } {
    const sec = collapsible(label, { id, open });
    const table = statTable();
    for (const r of rows) table.row(r);
    sec.body.appendChild(table.root);
    return { table, sec };
  }

  /** A live trend vital (label · sparkline · value). */
  private makeVital(label: string): Vital {
    const root = el("div", "vital");
    const k = el("span", "vital-k", label);
    markTerm(k, label);
    const sp = sparkline({ width: 54, height: 14 });
    const v = el("span", "vital-v", "");
    root.append(k, sp.root, v);
    return {
      root,
      set(text, sample) {
        if (v.textContent !== text) v.textContent = text;
        if (sample !== undefined) sp.push(sample);
      },
      reset() { sp.reset(); },
    };
  }

  private select(id: string): void {
    this.selectedId = id;
    if (this.sim.world.ships.get(id)) this.frameShip(id);
    this.flightEl.style.display = "block";
    this.speedVital.reset();
    this.signalVital.reset();
    this.syncFleet(this.sim.world.t);
  }

  /** Centre the camera on a ship — but, when chasing it would strobe (a short, fast
   *  orbit at high warp), frame its PARENT body instead so you watch it circle. */
  private frameShip(id: string): void {
    const ship = this.sim.world.ships.get(id);
    if (!ship) return;
    if (this.shouldFrameParent(ship)) {
      this.sm.focusBody(ship.primary);
      return;
    }
    const el = shipOsculatingElements(ship, this.sim.world.t);
    const ra = el.a * (1 + el.e);
    const body = BODY_BY_ID.get(ship.primary);
    const scaleMeters = Number.isFinite(ra) && ra > 0 ? ra : (body ? body.radius * 3 : 1e7);
    const distUnits = Math.max((scaleMeters / 1e9) * 2.2, 0.02);
    this.sm.setFocusTarget(id, (t) => {
      const s = this.sim.world.ships.get(id);
      return s ? shipWorldState(s, t).r : { x: 0, y: 0, z: 0 };
    }, distUnits);
  }

  private shouldFrameParent(ship: Ship): boolean {
    if (ship.primary === "sun" || ship.interstellarLeg || ship.landed || ship.mode === "thrust") return false;
    if (!BODY_BY_ID.get(ship.primary)) return false;
    const el = shipOsculatingElements(ship, this.sim.world.t);
    if (el.e >= 1 || el.a <= 0) return false;
    const period = orbitalPeriod(el.a, primaryMu(ship));
    return period > 0 && this.sim.warp / period > 0.25;
  }

  private execute(): void {
    if (!this.selectedId) return;
    const dv = parseFloat(this.dvInput.value);
    if (!isFinite(dv) || dv <= 0) return;
    sendBurn(this.sim, this.selectedId, dv, this.dir, this.buildGoal());
  }

  private buildGoal(): BurnGoal | undefined {
    if (this.guidanceMode !== "closed") return undefined;
    const kind = this.goalType;
    if (kind === "circularize") return { kind: "circular" };
    const ship = this.selectedId ? this.sim.world.ships.get(this.selectedId) : undefined;
    const primary = ship ? BODY_BY_ID.get(ship.primary) : undefined;
    const altKm = parseFloat(this.goalAltInput.value);
    if (!primary || !isFinite(altKm)) return undefined;
    return { kind, rTarget: primary.radius + altKm * 1000 };
  }

  private syncDirButtons(): void {
    for (const b of Array.from(this.dirRow.children) as HTMLButtonElement[]) {
      b.classList.toggle("active", b.dataset.dir === this.dir);
    }
  }

  private syncGuidanceButtons(): void {
    for (const b of Array.from(this.guidanceRow.children) as HTMLButtonElement[]) {
      b.classList.toggle("active", b.dataset.mode === this.guidanceMode);
    }
    const closed = this.guidanceMode === "closed";
    this.goalRow.style.display = closed ? "" : "none";
    for (const b of Array.from(this.goalTypeRow.children) as HTMLButtonElement[]) {
      b.classList.toggle("active", b.dataset.goal === this.goalType);
    }
    const altField = this.goalAltInput.parentElement as HTMLElement | null;
    if (altField) altField.style.display = this.goalType === "circularize" ? "none" : "";
    if (closed) {
      const what = this.goalType === "circularize" ? "circularize at the delivery radius" : `reach the target ${this.goalType}`;
      this.guidanceHint.textContent =
        `The ship trims its Δv (≤ the value below, its correction budget) to ${what} at delivery — or NACKs if it can't.`;
    }
  }

  private setGuidanceDisabled(disabled: boolean): void {
    const btns = [
      ...Array.from(this.guidanceRow.children),
      ...Array.from(this.goalTypeRow.children),
    ] as HTMLButtonElement[];
    for (const b of btns) setDisabled(b, disabled);
    this.goalAltInput.disabled = disabled;
  }

  /** Rebuild the fleet rows only when the ship id-set changes; update each row's
   *  status pill + active state every frame (cheap). */
  private syncFleet(t: number): void {
    const ids = Array.from(this.sim.world.ships.keys());
    const sig = ids.join(",");
    if (sig !== this.fleetSig) {
      this.fleetSig = sig;
      this.shipListEl.innerHTML = "";
      this.fleetRows.clear();
      this.fleetSection.badge.textContent = ids.length ? String(ids.length) : "";
      if (ids.length === 0) {
        const empty = button("No ships yet — open the Shipyard ▸", () => this.onOpenShipyard?.());
        empty.className = "wide-btn ship-empty-btn";
        this.shipListEl.appendChild(empty);
      }
      for (const ship of this.sim.world.ships.values()) {
        const row = button("", () => this.select(ship.id));
        row.className = "ship-btn";
        const name = el("span", "ship-name", ship.name);
        const pill = statPill("", "info");
        pill.root.classList.add("fleet-pill");
        row.append(name, pill.root);
        this.shipListEl.appendChild(row);
        this.fleetRows.set(ship.id, { row, pill });
      }
    }
    for (const [id, { row, pill }] of this.fleetRows) {
      const ship = this.sim.world.ships.get(id);
      if (!ship) continue;
      row.classList.toggle("active", id === this.selectedId);
      const st = shortStatusOf(ship, t);
      pill.set(st.text, st.state);
    }
  }

  /** Per-frame refresh. */
  update(t: number): void {
    this.syncFleet(t);
    if (!this.selectedId) { this.flightEl.style.display = "none"; return; }
    const ship = this.sim.world.ships.get(this.selectedId);
    if (!ship) { this.selectedId = null; this.flightEl.style.display = "none"; return; }
    this.flightEl.style.display = "block";
    this.fillEvents();
    if (ship.status === "lost") { this.renderLost(ship); return; }

    this.nameEl.textContent = ship.name;
    this.vitalsEl.style.display = "";

    // Light-lag: what you KNOW is the ship's retarded state.
    const controlPos = bodyPosition(this.sim.world.controlNode, t);
    const tKnown = retardedTime(controlPos, (tt) => shipWorldState(ship, tt).r, t);
    const age = t - tKnown;
    const mu = primaryMu(ship);
    const primary = BODY_BY_ID.get(ship.primary)!;
    const el = shipOsculatingElements(ship, tKnown);
    const rel = shipRelativeState(ship, tKnown);
    const speed = length(rel.v);
    const dop = shipTelemetryDoppler(ship, this.sim.world.controlNode, t);
    const th = shipThermalState(ship, t);
    const stage = activeStage(ship);
    const sum: OrbitSummary | null = ship.primary !== "sun" ? summarizeOrbit(el, mu, primary.radius) : null;

    // Banner + chips.
    const b = bannerOf(ship, t, sum, primary);
    this.banner.set(b.text, b.state);
    const inbound = this.sim.world.messages.find((m) => m.kind === "command" && m.targetId === ship.id && m.tArrive > t);
    if (inbound) { this.orderChip.set(`ORDER EN ROUTE · ${fmtDelay(inbound.tArrive - t)}`, "info"); this.orderChip.root.style.display = ""; }
    else this.orderChip.root.style.display = "none";
    this.hotChip.root.style.display = th.thrusting ? "" : "none";
    this.chipRow.style.display = (inbound || th.thrusting) ? "" : "none";

    // Mini-orbit.
    this.orbitViz.set(orbitViewOf(ship, t), orbitCaptionOf(ship, t));

    // Vitals.
    const dv = dvRemaining(ship);
    const mx = Math.max(this.maxDv.get(ship.id) ?? dv, dv);
    this.maxDv.set(ship.id, mx);
    this.dvMeter.set(mx > 0 ? dv / mx : 0, { text: `${(dv / 1000).toFixed(2)} km/s`, state: dv < 50 ? "danger" : dv < 300 ? "warn" : "ok" });
    const ps = shipPropStatus(this.sim, ship.id);
    if (ps) {
      const cap = ps.available + ps.headroom;
      const f = cap > 0 ? ps.available / cap : 0;
      this.fuelMeter.set(f, { text: `${(f * 100).toFixed(0)}%`, state: f < 0.1 ? "danger" : f < 0.3 ? "warn" : "ok" });
      this.fuelMeter.root.style.display = "";
    } else this.fuelMeter.root.style.display = "none";
    this.speedVital.set(`${(speed / 1000).toFixed(3)} km/s`, speed / 1000);
    this.signalVital.set(fmtDelay(age), age);
    if (ship.mode === "thrust" && ship.burn) {
      this.burnRow.style.display = "";
      this.burnMeter.set(ship.burn.dvDone / ship.burn.dvTarget, { text: `${ship.burn.dvDone.toFixed(0)}/${ship.burn.dvTarget.toFixed(0)} m/s`, state: "warn" });
    } else this.burnRow.style.display = "none";

    // Detail tables.
    this.fillNav(ship, el, rel, sum, mu, primary);
    this.fillProp(ship, t, tKnown, stage, primary);
    this.fillThermal(th);
    this.fillComms(age, dop, inbound ? inbound.tArrive - t : null);
    this.fillTransfer(ship, t);

    // Action gating.
    const tr = ship.transfer;
    const leg = ship.interstellarLeg;
    const planned = !!tr && !tr.departed;
    this.warpDepartBtn.style.display = planned ? "block" : "none";
    if (planned) {
      setDisabled(this.warpDepartBtn, this.sim.anyThrust(), "Can't skip time while a burn is running.");
      this.warpDepartBtn.textContent = `⏩ Warp to ${formatDate(tr!.tDepart)}`;
    }
    setDisabled(this.planBtn, ship.primary === "sun" || !!leg || !!ship.landed || (!!tr && tr.departed),
      ship.landed ? "Launch to a parking orbit first." : "Plan a transfer only from a parking orbit around a body (not mid-transfer or interstellar).");
    setDisabled(this.interstellarBtn, !!leg || !!ship.landed, ship.landed ? "Launch to a parking orbit first." : "Already on an interstellar leg.");

    // Burn console lock while thrusting.
    if (ship.mode === "thrust" && ship.burn) {
      setDisabled(this.executeBtn, true, "Burn in progress.");
      this.executeBtn.textContent = "Burning…";
      this.setGuidanceDisabled(true);
    } else {
      setDisabled(this.executeBtn, false);
      this.executeBtn.textContent = "Execute burn";
      this.setGuidanceDisabled(false);
    }

    // Contextual operations.
    const canSpiral = !!stage?.electric && ship.mode === "coast" && ship.primary !== "sun" && !ship.landed && !ship.interstellarLeg && !ship.spiral;
    this.electricEl.style.display = canSpiral ? "block" : "none";
    setDisabled(this.spiralBtn, !canSpiral, "Available only with an electric drive while coasting in orbit around a body.");
    this.updateSurfaceOps(ship);
    this.updateDocking(ship);
    this.updateFidelity(ship, t);
    const opsVisible = [this.surfaceEl, this.electricEl, this.fidelityEl, this.dockEl].some((e) => e.style.display !== "none");
    this.opsSec.root.style.display = opsVisible ? "" : "none";
  }

  // ── instrument fills ──────────────────────────────────────────────────────

  private fillNav(ship: Ship, el: ReturnType<typeof shipOsculatingElements>, rel: { r: { x: number; y: number; z: number } }, sum: OrbitSummary | null, mu: number, primary: BodyDef): void {
    const rows: Row[] = [];
    if (ship.primary === "sun") {
      rows.push({ key: "Frame", value: "heliocentric" });
      rows.push({ key: "Distance from Sun", value: `${(length(rel.r) / AU).toFixed(3)} AU` });
    } else if (sum) {
      rows.push({ key: "Orbiting", value: primary.name });
      rows.push({ key: "Periapsis", value: `${(sum.periapsisAlt / 1000).toFixed(0)} km` });
      rows.push({ key: "Apoapsis", value: sum.bound ? `${(sum.apoapsisAlt / 1000).toFixed(0)} km` : "escape", state: sum.bound ? undefined : "warn" });
      rows.push({ key: "Period", value: sum.bound ? formatDur(sum.period) : "—" });
      if (sum.bound && primary.J2) {
        const r = j2Rates(mu, j2RefRadius(primary), primary.J2, el.a, el.e, el.i);
        rows.push({ key: "Node precession", value: `${(r.nodeDot * RAD * DAY).toFixed(3)}°/day` });
        rows.push({ key: "Apsidal precession", value: `${(r.periDot * RAD * DAY).toFixed(3)}°/day` });
      }
    }
    this.applyTable(this.navTable, this.navSec, this.navKeys, rows);
  }

  private fillProp(ship: Ship, t: number, tKnown: number, stage: ReturnType<typeof activeStage>, primary: BodyDef): void {
    const rows: Row[] = [
      { key: "Mass", value: `${(totalMass(ship) / 1000).toFixed(2)} t` },
      { key: "Δv remaining", value: `${(dvRemaining(ship) / 1000).toFixed(2)} km/s` },
      { key: "Active stage", value: `${ship.activeStage + 1} / ${ship.stages.length}` },
    ];
    if (stage?.electric) {
      const rHelio = length(shipWorldState(ship, tKnown).r);
      const power = availablePowerW(stage.electric, rHelio);
      const thr = thrustAt(stage, rHelio);
      const accel = thr / totalMass(ship);
      rows.push({ key: "Drive power", value: `${(power / 1000).toFixed(2)} kW${stage.electric.solar ? ` @ ${(rHelio / AU).toFixed(2)} AU` : " (reactor)"}` });
      rows.push({ key: "Drive thrust", value: `${(thr * 1000).toFixed(1)} mN · ${(accel * 1e6).toFixed(2)} mm/s²` });
    }
    if (ship.spiral) {
      const left = (ship.spiral.tEnd - t) / DAY;
      rows.push({ key: "Spiraling", value: `→ ${((ship.spiral.endRadius - primary.radius) / 1000).toFixed(0)} km · ${left.toFixed(0)} d`, state: "active" });
    }
    this.applyTable(this.propTable, this.propSec, this.propKeys, rows);
  }

  private fillThermal(th: ReturnType<typeof shipThermalState>): void {
    const rows: Row[] = [
      { key: "Solar flux", value: `${th.solarFlux.toFixed(0)} W/m² @ ${(th.distanceFromSun / AU).toFixed(2)} AU` },
      { key: "Hull temp", value: `${th.hullTempK.toFixed(0)} K` },
      { key: "IR signature", value: fmtPower(th.signatureW) + (th.thrusting ? " · HOT" : ""), state: th.thrusting ? "warn" : undefined },
      { key: "Detectable to", value: `${fmtRange(th.detectionRangeM)} (${th.snrThreshold}σ, ${(th.integrationTimeS / 3600).toFixed(0)}h)` },
      { key: "Min signal", value: `${(th.minDetectablePowerW * 1e18).toFixed(1)} aW` },
    ];
    if (th.thrusting) {
      rows.push({ key: "Waste heat", value: fmtPower(th.driveWasteW) });
      rows.push({ key: "Radiator", value: `${Math.round(th.radiatorAreaM2).toLocaleString("en-US")} m²` });
    }
    this.applyTable(this.thermTable, this.thermSec, this.thermKeys, rows);
  }

  private fillComms(age: number, dop: TelemetryDoppler | null, orderEta: number | null): void {
    const rows: Row[] = [{ key: "Signal delay", value: fmtDelay(age) }];
    if (dop) rows.push({ key: "Doppler", value: fmtDoppler(dop) });
    if (orderEta !== null) rows.push({ key: "Order ETA", value: fmtDelay(orderEta) });
    this.applyTable(this.commsTable, this.commsSec, this.commsKeys, rows);
  }

  private fillTransfer(ship: Ship, t: number): void {
    const rows: Row[] = [];
    const tr = ship.transfer;
    if (tr) {
      const tName = BODY_BY_ID.get(tr.targetId)?.name ?? tr.targetId;
      if (!tr.departed) rows.push({ key: "Transfer", value: `→ ${tName}, depart ${formatDate(tr.tDepart)}`, state: "active" });
      else if (tr.arrived) rows.push({ key: "Transfer", value: `captured ${tName} · Δv ${(tr.dvArrive / 1000).toFixed(2)} km/s`, state: "ok" });
      else if (tr.inSoi) rows.push({ key: "Transfer", value: `${tName} SOI — capturing`, state: "active" });
      else {
        rows.push({ key: "Transfer", value: `→ ${tName}, arrive ${((tr.tArrive - t) / DAY).toFixed(0)} d`, state: "active" });
        rows.push({ key: "Capture Δv", value: `${(tr.dvArrive / 1000).toFixed(2)} km/s` });
      }
      if (tr.flybys) {
        for (const f of tr.flybys) {
          const fb = BODY_BY_ID.get(f.bodyId);
          const fName = fb?.name ?? f.bodyId;
          if (f.done && f.rpAchieved !== undefined) {
            const periAlt = (f.rpAchieved - (fb?.radius ?? 0)) / 1000;
            const bRadii = fb ? f.bMag! / fb.radius : 0;
            const free = (f.residualTurn ?? 0) < 1e-6 && f.dvBurn < 1;
            rows.push({ key: `Flyby ${fName}`, value: `peri ${periAlt.toFixed(0)} km · b ${bRadii.toFixed(1)} R · turn ${((f.turn ?? 0) * RAD).toFixed(0)}°` + (free ? " · free" : ` · burn ${f.dvBurn.toFixed(0)} m/s`) });
          } else {
            rows.push({ key: `Flyby ${fName}`, value: `pending · ${formatDate(f.tFlyby)}` });
          }
        }
      }
    }
    const leg = ship.interstellarLeg;
    if (leg) {
      const starName = STAR_BY_ID.get(leg.targetStar)?.name ?? leg.targetStar;
      rows.push({ key: "Interstellar", value: t >= leg.tArrive ? `arrived ${starName}` : `→ ${starName} · ${((leg.tArrive - t) / JULIAN_YEAR).toFixed(2)} yr`, state: "active" });
      rows.push({ key: "Crew clock τ", value: `${(ship.tau / JULIAN_YEAR).toFixed(2)} yr` });
    }
    this.applyTable(this.xferTable, this.xferSec, this.xferKeys, rows);
  }

  /** Set the given rows on a table, hide any previously-set keys now absent, and
   *  toggle the section's visibility on whether it has any content. */
  private applyTable(table: StatTable, sec: Collapsible, prev: Set<string>, rows: Row[]): void {
    const now = new Set<string>();
    for (const r of rows) { table.set(r.key, r.value, { state: r.state }); now.add(r.key); }
    for (const k of prev) if (!now.has(k)) table.hide(k);
    prev.clear();
    for (const k of now) prev.add(k);
    sec.root.style.display = now.size > 0 ? "" : "none";
  }

  /** Render the rolling event log; rebuild the list only when the newest changes. */
  private fillEvents(): void {
    if (!this.eventFeed) { this.eventsSec.root.style.display = "none"; return; }
    const recent = this.eventFeed.recent(6);
    if (recent.length === 0) { this.eventsSec.root.style.display = "none"; return; }
    this.eventsSec.root.style.display = "";
    const key = recent.map((e) => e.t + e.text).join("|");
    if (key === this.lastEventsKey) return;
    this.lastEventsKey = key;
    this.eventsList.innerHTML = "";
    for (const e of recent) {
      const line = el("div", "event-line", e.text);
      line.dataset.state = e.state;
      this.eventsList.appendChild(line);
    }
  }

  /** Propellant-transfer / assembly controls, shown only at rendezvous. */
  private updateDocking(ship: Ship): void {
    const candidates = dockCandidates(this.sim, ship.id);
    if (candidates.length === 0) {
      this.dockEl.style.display = "none";
      this.dockPartnerId = null;
      this.lastDockSig = "";
      return;
    }
    this.dockEl.style.display = "block";
    const sig = candidates.map((c) => c.id).join(",");
    if (sig !== this.lastDockSig) {
      this.lastDockSig = sig;
      this.dockSelect.innerHTML = "";
      for (const c of candidates) {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.name;
        this.dockSelect.appendChild(opt);
      }
    }
    if (!this.dockPartnerId || !candidates.some((c) => c.id === this.dockPartnerId)) {
      this.dockPartnerId = candidates[0]!.id;
    }
    this.dockSelect.value = this.dockPartnerId;
    const partner = candidates.find((c) => c.id === this.dockPartnerId)!;
    const me = shipPropStatus(this.sim, ship.id)!;
    const them = shipPropStatus(this.sim, partner.id)!;
    this.dockReadout.innerHTML =
      kv("Docked with", `${partner.name} · ${partner.distance.toFixed(0)} m, ${partner.relSpeed.toFixed(2)} m/s`) +
      kv("This ship", `prop ${(me.available / 1000).toFixed(1)} t · room ${(me.headroom / 1000).toFixed(1)} t`) +
      kv(partner.name, `prop ${(them.available / 1000).toFixed(1)} t · room ${(them.headroom / 1000).toFixed(1)} t`);
    setDisabled(this.receiveBtn, !(them.available > 1 && me.headroom > 1), "Partner has no propellant to give, or this ship's tanks are full.");
    setDisabled(this.sendBtn, !(me.available > 1 && them.headroom > 1), "This ship has no propellant to give, or the partner's tanks are full.");
  }

  private doTransfer(dir: "send" | "receive"): void {
    if (!this.selectedId || !this.dockPartnerId) return;
    const raw = this.dockAmountInput.value.trim();
    const amountKg = raw === "" ? undefined : Math.max(0, Number(raw) * 1000) || undefined;
    const [from, to] = dir === "send" ? [this.selectedId, this.dockPartnerId] : [this.dockPartnerId, this.selectedId];
    transferPropellant(this.sim, from, to, amountKg);
  }

  private doAssemble(): void {
    if (!this.selectedId || !this.dockPartnerId) return;
    const partnerId = this.dockPartnerId;
    const wasFocused = this.sm.focusId === partnerId;
    if (assembleShips(this.sim, this.selectedId, partnerId)) {
      this.dockPartnerId = null;
      this.lastDockSig = "";
      if (wasFocused) this.frameShip(this.selectedId);
      this.syncFleet(this.sim.world.t);
    }
  }

  /** Landing/takeoff Δv budget, shown only when coasting in a body's SOI (or landed). */
  private updateSurfaceOps(ship: Ship): void {
    const landed = ship.landed;
    const body = landed ? BODY_BY_ID.get(landed.bodyId) : BODY_BY_ID.get(ship.primary);
    const inTransfer = !!ship.transfer && ship.transfer.departed && !ship.transfer.arrived;
    const showable = !!body && body.hasSurface !== false && ship.primary !== "sun" && ship.mode === "coast" && !inTransfer;
    if (!showable || !body) { this.surfaceEl.style.display = "none"; return; }
    this.surfaceEl.style.display = "block";
    const remaining = ship.stages.slice(ship.activeStage);

    const entry = shipEntryReadout(ship, this.sim.world.t);
    if (entry) {
      this.surfaceReadout.innerHTML =
        kv("Status", `entering ${entry.bodyName} → ${entry.outcome}`) +
        kv("Altitude", `${(entry.altitudeM / 1000).toFixed(1)} km`) +
        kv("Speed", `${(entry.speedMS / 1000).toFixed(2)} km/s`) +
        kv("Decel", `${entry.currentG.toFixed(1)} g (peak ${entry.peakDecelG.toFixed(1)})`) +
        kv("Heat flux", `${(entry.currentHeatFluxW / 1e6).toFixed(2)} MW/m² (peak ${(entry.peakHeatFlux / 1e6).toFixed(1)})`) +
        kv("Wall temp", `${entry.wallTempK.toFixed(0)} K`) +
        kv("Heat load", `${(entry.heatLoad / 1e6).toFixed(0)} MJ/m²`) +
        `<div class="ok">${(entry.progress * 100).toFixed(0)}% through the pass</div>`;
      setDisabled(this.landBtn, true, "Flying an entry pass.");
      setDisabled(this.launchBtn, true, "Flying an entry pass.");
      setDisabled(this.flyEntryBtn, true, "Already flying an entry pass.");
      return;
    }

    if (landed) {
      const altKm = Math.max(0, Number(this.surfaceAltInput.value) || 0);
      const asc = ascentBudget(body, shipSurfaceParams(ship, body, altKm * 1000))!;
      const cost = surfaceManeuverCost(remaining, ship.payloadMass, asc.dvTotal);
      const feasible = cost.feasible >= 0 && asc.converged;
      this.surfaceReadout.innerHTML =
        kv("Status", `landed on ${body.name}`) +
        kv("Ascent Δv", `${(asc.dvTotal / 1000).toFixed(2)} km/s${asc.converged ? "" : " (impractical)"}`) +
        kv("  gravity / drag loss", `${(asc.gravityLoss / 1000).toFixed(2)} / ${(asc.dragLoss / 1000).toFixed(2)} km/s`) +
        kv("Propellant", `${(cost.propellant / 1000).toFixed(1)} t`) +
        (feasible ? `<div class="ok">✓ can reach ${altKm} km orbit</div>` : `<div class="warn">✗ insufficient Δv</div>`);
      setDisabled(this.landBtn, true, `Already landed on ${body.name}.`);
      setDisabled(this.launchBtn, !feasible, "Insufficient Δv to reach the requested orbit.");
      setDisabled(this.flyEntryBtn, true, `Landed on ${body.name}.`);
    } else {
      const orbEl = shipOsculatingElements(ship, this.sim.world.t);
      const alt = Math.max(0, periapsisRadius(orbEl.a, orbEl.e) - body.radius);
      const desc = descentBudget(body, shipSurfaceParams(ship, body, alt))!;
      const cost = surfaceManeuverCost(remaining, ship.payloadMass, desc.dvTotal);
      const canLand = cost.feasible >= 0;
      const canFlyEntry = !!body.atmosphere && periapsisRadius(orbEl.a, orbEl.e) < body.radius + entryInterfaceAlt(body);
      this.surfaceReadout.innerHTML =
        kv("Body", `${body.name} (${body.atmosphere ? "atmosphere" : "airless"})`) +
        kv("Descent Δv", `${(desc.dvTotal / 1000).toFixed(2)} km/s`) +
        (body.atmosphere ? kv("Aerobraking", `${(desc.aerobrakeFraction * 100).toFixed(0)}% shed for free`) : "") +
        (body.atmosphere ? entryHeatRows(body, desc.vOrbit) : "") +
        kv("Land propellant", `${(cost.propellant / 1000).toFixed(1)} t`) +
        (canFlyEntry ? `<div class="ok">orbit dips into the atmosphere — Fly entry to ride it down</div>` : "") +
        (canLand ? `<div class="ok">✓ can land</div>` : `<div class="warn">✗ insufficient Δv to land</div>`);
      setDisabled(this.landBtn, !canLand, "Insufficient Δv to land.");
      setDisabled(this.launchBtn, true, "Land first to enable ascent.");
      setDisabled(this.flyEntryBtn, !canFlyEntry, body.atmosphere ? "Lower periapsis into the atmosphere first." : `${body.name} has no atmosphere.`);
    }
  }

  private doLand(): void { if (this.selectedId) landShip(this.sim, this.selectedId); }
  private doFlyEntry(): void { if (this.selectedId) flyEntry(this.sim, this.selectedId); }
  private doLaunch(): void {
    if (!this.selectedId) return;
    const res = launchShip(this.sim, this.selectedId, Math.max(0, Number(this.surfaceAltInput.value) || 0));
    if (res && res.feasible) this.frameShip(this.selectedId);
  }

  private warpToDeparture(): void {
    if (!this.selectedId) return;
    const tr = this.sim.world.ships.get(this.selectedId)?.transfer;
    if (!tr || tr.departed) return;
    this.sim.jumpToTime(tr.tDepart - 300);
  }

  private doDelete(): void {
    if (!this.selectedId) return;
    const ship = this.sim.world.ships.get(this.selectedId);
    const wasFocused = this.sm.focusId === this.selectedId;
    const fallback = ship && ship.primary !== "sun" ? ship.primary : "earth";
    if (deleteShip(this.sim, this.selectedId) && wasFocused) this.sm.focusBody(fallback);
    this.selectedId = null;
    this.flightEl.style.display = "none";
    this.syncFleet(this.sim.world.t);
  }

  /** Console for a destroyed ship: a CONTACT LOST banner, all detail hidden, and
   *  only Delete live to clear the wreck. */
  private renderLost(ship: Ship): void {
    const where = BODY_BY_ID.get(ship.landed?.bodyId ?? ship.primary)?.name ?? "a body";
    this.nameEl.textContent = ship.name;
    this.banner.set(`CONTACT LOST · impact with ${where}`, "danger");
    this.chipRow.style.display = "none";
    this.orbitViz.set({ kind: "none" }, "");
    this.vitalsEl.style.display = "none";
    for (const sec of [this.navSec, this.propSec, this.thermSec, this.commsSec, this.xferSec, this.opsSec]) sec.root.style.display = "none";
    this.actionsEl.style.display = "none";
    this.warpDepartBtn.style.display = "none";
    setDisabled(this.executeBtn, true, "Ship lost.");
    this.executeBtn.textContent = "Execute burn";
    this.setGuidanceDisabled(true);
    this.burnRow.style.display = "none";
  }

  private doSpiral(): void {
    if (this.selectedId) planSpiral(this.sim, this.selectedId, Math.max(0, Number(this.spiralAltInput.value) || 0));
  }

  /** Show the perturbed-fidelity control for a plain coasting ship: a toggle to fly it
   *  under continuous third-body gravity, plus the dominant third body's current tidal
   *  share of the central pull (a cheap, per-frame readout — the full divergence shows
   *  visually via the Perturbed overlay). */
  private updateFidelity(ship: Ship, t: number): void {
    const body = BODY_BY_ID.get(ship.primary);
    const eligible = !!body && ship.mode === "coast" && !ship.landed && !ship.interstellarLeg
      && !ship.entryLeg && !ship.approachLeg && !ship.spiral && !ship.launchLeg && !ship.descentLeg
      && !(ship.transfer && !ship.transfer.arrived);
    this.fidelityEl.style.display = eligible ? "block" : "none";
    if (!eligible || !body) return;
    const on = ship.fidelity === "perturbed";
    this.fidelityBtn.textContent = on ? "✦ Stop perturbed" : "✦ Fly perturbed";

    const rel = shipRelativeState(ship, t);
    const d = Math.max(length(rel.r), 1);
    const central = body.mu / (d * d);
    const rPrim = bodyState(body, t).r;
    let domName = "—", domRatio = 0;
    for (const p of selectPerturbers(ship.primary, t)) {
      const pb = BODY_BY_ID.get(p.id);
      if (!pb) continue;
      const rB = sub(bodyState(pb, t).r, rPrim);
      const ratio = length(thirdBodyAccel(rel.r, { x: 0, y: 0, z: 0 }, rB, p.mu)) / central;
      if (ratio > domRatio) { domRatio = ratio; domName = pb.name; }
    }
    const dom = domRatio > 0 ? `${domName} · ${domRatio.toExponential(1)} × central` : "negligible";
    this.fidelityReadout.innerHTML =
      kv("Mode", on ? "third-body perturbed (flown)" : "two-body (game)") +
      kv("Dominant 3rd body", dom);
  }

  private doFidelity(): void {
    const id = this.selectedId;
    if (!id) return;
    const ship = this.sim.world.ships.get(id);
    if (!ship) return;
    if (ship.fidelity === "perturbed") this.sim.stopPerturbed(id);
    else this.sim.flyPerturbed(id);
  }
}

// ── ship-specific formatters ─────────────────────────────────────────────────
function entryHeatRows(body: BodyDef, vOrbit: number): string {
  const vehicle: EntryVehicle = { noseRadius: 2, ballisticCoef: DEFAULT_ENTRY_BETA, emissivity: 0.85 };
  const e = entryTrajectory(body, vehicle, { entrySpeed: vOrbit, flightPathAngle: 6 * DEG });
  if (!e) return "";
  return (
    kv("Peak decel", `${e.peakDecelG.toFixed(1)} g`) +
    kv("Peak heat flux", `${(e.peakHeatFlux / 1e6).toFixed(1)} MW/m²`) +
    kv("Wall temp", `${e.peakWallTemp.toFixed(0)} K`) +
    kv("Heat load", `${(e.heatLoad / 1e6).toFixed(0)} MJ/m²`)
  );
}
