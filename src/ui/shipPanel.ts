/**
 * The ship designer and flight console.
 *
 * Designer: edit a staged stack (dry mass, propellant, Isp, thrust) and watch
 * the Δv budget, masses, and thrust-to-weight update live from the rocket
 * equation. Launch places the ship in a circular LEO.
 *
 * Flight: select a ship to see its real osculating orbit (periapsis/apoapsis
 * altitude, period, speed), its remaining mass and Δv, then spend Δv in a chosen
 * direction and watch the orbit reshape as the burn runs.
 */

import { type Simulation } from "../core/sim.ts";
import { type SceneManager } from "../render/SceneManager.ts";
import { type BurnDir, type Ship } from "../core/world.ts";
import {
  type ShipDesign,
  defaultDesign,
  spawnShip,
  sendBurn,
  landShip,
  launchShip,
  flyEntry,
  planSpiral,
  deleteShip,
  shipSurfaceParams,
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
  private lastShipCount = -1;

  private panelEl!: HTMLElement;
  private stagesEl!: HTMLElement;
  private budgetEl!: HTMLElement;
  private presetSelect!: HTMLSelectElement;
  private presetCaption!: HTMLElement;
  private nameInput!: HTMLInputElement;
  private payloadInput!: HTMLInputElement;
  private altInput!: HTMLInputElement;
  private shipListEl!: HTMLElement;
  private flightEl!: HTMLElement;
  private readoutEl!: HTMLElement;
  private dvInput!: HTMLInputElement;
  private dirRow!: HTMLElement;
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
    });
    dsn.appendChild(params);

    this.budgetEl = el("div", "budget");
    dsn.appendChild(this.budgetEl);

    const launch = button("▶ Launch to LEO", () => this.launch());
    launch.className = "wide-btn primary";
    launch.title = "Place this design in a circular low orbit and start flying it.";
    dsn.appendChild(launch);

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
    this.budgetEl.innerHTML =
      kv("Total Δv", `${(b.total / 1000).toFixed(2)} km/s`) +
      kv("Wet / final mass", `${(b.wetMass / 1000).toFixed(1)} / ${(b.finalMass / 1000).toFixed(1)} t`) +
      kv("Initial T/W", twr.toFixed(2) + (twr < 1 ? " (low thrust)" : "")) +
      (hasBoosters ? kv("Liftoff thrust", `${(stageLiftoffThrust(first!) / 1000).toFixed(0)} kN (core + boosters)`) : "") +
      `<div class="per-stage">${perStage} km/s</div>`;
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
    this.renderStages();
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
    // The order is transmitted, not applied: it reaches the ship at light-lag.
    sendBurn(this.sim, this.selectedId, dv, this.dir);
  }

  private syncDirButtons(): void {
    for (const b of Array.from(this.dirRow.children) as HTMLButtonElement[]) {
      b.classList.toggle("active", b.dataset.dir === this.dir);
    }
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
    setDisabled(this.planBtn, ship.primary === "sun" || !!leg || (!!tr && tr.departed),
      "Plan a transfer only from a parking orbit around a body (not mid-transfer or interstellar).");
    setDisabled(this.interstellarBtn, !!leg, "Already on an interstellar leg.");

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
    } else {
      setDisabled(this.executeBtn, false);
      this.executeBtn.textContent = "Execute burn";
    }

    this.updateSurfaceOps(ship);
    this.readoutEl.innerHTML = lines.join("");
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
    this.warpDepartBtn.style.display = "none";
    setDisabled(this.planBtn, true, "Ship lost.");
    setDisabled(this.interstellarBtn, true, "Ship lost.");
    setDisabled(this.executeBtn, true, "Ship lost.");
    this.executeBtn.textContent = "Execute burn";
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
