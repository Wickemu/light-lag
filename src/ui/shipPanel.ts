/**
 * The ship designer and flight console.
 *
 * Designer: edit a staged stack (dry mass, propellant, Isp, thrust) and watch
 * the Δv budget, masses, and thrust-to-weight update live from the rocket
 * equation. Launch is role-aware: an in-space craft deploys directly into a
 * circular LEO (full propellant); a launch vehicle rolls out to the Earth pad and
 * flies (or expresses) the ascent, expending its boost stages — the designer shows
 * the live ascent budget and the projected orbital survivor, and gates launch on it.
 *
 * Flight: select a ship to see its real osculating orbit (periapsis/apoapsis
 * altitude, period, speed), its remaining mass and Δv, then spend Δv in a chosen
 * direction and watch the orbit reshape as the burn runs.
 */

import { type Simulation } from "../core/sim.ts";
import { type SceneManager } from "../render/SceneManager.ts";
import { type BurnDir, type BurnGoal, type Ship } from "../core/world.ts";
import {
  type ShipDesign,
  defaultDesign,
  spawnShip,
  spawnOnPad,
  expressToOrbit,
  ascentPreview,
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
} from "../core/surface.ts";
import { entryTrajectory, entryInterfaceAlt, type EntryVehicle } from "../core/maneuver/entry.ts";
import {
  type ShipPreset,
  PRESETS_BY_ID,
  presetsByCategory,
  presetToDesign,
} from "../app/shipCatalog.ts";
import { deltaVBudget, initialTWR, stageLiftoffThrust, availablePowerW, thrustAt } from "../core/propulsion.ts";
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
import { summarizeOrbit, periapsisRadius, orbitalPeriod, j2Rates } from "../core/orbit.ts";
import { bodyPosition } from "../core/ephemeris.ts";
import { retardedTime, shiftedWavelength } from "../core/comms.ts";
import { STAR_BY_ID } from "../core/stars.ts";
import { type BodyDef, BODY_BY_ID, AU, DAY, DEG, RAD, JULIAN_YEAR, IR_BAND_WAVELENGTH, j2RefRadius } from "../core/constants.ts";
import { formatDate } from "../core/time.ts";
import { length } from "../core/math/vec3.ts";
import { el, button, kv, setDisabled, numberField, compactField, formatDur } from "./dom.ts";
import { collapsible, type Collapsible } from "./collapsible.ts";
import { markTerm } from "./tooltip.ts";

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

export class ShipPanel {
  private design: ShipDesign = defaultDesign();
  private selectedId: string | null = null;
  private dir: BurnDir = "prograde";
  private guidanceMode: "open" | "closed" = "open";
  private goalType: "periapsis" | "apoapsis" | "circularize" = "periapsis";
  private lastShipCount = -1;

  private panelEl!: HTMLElement;
  private stagesEl!: HTMLElement;
  private budgetEl!: HTMLElement;
  private presetSelect!: HTMLSelectElement;
  private presetCaption!: HTMLElement;
  private nameInput!: HTMLInputElement;
  private payloadInput!: HTMLInputElement;
  private altInput!: HTMLInputElement;
  private inclInput!: HTMLInputElement;
  private fromSurfaceToggle!: HTMLInputElement;
  private launchArea!: HTMLElement;
  private expressBtn: HTMLButtonElement | null = null;
  private shipListEl!: HTMLElement;
  private flightEl!: HTMLElement;
  private readoutEl!: HTMLElement;
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
  private deleteBtn!: HTMLButtonElement;
  private surfaceEl!: HTMLElement;
  private surfaceReadout!: HTMLElement;
  private surfaceAltInput!: HTMLInputElement;
  private landBtn!: HTMLButtonElement;
  private launchBtn!: HTMLButtonElement;
  private flyEntryBtn!: HTMLButtonElement;
  private electricEl!: HTMLElement;
  private spiralAltInput!: HTMLInputElement;
  private spiralBtn!: HTMLButtonElement;
  private dockEl!: HTMLElement;
  private dockReadout!: HTMLElement;
  private dockSelect!: HTMLSelectElement;
  private dockAmountInput!: HTMLInputElement;
  private sendBtn!: HTMLButtonElement;
  private receiveBtn!: HTMLButtonElement;
  private assembleBtn!: HTMLButtonElement;
  /** The currently-chosen dock partner, kept across per-frame refreshes. */
  private dockPartnerId: string | null = null;
  /** Signature of the last candidate set, so the <select> is rebuilt only on change. */
  private lastDockSig = "";
  private designerSection!: Collapsible;
  private fleetSection!: Collapsible;
  /** Collapse the designer once, the first time a ship is selected, to surface
   *  the flight controls — without permanently overriding the user's choice. */
  private autoCollapsedDesigner = false;

  constructor(
    private root: HTMLElement,
    private sim: Simulation,
    private sm: SceneManager,
    private onPlanTransfer?: (shipId: string) => void,
    private onPlanInterstellar?: (shipId: string) => void,
  ) {
    this.build();
  }

  toggle(): void {
    this.panelEl.style.display = this.isOpen() ? "none" : "flex";
  }

  isOpen(): boolean {
    return this.panelEl.style.display !== "none";
  }

  private build(): void {
    const panel = el("div", "panel ship-panel");
    this.panelEl = panel;

    // Title row with a ✕ close button (mirrors the planners' Close affordance).
    const head = el("div", "panel-head");
    head.appendChild(el("div", "panel-title", "MISSION"));
    const close = button("✕", () => this.toggle());
    close.className = "panel-close";
    close.title = "Close (F or Esc)";
    head.appendChild(close);
    panel.appendChild(head);

    // ── Designer section ──────────────────────────────────────────────────────
    this.designerSection = collapsible("Designer", { id: "designer", open: true });
    const dsn = this.designerSection.body;
    panel.appendChild(this.designerSection.root);

    // Preset fleet picker — load a real or inferred design, then tweak freely.
    this.presetSelect = this.buildPresetSelect();
    dsn.appendChild(this.presetSelect);
    this.presetCaption = el("div", "preset-caption");
    dsn.appendChild(this.presetCaption);

    // Editable name (mirrors the loaded preset; the launched ship takes it).
    const nameField = el("label", "field name-field");
    nameField.appendChild(el("span", "field-label", "Name"));
    this.nameInput = document.createElement("input");
    this.nameInput.type = "text";
    this.nameInput.value = this.design.name;
    this.nameInput.oninput = () => { this.design.name = this.nameInput.value; };
    nameField.appendChild(this.nameInput);
    dsn.appendChild(nameField);

    this.stagesEl = el("div", "stages");
    dsn.appendChild(this.stagesEl);
    const addBtn = button("+ add stage", () => {
      this.design.stages.push({ name: `Stage ${this.design.stages.length + 1}`, dryMass: 1000, propMass: 8000, isp: 320, thrust: 1e5 });
      this.markCustom();
      this.renderStages();
      this.refreshBudget();
    });
    addBtn.className = "wide-btn";
    addBtn.title = "Add another stage to the stack.";
    dsn.appendChild(addBtn);

    const params = el("div", "design-params");
    this.payloadInput = numberField(params, "Payload (t)", this.design.payloadMass / 1000, (v) => {
      this.design.payloadMass = v * 1000;
      this.markCustom();
      this.refreshBudget();
    });
    this.altInput = numberField(params, "LEO alt (km)", this.design.altitudeKm, (v) => {
      this.design.altitudeKm = v;
      this.markCustom();
      this.refreshBudget();
    });
    // Inclination doubles as the launch-pad LATITUDE for a launch vehicle (the minimum
    // inclination a pad can reach is its latitude), so it drives both the parking-orbit
    // plane and where a from-surface ship lifts off.
    this.inclInput = numberField(params, "Incl / pad lat (°)", this.design.inclinationDeg, (v) => {
      this.design.inclinationDeg = Math.max(0, Math.min(90, v));
      this.markCustom();
      this.refreshBudget();
    });
    dsn.appendChild(params);

    // Start-on-pad toggle: a LAUNCH VEHICLE starts on the Earth pad and flies the ascent
    // (its boost stages are expended in the climb); an IN-SPACE craft deploys directly in
    // LEO. Set automatically when a preset is loaded; the player can override for a custom
    // design. Default off (the legacy in-orbit deploy, and what every default/custom ship is).
    const padRow = el("label", "field pad-field");
    this.fromSurfaceToggle = document.createElement("input");
    this.fromSurfaceToggle.type = "checkbox";
    this.fromSurfaceToggle.checked = !!this.design.fromSurface;
    this.fromSurfaceToggle.onchange = () => {
      this.design.fromSurface = this.fromSurfaceToggle.checked;
      this.markCustom();
      this.renderLaunchArea();
      this.refreshBudget();
    };
    padRow.append(this.fromSurfaceToggle, el("span", "field-label", "Launch vehicle (starts on the pad, flies the ascent)"));
    padRow.title = "On: a launch vehicle — fly the ascent to LEO, expending its boost stages. Off: an in-space craft deployed directly in LEO with full propellant.";
    dsn.appendChild(padRow);

    this.budgetEl = el("div", "budget");
    dsn.appendChild(this.budgetEl);

    // Role-aware launch controls (rebuilt by renderLaunchArea on toggle / preset load).
    this.launchArea = el("div", "launch-area");
    dsn.appendChild(this.launchArea);
    this.renderLaunchArea();

    // ── Fleet section (launched ships) ────────────────────────────────────────
    this.fleetSection = collapsible("Fleet", { id: "fleet", open: true });
    this.shipListEl = el("div", "ship-list");
    this.fleetSection.body.appendChild(this.shipListEl);
    panel.appendChild(this.fleetSection.root);

    // ── Flight + Maneuver sections (only shown once a ship is selected) ────────
    this.flightEl = el("div", "flight");

    const flightSection = collapsible("Flight", { id: "flight", open: true });
    const flt = flightSection.body;
    this.readoutEl = el("div", "flight-readout");
    flt.appendChild(this.readoutEl);

    this.planBtn = button("Plan transfer ▸", () => {
      if (this.selectedId && this.onPlanTransfer) this.onPlanTransfer(this.selectedId);
    });
    this.planBtn.className = "wide-btn";
    flt.appendChild(this.planBtn);

    this.interstellarBtn = button("Interstellar ▸", () => {
      if (this.selectedId && this.onPlanInterstellar) this.onPlanInterstellar(this.selectedId);
    });
    this.interstellarBtn.className = "wide-btn";
    flt.appendChild(this.interstellarBtn);

    // Skip the wait to a delayed departure: jump the clock to just before it.
    this.warpDepartBtn = button("⏩ Warp to departure", () => this.warpToDeparture());
    this.warpDepartBtn.className = "wide-btn";
    this.warpDepartBtn.style.display = "none";
    flt.appendChild(this.warpDepartBtn);

    // Surface ops — landing & takeoff Δv budgeting (shown only when the ship is
    // coasting in the SOI of a body with a surface, or already landed).
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
    flt.appendChild(this.surfaceEl);

    // Electric drive — commit a low-thrust spiral to a target orbit (shown only
    // when the active stage is electric and the ship is coasting about a body).
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
    flt.appendChild(this.electricEl);

    // Dock / transfer — propellant transfer and in-orbit assembly between two
    // docked craft (shown only when another free-coasting ship is at rendezvous in
    // the same SOI). The receiver's m₀ — and so its Δv — rises by exactly what the
    // donor gives; assembly stacks two vehicles into one.
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
    flt.appendChild(this.dockEl);

    this.flightEl.appendChild(flightSection.root);

    // Maneuver section — burn direction + Δv.
    const maneuverSection = collapsible("Maneuver", { id: "maneuver", open: true });
    const mnv = maneuverSection.body;
    this.dirRow = el("div", "dir-row");
    for (const d of DIRS) {
      const b = button(DIR_LABEL[d], () => {
        this.dir = d;
        this.syncDirButtons();
      });
      b.className = "dir-btn";
      b.dataset.dir = d;
      markTerm(b, DIR_LABEL[d], { decorate: false });
      this.dirRow.appendChild(b);
    }
    mnv.appendChild(this.dirRow);

    // Guidance: open-loop fires the exact Δv below; closed-loop carries a goal and
    // the ship trims its Δv at delivery to hit it (the autonomous counter-pole to
    // the light-lag bargain). Reuses the .dir-row/.dir-btn segmented idiom.
    this.guidanceRow = el("div", "dir-row");
    const GUIDANCE: { mode: "open" | "closed"; label: string }[] = [
      { mode: "open", label: "Open-loop" },
      { mode: "closed", label: "Closed-loop" },
    ];
    for (const g of GUIDANCE) {
      const b = button(g.label, () => {
        this.guidanceMode = g.mode;
        this.syncGuidanceButtons();
      });
      b.className = "dir-btn";
      b.dataset.mode = g.mode;
      markTerm(b, g.label, { decorate: false });
      this.guidanceRow.appendChild(b);
    }
    mnv.appendChild(this.guidanceRow);

    // Goal sub-row (closed-loop only): target apsis + altitude.
    this.goalRow = el("div", "goal-row");
    this.goalTypeRow = el("div", "dir-row");
    const GOALS: { key: "periapsis" | "apoapsis" | "circularize"; label: string }[] = [
      { key: "periapsis", label: "Periapsis" },
      { key: "apoapsis", label: "Apoapsis" },
      { key: "circularize", label: "Circularize" },
    ];
    for (const g of GOALS) {
      const b = button(g.label, () => {
        this.goalType = g.key;
        this.syncGuidanceButtons();
      });
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

    // Scrap/abandon the selected ship (removes it from the sim entirely).
    this.deleteBtn = button("🗑 Delete ship", () => this.doDelete());
    this.deleteBtn.className = "wide-btn danger";
    this.deleteBtn.title = "Remove this ship from the simulation. Cannot be undone.";
    this.flightEl.appendChild(this.deleteBtn);

    panel.appendChild(this.flightEl);

    this.root.appendChild(panel);

    this.renderStages();
    this.refreshBudget();
    this.syncDirButtons();
    this.syncGuidanceButtons();
    this.flightEl.style.display = "none";
  }

  private renderStages(): void {
    this.stagesEl.innerHTML = "";
    this.design.stages.forEach((s, i) => {
      const block = el("div", "stage-block");
      const row = el("div", "stage-row");
      row.appendChild(el("span", "stage-name", `${i + 1}`));
      compactField(row, "dry t", s.dryMass / 1000, (v) => { s.dryMass = v * 1000; this.markCustom(); this.refreshBudget(); });
      compactField(row, "prop t", s.propMass / 1000, (v) => { s.propMass = v * 1000; this.markCustom(); this.refreshBudget(); });
      // Isp and thrust must stay positive — vₑ = 0 / thrust = 0 would divide by zero.
      compactField(row, "Isp s", s.isp, (v) => { s.isp = Math.max(v, 1); this.markCustom(); this.refreshBudget(); });
      compactField(row, "kN", s.thrust / 1000, (v) => { s.thrust = Math.max(v * 1000, 1); this.markCustom(); this.refreshBudget(); });
      if (this.design.stages.length > 1) {
        const rm = button("✕", () => {
          this.design.stages.splice(i, 1);
          this.markCustom();
          this.renderStages();
          this.refreshBudget();
        });
        rm.className = "rm-btn";
        row.appendChild(rm);
      }
      block.appendChild(row);

      // Strap-on boosters: ignite WITH this stage and burn in parallel (×N units
      // that drop together when spent). The core keeps firing after they drop.
      (s.boosters ?? []).forEach((bst, j) => {
        const brow = el("div", "stage-row booster-row");
        brow.appendChild(el("span", "stage-name", "↳"));
        compactField(brow, "×N", bst.count ?? 1, (v) => { bst.count = Math.max(1, Math.round(v)); this.markCustom(); this.refreshBudget(); });
        compactField(brow, "dry t", bst.dryMass / 1000, (v) => { bst.dryMass = v * 1000; this.markCustom(); this.refreshBudget(); });
        compactField(brow, "prop t", bst.propMass / 1000, (v) => { bst.propMass = v * 1000; this.markCustom(); this.refreshBudget(); });
        compactField(brow, "Isp s", bst.isp, (v) => { bst.isp = Math.max(v, 1); this.markCustom(); this.refreshBudget(); });
        compactField(brow, "kN", bst.thrust / 1000, (v) => { bst.thrust = Math.max(v * 1000, 1); this.markCustom(); this.refreshBudget(); });
        const rm = button("✕", () => {
          s.boosters!.splice(j, 1);
          if (s.boosters!.length === 0) delete s.boosters;
          this.markCustom();
          this.renderStages();
          this.refreshBudget();
        });
        rm.className = "rm-btn";
        brow.appendChild(rm);
        block.appendChild(brow);
      });

      const addB = button("+ booster", () => {
        (s.boosters ??= []).push({ name: "Booster", dryMass: 2000, propMass: 20000, isp: 280, thrust: 5e5, count: 2 });
        this.markCustom();
        this.renderStages();
        this.refreshBudget();
      });
      addB.className = "add-booster";
      // Electric (power-limited) stages can't carry chemical strap-ons honestly:
      // the budget would use rated thrust while the sim derates it, so disallow it.
      if (s.electric) {
        setDisabled(addB, true, "Electric stages can't carry strap-on boosters.");
      } else {
        addB.title = "Add strap-on boosters that ignite with this stage and burn in parallel.";
      }
      block.appendChild(addB);

      this.stagesEl.appendChild(block);
    });
  }

  private refreshBudget(): void {
    const b = deltaVBudget(this.design.stages, this.design.payloadMass);
    const twr = initialTWR(this.design.stages, this.design.payloadMass);
    const perStage = b.perStage.map((d, i) => `S${i + 1}: ${(d / 1000).toFixed(2)}`).join("  ");
    const first = this.design.stages[0];
    const hasBoosters = !!(first && first.boosters && first.boosters.length > 0);
    let html =
      kv("Total Δv", `${(b.total / 1000).toFixed(2)} km/s`) +
      kv("Wet / final mass", `${(b.wetMass / 1000).toFixed(1)} / ${(b.finalMass / 1000).toFixed(1)} t`) +
      kv("Initial T/W", twr.toFixed(2) + (twr < 1 ? " (low thrust)" : "")) +
      (hasBoosters ? kv("Liftoff thrust", `${(stageLiftoffThrust(first!) / 1000).toFixed(0)} kN (core + boosters)`) : "") +
      `<div class="per-stage">${perStage} km/s</div>`;

    // Launch vehicle: show the honest Earth→LEO ascent budget and what survives into
    // orbit once the boost stages are expended (and gate the express button on it).
    if (this.design.fromSurface) {
      const pv = ascentPreview(this.design);
      if (pv) {
        html += kv("Ascent to LEO", `${(pv.ascentDv / 1000).toFixed(2)} km/s`);
        html += pv.reachesOrbit
          ? `<div class="ok">✓ reaches LEO — survivor ${(pv.survivorMass / 1000).toFixed(1)} t, ${(pv.survivorDv / 1000).toFixed(2)} km/s in orbit</div>`
          : `<div class="warn">✗ ${((pv.ascentDv - pv.stackDv) / 1000).toFixed(2)} km/s short of LEO — trim payload or lower the target orbit</div>`;
      }
      if (this.expressBtn) setDisabled(this.expressBtn, !pv?.reachesOrbit, "This design can't reach LEO — trim payload or lower the target orbit.");
    }
    this.budgetEl.innerHTML = html;
  }

  /** A category-grouped <select> over the whole preset fleet. */
  private buildPresetSelect(): HTMLSelectElement {
    const sel = document.createElement("select");
    sel.className = "preset-sel";
    const custom = document.createElement("option");
    custom.value = "";
    custom.textContent = "— Custom / from scratch —";
    sel.appendChild(custom);
    for (const group of presetsByCategory()) {
      const og = document.createElement("optgroup");
      og.label = group.category;
      for (const p of group.presets) {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        og.appendChild(opt);
      }
      sel.appendChild(og);
    }
    sel.onchange = () => {
      if (sel.value) this.loadPreset(sel.value);
      else this.clearCaption();
    };
    return sel;
  }

  /** Load a preset into the live (editable) design and re-sync the controls. */
  private loadPreset(id: string): void {
    const preset = PRESETS_BY_ID.get(id);
    if (!preset) return;
    this.design = presetToDesign(preset);
    this.nameInput.value = this.design.name;
    this.payloadInput.value = String(this.design.payloadMass / 1000);
    this.altInput.value = String(this.design.altitudeKm);
    this.inclInput.value = String(this.design.inclinationDeg);
    this.fromSurfaceToggle.checked = !!this.design.fromSurface;
    this.renderStages();
    this.renderLaunchArea();
    this.refreshBudget();
    this.showCaption(preset);
  }

  private showCaption(p: ShipPreset): void {
    const role = p.role === "launcher" ? "launch vehicle" : "in-space craft";
    this.presetCaption.innerHTML =
      `<span class="preset-meta">${p.category} · ${p.era} · ${role}</span>` +
      `<span class="preset-blurb">${p.blurb}</span>`;
  }

  private clearCaption(): void {
    this.presetCaption.innerHTML = "";
  }

  /** Any manual edit drops the "this is preset X" framing — it's now bespoke. */
  private markCustom(): void {
    if (this.presetSelect.value !== "") {
      this.presetSelect.value = "";
      this.clearCaption();
    }
  }

  private launch(): void {
    const id = spawnShip(this.sim, this.design);
    this.select(id);
  }

  /** Rebuild the launch controls for the design's role: a launch vehicle rolls out to
   *  the pad (then flies the ascent) or expresses straight to LEO; an in-space craft
   *  deploys directly in LEO. */
  private renderLaunchArea(): void {
    this.launchArea.innerHTML = "";
    this.expressBtn = null;
    if (this.design.fromSurface) {
      const pad = button("🚀 Roll out to pad", () => this.rollOut());
      pad.className = "wide-btn";
      pad.title = "Stand this launch vehicle on the Earth pad. Fly the ascent (⬆ Launch in the flight console) — the boost stages are expended and only the survivor reaches LEO.";
      const express = button("⏩ Express to LEO", () => this.express());
      express.className = "wide-btn primary";
      express.title = "Resolve the ascent instantly: expend the boost stages and seat the surviving stack in a LEO parking orbit.";
      this.expressBtn = express;
      this.launchArea.append(pad, express);
    } else {
      const deploy = button("▶ Deploy in LEO", () => this.launch());
      deploy.className = "wide-btn primary";
      deploy.title = "Place this in-space craft directly in a circular low orbit, fully fuelled.";
      this.launchArea.append(deploy);
    }
  }

  /** Stand a launch vehicle on the Earth pad (fly the ascent from the flight console). */
  private rollOut(): void {
    this.select(spawnOnPad(this.sim, this.design));
  }

  /** Resolve the ascent instantly and seat the survivor in LEO. The express button is
   *  gated off when the design can't reach orbit; if a stale click still slips through,
   *  refresh the budget so the "✗ short of LEO" readout is shown rather than failing silently. */
  private express(): void {
    const { id } = expressToOrbit(this.sim, this.design);
    if (id) this.select(id);
    else this.refreshBudget();
  }

  private select(id: string): void {
    this.selectedId = id;
    if (this.sim.world.ships.get(id)) this.frameShip(id);
    this.flightEl.style.display = "block";
    // First time a ship is selected this session, fold the designer to surface
    // the flight controls — a convenience nudge, not a persisted override.
    if (!this.autoCollapsedDesigner) {
      this.autoCollapsedDesigner = true;
      this.designerSection.setOpen(false);
    }
    this.refreshShipList();
  }

  /** Centre the camera on a ship — but, when chasing it would strobe (a short, fast
   *  orbit at high warp), frame its PARENT body instead so you watch it circle. This
   *  is the fix for the LEO-launch strobe: at 1 day/s a ship laps Earth ~16×/s. */
  private frameShip(id: string): void {
    const ship = this.sim.world.ships.get(id);
    if (!ship) return;
    if (this.shouldFrameParent(ship)) {
      this.sm.focusBody(ship.primary);
      return;
    }
    // Frame from the orbit's apoapsis — but a ship on a powered ascent/descent leg has a
    // DEGENERATE osculating conic at the arc endpoints (zero-speed liftoff/touchdown ⇒ a→∞),
    // which would hand the camera a non-finite framing distance and black out the whole view.
    // Fall back to a body-scaled distance whenever the apoapsis isn't a finite, positive length.
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

  /** True when directly framing the ship would strobe: a bound, short-period orbit
   *  about a body at a warp where many revolutions elapse per real second. */
  private shouldFrameParent(ship: Ship): boolean {
    if (ship.primary === "sun" || ship.interstellarLeg || ship.landed || ship.mode === "thrust") return false;
    if (!BODY_BY_ID.get(ship.primary)) return false;
    const el = shipOsculatingElements(ship, this.sim.world.t);
    if (el.e >= 1 || el.a <= 0) return false; // unbound — not a tight fast loop
    const period = orbitalPeriod(el.a, primaryMu(ship));
    // Revolutions swept per real second at the current warp; past ~¼ rev/s the chase strobes.
    return period > 0 && this.sim.warp / period > 0.25;
  }

  private execute(): void {
    if (!this.selectedId) return;
    const dv = parseFloat(this.dvInput.value);
    if (!isFinite(dv) || dv <= 0) return;
    // Open-loop: dv is the exact Δv. Closed-loop: dv is the correction CAP and the
    // command carries a goal the ship trims to at delivery.
    // The order is transmitted, not applied: it reaches the ship at light-lag.
    sendBurn(this.sim, this.selectedId, dv, this.dir, this.buildGoal());
  }

  /** The closed-loop goal for the current selection, or undefined for open-loop. */
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
    // Circularize needs no altitude — it circularizes at the delivery radius.
    const altField = this.goalAltInput.parentElement as HTMLElement | null;
    if (altField) altField.style.display = this.goalType === "circularize" ? "none" : "";
    if (closed) {
      const what =
        this.goalType === "circularize"
          ? "circularize at the delivery radius"
          : `reach the target ${this.goalType}`;
      this.guidanceHint.textContent =
        `The ship trims its Δv (≤ the value below, its correction budget) to ${what} at delivery — or NACKs if it can't.`;
    }
  }

  /** Lock the guidance controls (e.g. while a burn is running or the ship is lost). */
  private setGuidanceDisabled(disabled: boolean): void {
    const btns = [
      ...Array.from(this.guidanceRow.children),
      ...Array.from(this.goalTypeRow.children),
    ] as HTMLButtonElement[];
    for (const b of btns) setDisabled(b, disabled);
    this.goalAltInput.disabled = disabled;
  }

  private refreshShipList(): void {
    this.shipListEl.innerHTML = "";
    const count = this.sim.world.ships.size;
    this.fleetSection.badge.textContent = count ? String(count) : "";
    if (count === 0) {
      this.shipListEl.appendChild(el("div", "ship-empty", "No ships yet — launch one above."));
    }
    for (const ship of this.sim.world.ships.values()) {
      const b = button(ship.name, () => this.select(ship.id));
      b.className = "ship-btn" + (ship.id === this.selectedId ? " active" : "");
      this.shipListEl.appendChild(b);
    }
    this.lastShipCount = this.sim.world.ships.size;
  }

  /** Per-frame readout refresh. */
  update(t: number): void {
    if (this.sim.world.ships.size !== this.lastShipCount) this.refreshShipList();
    if (!this.selectedId) return;
    const ship = this.sim.world.ships.get(this.selectedId);
    if (!ship) {
      this.selectedId = null;
      this.flightEl.style.display = "none";
      return;
    }
    // A destroyed ship has no live orbit to read — show the loss and offer only deletion.
    if (ship.status === "lost") {
      this.renderLost(ship);
      return;
    }

    // Light-lag: what you KNOW is the ship's retarded state — its state at the
    // instant whose light is only now reaching the control node.
    const controlPos = bodyPosition(this.sim.world.controlNode, t);
    const tKnown = retardedTime(controlPos, (tt) => shipWorldState(ship, tt).r, t);
    const age = t - tKnown; // one-way light delay

    const mu = primaryMu(ship);
    const primary = BODY_BY_ID.get(ship.primary)!;
    const el = shipOsculatingElements(ship, tKnown);
    const rel = shipRelativeState(ship, tKnown);
    const speed = length(rel.v);

    const lines: string[] = [];
    lines.push(kv("Signal delay (1-way)", fmtDelay(age)));
    const dop = shipTelemetryDoppler(ship, this.sim.world.controlNode, t);
    if (dop) lines.push(kv("Telemetry Doppler", fmtDoppler(dop)));
    if (ship.primary === "sun") {
      // Heliocentric (in/after a transfer): show distance from the Sun, not an
      // altitude above the Sun's surface.
      lines.push(kv("Frame", "heliocentric"));
      lines.push(kv("Distance from Sun", `${(length(rel.r) / AU).toFixed(3)} AU`));
    } else {
      const sum = summarizeOrbit(el, mu, primary.radius);
      lines.push(kv("Orbiting", primary.name));
      lines.push(kv("Periapsis alt", `${(sum.periapsisAlt / 1000).toFixed(0)} km`));
      lines.push(kv("Apoapsis alt", sum.bound ? `${(sum.apoapsisAlt / 1000).toFixed(0)} km` : "escape"));
      lines.push(kv("Period", sum.bound ? formatDur(sum.period) : "—"));
      // J2 oblateness precession (the plane and apsides slowly rotate).
      if (sum.bound && primary.J2) {
        const r = j2Rates(mu, j2RefRadius(primary), primary.J2, el.a, el.e, el.i);
        lines.push(kv("Node precession", `${(r.nodeDot * RAD * DAY).toFixed(3)}°/day`));
        lines.push(kv("Apsidal precession", `${(r.periDot * RAD * DAY).toFixed(3)}°/day`));
      }
    }
    lines.push(kv("Speed", `${(speed / 1000).toFixed(3)} km/s`));
    lines.push(kv("Mass", `${(totalMass(ship) / 1000).toFixed(2)} t`));
    lines.push(kv("Δv remaining", `${(dvRemaining(ship) / 1000).toFixed(2)} km/s`));

    // Electric drive: power-limited thrust falls with solar distance; a transfer
    // is a long Edelbaum spiral, not an impulsive burn.
    const stage = activeStage(ship);
    if (stage?.electric) {
      const rHelio = length(shipWorldState(ship, tKnown).r);
      const power = availablePowerW(stage.electric, rHelio);
      const thr = thrustAt(stage, rHelio);
      const accel = thr / totalMass(ship);
      lines.push(kv("Drive power", `${(power / 1000).toFixed(2)} kW${stage.electric.solar ? ` @ ${(rHelio / AU).toFixed(2)} AU` : " (reactor)"}`));
      lines.push(kv("Drive thrust", `${(thr * 1000).toFixed(1)} mN · a = ${(accel * 1e6).toFixed(2)} mm/s²`));
    }
    if (ship.spiral) {
      const left = (ship.spiral.tEnd - t) / DAY;
      lines.push(kv("Spiraling", `to ${((ship.spiral.endRadius - BODY_BY_ID.get(ship.primary)!.radius) / 1000).toFixed(0)} km · ${left.toFixed(0)} d left`));
    }
    // Show/enable the spiral control only when a spiral can be started here.
    const canSpiral = !!stage?.electric && ship.mode === "coast" && ship.primary !== "sun"
      && !ship.landed && !ship.interstellarLeg && !ship.spiral;
    this.electricEl.style.display = canSpiral ? "block" : "none";
    setDisabled(this.spiralBtn, !canSpiral,
      "Available only with an electric drive while coasting in orbit around a body.");

    // A command you've sent is still crawling out to the ship at c.
    const inbound = this.sim.world.messages.find(
      (m) => m.kind === "command" && m.targetId === ship.id && m.tArrive > t,
    );
    if (inbound) lines.push(kv("Order en route", `arrives in ${fmtDelay(inbound.tArrive - t)}`));

    // Transfer status.
    const tr = ship.transfer;
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
    }
    // "Warp to departure": only meaningful for a planned, not-yet-departed transfer.
    const planned = !!tr && !tr.departed;
    this.warpDepartBtn.style.display = planned ? "block" : "none";
    if (planned) {
      setDisabled(this.warpDepartBtn, this.sim.anyThrust(), "Can't skip time while a burn is running.");
      this.warpDepartBtn.textContent = `⏩ Warp to ${formatDate(tr!.tDepart)}`;
    }
    // Interstellar leg status.
    const leg = ship.interstellarLeg;
    if (leg) {
      const starName = STAR_BY_ID.get(leg.targetStar)?.name ?? leg.targetStar;
      const arrived = t >= leg.tArrive;
      lines.push(kv("Interstellar", arrived
        ? `arrived at ${starName}`
        : `→ ${starName} · ${((leg.tArrive - t) / JULIAN_YEAR).toFixed(2)} yr left (Earth frame)`));
      lines.push(kv("Crew clock (τ)", `${(ship.tau / JULIAN_YEAR).toFixed(2)} yr elapsed`));
    }

    // A transfer can only be planned from a planet (not mid-flight or interstellar).
    setDisabled(this.planBtn, ship.primary === "sun" || !!leg || !!ship.landed || (!!tr && tr.departed),
      ship.landed ? "Launch to a parking orbit first." : "Plan a transfer only from a parking orbit around a body (not mid-transfer or interstellar).");
    setDisabled(this.interstellarBtn, !!leg || !!ship.landed, ship.landed ? "Launch to a parking orbit first." : "Already on an interstellar leg.");

    // Thermal & detection — there is no stealth in space.
    const th = shipThermalState(ship, t);
    lines.push(kv("Solar flux", `${th.solarFlux.toFixed(0)} W/m² @ ${(th.distanceFromSun / AU).toFixed(2)} AU`));
    lines.push(kv("Hull temp", `${th.hullTempK.toFixed(0)} K`));
    lines.push(kv("IR signature", fmtPower(th.signatureW) + (th.thrusting ? " — drive HOT" : "")));
    lines.push(kv("Detectable to", `${fmtRange(th.detectionRangeM)} (${th.snrThreshold}σ, τ=${(th.integrationTimeS / 3600).toFixed(0)}h)`));
    lines.push(kv("Min signal", `${(th.minDetectablePowerW * 1e18).toFixed(1)} aW`));
    if (th.thrusting) {
      lines.push(kv("Drive waste heat", fmtPower(th.driveWasteW)));
      lines.push(kv("Radiator needed", `${Math.round(th.radiatorAreaM2).toLocaleString("en-US")} m²`));
    }

    if (ship.landed) lines.unshift(kv("Surface", `landed on ${BODY_BY_ID.get(ship.landed.bodyId)?.name ?? ship.landed.bodyId}`));

    if (ship.mode === "thrust" && ship.burn) {
      const pct = (100 * ship.burn.dvDone) / ship.burn.dvTarget;
      lines.push(kv("BURNING", `${ship.burn.dvDone.toFixed(0)} / ${ship.burn.dvTarget.toFixed(0)} m/s (${pct.toFixed(0)}%)`));
      setDisabled(this.executeBtn, true, "Burn in progress.");
      this.executeBtn.textContent = "Burning…";
      this.setGuidanceDisabled(true);
    } else {
      setDisabled(this.executeBtn, false);
      this.executeBtn.textContent = "Execute burn";
      this.setGuidanceDisabled(false);
    }

    this.updateSurfaceOps(ship);
    this.updateDocking(ship);
    this.readoutEl.innerHTML = lines.join("");
  }

  /** Propellant-transfer / assembly controls for the selected ship, shown only when
   *  another free-coasting ship is docked with it (same SOI, at rendezvous). Donor →
   *  receiver raises the receiver's m₀ → Δv; Assemble merges the partner into this ship. */
  private updateDocking(ship: Ship): void {
    const candidates = dockCandidates(this.sim, ship.id);
    if (candidates.length === 0) {
      this.dockEl.style.display = "none";
      this.dockPartnerId = null;
      this.lastDockSig = "";
      return;
    }
    this.dockEl.style.display = "block";

    // Rebuild the partner <select> only when the candidate set actually changes, so
    // a per-frame refresh doesn't fight the user's selection.
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

    // Receive needs propellant on the partner and room on this ship; Send is the reverse.
    setDisabled(this.receiveBtn, !(them.available > 1 && me.headroom > 1),
      "Partner has no propellant to give, or this ship's tanks are full.");
    setDisabled(this.sendBtn, !(me.available > 1 && them.headroom > 1),
      "This ship has no propellant to give, or the partner's tanks are full.");
  }

  /** Transfer propellant between the selected ship and its dock partner. The amount
   *  field is tonnes; blank ⇒ fill the receiver as much as the pair allows. */
  private doTransfer(dir: "send" | "receive"): void {
    if (!this.selectedId || !this.dockPartnerId) return;
    const raw = this.dockAmountInput.value.trim();
    const amountKg = raw === "" ? undefined : Math.max(0, Number(raw) * 1000) || undefined;
    const [from, to] = dir === "send"
      ? [this.selectedId, this.dockPartnerId]
      : [this.dockPartnerId, this.selectedId];
    transferPropellant(this.sim, from, to, amountKg);
  }

  /** Assemble (dock-merge) the dock partner into the selected ship — the partner is
   *  consumed. In-orbit construction; the merged vehicle keeps this ship's identity. */
  private doAssemble(): void {
    if (!this.selectedId || !this.dockPartnerId) return;
    const partnerId = this.dockPartnerId;
    const wasFocused = this.sm.focusId === partnerId;
    if (assembleShips(this.sim, this.selectedId, partnerId)) {
      this.dockPartnerId = null;
      this.lastDockSig = "";
      if (wasFocused) this.frameShip(this.selectedId);
      this.refreshShipList();
    }
  }

  /** Landing/takeoff Δv budget for the selected ship, shown only when it is
   *  coasting in the SOI of a body with a surface (or already landed there). */
  private updateSurfaceOps(ship: Ship): void {
    const landed = ship.landed;
    const body = landed ? BODY_BY_ID.get(landed.bodyId) : BODY_BY_ID.get(ship.primary);
    const inTransfer = !!ship.transfer && ship.transfer.departed && !ship.transfer.arrived;
    const showable =
      !!body && body.hasSurface !== false && ship.primary !== "sun" && ship.mode === "coast" && !inTransfer;
    if (!showable || !body) {
      this.surfaceEl.style.display = "none";
      return;
    }
    this.surfaceEl.style.display = "block";
    const remaining = ship.stages.slice(ship.activeStage);

    // Flying an in-sim entry pass: show the live heat/decel readout, hide actions.
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
      // The orbit can be flown into the atmosphere when its periapsis dips below the
      // entry interface (and the body has one).
      const canFlyEntry =
        !!body.atmosphere && periapsisRadius(orbEl.a, orbEl.e) < body.radius + entryInterfaceAlt(body);
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
      setDisabled(
        this.flyEntryBtn,
        !canFlyEntry,
        body.atmosphere ? "Lower periapsis into the atmosphere first." : `${body.name} has no atmosphere.`,
      );
    }
  }

  private doLand(): void {
    if (this.selectedId) landShip(this.sim, this.selectedId);
  }

  /** Fly the current orbit into the atmosphere in-sim (ballistic drag pass) instead
   *  of teleporting down with the budgeted descent. */
  private doFlyEntry(): void {
    if (this.selectedId) flyEntry(this.sim, this.selectedId);
  }

  private doLaunch(): void {
    if (!this.selectedId) return;
    const res = launchShip(this.sim, this.selectedId, Math.max(0, Number(this.surfaceAltInput.value) || 0));
    // Re-frame after reaching orbit: at high warp this lands on the parent body so the
    // fresh LEO ship is watched circling it, not chased into a strobe.
    if (res && res.feasible) this.frameShip(this.selectedId);
  }

  /** Jump the clock to just before this ship's (delayed) transfer departure. */
  private warpToDeparture(): void {
    if (!this.selectedId) return;
    const tr = this.sim.world.ships.get(this.selectedId)?.transfer;
    if (!tr || tr.departed) return;
    this.sim.jumpToTime(tr.tDepart - 300); // stop ~5 min out, so the injection is watchable
  }

  /** Remove the selected ship from the sim and redirect focus if it was watched. */
  private doDelete(): void {
    if (!this.selectedId) return;
    const ship = this.sim.world.ships.get(this.selectedId);
    const wasFocused = this.sm.focusId === this.selectedId;
    const fallback = ship && ship.primary !== "sun" ? ship.primary : "earth";
    if (deleteShip(this.sim, this.selectedId) && wasFocused) this.sm.focusBody(fallback);
    this.selectedId = null;
    this.flightEl.style.display = "none";
    this.refreshShipList();
  }

  /** Flight console for a destroyed ship: a CONTACT LOST banner, every action
   *  disabled, and only the Delete button live to clear the wreck. */
  private renderLost(ship: Ship): void {
    const where = BODY_BY_ID.get(ship.landed?.bodyId ?? ship.primary)?.name ?? "a body";
    this.readoutEl.innerHTML =
      kv("Status", "CONTACT LOST") +
      `<div class="warn">✗ ${ship.name} was destroyed — impact with ${where}.</div>`;
    this.surfaceEl.style.display = "none";
    this.electricEl.style.display = "none";
    this.dockEl.style.display = "none";
    this.warpDepartBtn.style.display = "none";
    setDisabled(this.planBtn, true, "Ship lost.");
    setDisabled(this.interstellarBtn, true, "Ship lost.");
    setDisabled(this.executeBtn, true, "Ship lost.");
    this.executeBtn.textContent = "Execute burn";
    this.setGuidanceDisabled(true);
  }

  /** Commit a low-thrust Edelbaum spiral from the current circular orbit to the
   *  requested altitude — charged up front, then flown as an analytic leg. */
  private doSpiral(): void {
    if (this.selectedId) planSpiral(this.sim, this.selectedId, Math.max(0, Number(this.spiralAltInput.value) || 0));
  }
}

// ── ship-specific formatters ─────────────────────────────────────────────────
/** Light-delay readout: live for the local case, then seconds → minutes → hours. */
function fmtDelay(s: number): string {
  if (s < 1) return "live";
  if (s < 90) return `${s.toFixed(0)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(2)} hr`;
}

/** The telemetry Doppler shift: redshift z (scientific for the tiny in-system
 *  values, decimal for a relativistic torchship) and where the 10 µm sensing band
 *  lands when the signal arrives. z > 0 reddens (receding), z < 0 blues. */
function fmtDoppler(d: TelemetryDoppler): string {
  const word = d.z > 0 ? "redshift" : d.z < 0 ? "blueshift" : "none";
  const zStr = Math.abs(d.z) >= 1e-3 ? d.z.toFixed(3) : d.z.toExponential(1);
  const sign = d.z >= 0 ? "+" : "";
  const lamObs = (shiftedWavelength(IR_BAND_WAVELENGTH, d.factor) * 1e6).toFixed(2); // µm
  return `z ${sign}${zStr} (${word}) · 10 → ${lamObs} µm`;
}

function fmtPower(w: number): string {
  if (w < 1e3) return `${w.toFixed(0)} W`;
  if (w < 1e6) return `${(w / 1e3).toFixed(1)} kW`;
  if (w < 1e9) return `${(w / 1e6).toFixed(1)} MW`;
  return `${(w / 1e9).toFixed(2)} GW`;
}

function fmtRange(m: number): string {
  if (m < 1e9) return `${(m / 1e3).toLocaleString("en-US", { maximumFractionDigits: 0 })} km`;
  return `${(m / 1.495978707e11).toFixed(3)} AU`;
}

/** Heat/decel budget of a nominal blunt-body entry, for the descent readout: a
 *  representative entry vehicle decelerating from orbital speed at a 6° corridor
 *  angle. Display-only — the land/launch commands still budget aerobraking via
 *  descentBudget. */
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
