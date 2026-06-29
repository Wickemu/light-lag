/**
 * The flight console — the docked "Mission" panel.
 *
 * Select a launched ship to command it. The console leads with a status banner (the
 * one headline state — BURNING / IN TRANSIT / LANDED / …) and a tight primary readout
 * (signal delay, orbit, speed, mass, Δv); the deep telemetry (J2 precession & Doppler,
 * electric drive, transfer & flybys, thermal & detection) tucks behind disclosure so
 * it's there when wanted, out of the way when not. Contextual actions appear only when
 * viable: the planners, the OPERATIONS card (land / launch / fly-entry / electric
 * spiral), and a Dock button when another craft is at rendezvous.
 *
 * Building a ship lives in the separate {@link DesignerPanel} modal (opened from the
 * header); propellant transfer / assembly lives in the {@link DockPanel} modal.
 */

import { type Simulation } from "../core/sim.ts";
import { type SceneManager } from "../render/SceneManager.ts";
import { type BurnDir, type BurnGoal, type Ship } from "../core/world.ts";
import {
  sendBurn,
  landShip,
  launchShip,
  flyEntry,
  planSpiral,
  deleteShip,
  shipSurfaceParams,
  dockCandidates,
} from "../app/commands.ts";
import {
  ascentBudget,
  descentBudget,
  surfaceManeuverCost,
  DEFAULT_ENTRY_BETA,
} from "../core/surface.ts";
import { entryTrajectory, entryInterfaceAlt, type EntryVehicle } from "../core/maneuver/entry.ts";
import {
  activeStage,
  shipOsculatingElements,
  shipWorldState,
  shipEntryReadout,
  primaryMu,
} from "../core/ships.ts";
import { periapsisRadius, orbitalPeriod } from "../core/orbit.ts";
import { type BodyDef, BODY_BY_ID, DEG } from "../core/constants.ts";
import { formatDate } from "../core/time.ts";
import { el, button, kv, setDisabled, numberField } from "./dom.ts";
import { collapsible, type Collapsible } from "./collapsible.ts";
import { markTerm } from "./tooltip.ts";
import {
  flightCtx,
  statusBanner,
  statusChips,
  primaryLines,
  transferSummaryLine,
  orbitDetailGroup,
  driveDetailGroup,
  transferDetailGroup,
  thermalDetailGroup,
  type ReadoutGroup,
} from "./flightReadout.ts";

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
  private selectedId: string | null = null;
  private dir: BurnDir = "prograde";
  private guidanceMode: "open" | "closed" = "open";
  private goalType: "periapsis" | "apoapsis" | "circularize" = "periapsis";
  private lastShipCount = -1;

  /** Open the ship designer modal (wired in main.ts after both panels exist). */
  onOpenDesigner?: () => void;
  /** Open the dock/transfer modal for the given ship (wired in main.ts). */
  onOpenDock?: (shipId: string) => void;

  private panelEl!: HTMLElement;
  private shipListEl!: HTMLElement;
  private fleetSection!: Collapsible;
  private flightEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private chipsEl!: HTMLElement;
  private readoutEl!: HTMLElement;
  private orbitGroup!: Collapsible;
  private driveGroup!: Collapsible;
  private transferGroup!: Collapsible;
  private thermalGroup!: Collapsible;
  private planBtn!: HTMLButtonElement;
  private interstellarBtn!: HTMLButtonElement;
  private warpDepartBtn!: HTMLButtonElement;
  private operationsEl!: HTMLElement;
  private surfaceEl!: HTMLElement;
  private surfaceReadout!: HTMLElement;
  private surfaceAltInput!: HTMLInputElement;
  private landBtn!: HTMLButtonElement;
  private launchBtn!: HTMLButtonElement;
  private flyEntryBtn!: HTMLButtonElement;
  private electricEl!: HTMLElement;
  private spiralAltInput!: HTMLInputElement;
  private spiralBtn!: HTMLButtonElement;
  private dockBtn!: HTMLButtonElement;
  private dvInput!: HTMLInputElement;
  private dirRow!: HTMLElement;
  private guidanceRow!: HTMLElement;
  private goalRow!: HTMLElement;
  private goalTypeRow!: HTMLElement;
  private goalAltInput!: HTMLInputElement;
  private guidanceHint!: HTMLElement;
  private executeBtn!: HTMLButtonElement;
  private deleteBtn!: HTMLButtonElement;

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

  /** Select + frame a ship just launched from the designer modal. */
  selectFromDesigner(id: string): void {
    this.select(id);
  }

  /** Re-frame + refresh after the dock modal merged a partner into a ship. */
  onPartnerAssembled(shipId: string, wasFocused: boolean): void {
    if (wasFocused) this.frameShip(shipId);
    this.refreshShipList();
  }

  private build(): void {
    const panel = el("div", "panel ship-panel");
    this.panelEl = panel;

    // Title row: MISSION + a button to open the designer, then a ✕ close affordance.
    const head = el("div", "panel-head");
    head.appendChild(el("div", "panel-title", "MISSION"));
    const design = button("✚ Design", () => this.onOpenDesigner?.());
    design.className = "head-btn";
    design.title = "Open the ship designer (N) — build and launch a ship.";
    head.appendChild(design);
    const close = button("✕", () => this.toggle());
    close.className = "panel-close";
    close.title = "Close (F or Esc)";
    head.appendChild(close);
    panel.appendChild(head);

    // ── Fleet section (launched ships) ────────────────────────────────────────
    this.fleetSection = collapsible("Fleet", { id: "fleet", open: true });
    this.shipListEl = el("div", "ship-list");
    this.fleetSection.body.appendChild(this.shipListEl);
    panel.appendChild(this.fleetSection.root);

    // ── Flight + Maneuver (only shown once a ship is selected) ─────────────────
    this.flightEl = el("div", "flight");

    const flightSection = collapsible("Flight", { id: "flight", open: true });
    const flt = flightSection.body;

    // Headline status + cross-cutting chips, then the always-on primary readout.
    this.statusEl = el("div", "flight-status");
    flt.appendChild(this.statusEl);
    this.chipsEl = el("div", "chip-row");
    flt.appendChild(this.chipsEl);
    this.readoutEl = el("div", "flight-readout");
    flt.appendChild(this.readoutEl);

    // Advanced telemetry behind disclosure (each hidden when it has nothing to show).
    this.orbitGroup = collapsible("Orbit detail", { id: "flight.orbit", open: false });
    this.driveGroup = collapsible("Drive", { id: "flight.drive", open: true });
    this.transferGroup = collapsible("Transfer detail", { id: "flight.transfer", open: false });
    this.thermalGroup = collapsible("Thermal & signature", { id: "flight.thermal", open: false });
    for (const g of [this.orbitGroup, this.driveGroup, this.transferGroup, this.thermalGroup]) {
      g.root.classList.add("flight-group");
      flt.appendChild(g.root);
    }

    // Planner actions.
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

    // OPERATIONS — surface ops + electric spiral, shown only when the ship's state
    // makes them viable (hidden together when neither is).
    this.operationsEl = el("div", "operations");
    this.operationsEl.appendChild(sectionLabel("OPERATIONS"));

    this.surfaceEl = el("div", "ops-card");
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
    this.operationsEl.appendChild(this.surfaceEl);

    this.electricEl = el("div", "ops-card");
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
    this.operationsEl.appendChild(this.electricEl);
    flt.appendChild(this.operationsEl);

    // Dock / transfer lives in its own modal — surfaced here only at rendezvous.
    this.dockBtn = button("⛽ Dock / transfer ▸", () => {
      if (this.selectedId && this.onOpenDock) this.onOpenDock(this.selectedId);
    });
    this.dockBtn.className = "wide-btn";
    this.dockBtn.style.display = "none";
    flt.appendChild(this.dockBtn);

    this.flightEl.appendChild(flightSection.root);

    // ── Maneuver section — burn direction + guidance + Δv. ─────────────────────
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

    // Quiet footer — a destructive action kept clear of "Execute burn".
    const footer = el("div", "console-footer");
    this.deleteBtn = button("🗑 Delete ship", () => this.doDelete());
    this.deleteBtn.className = "wide-btn danger";
    this.deleteBtn.title = "Remove this ship from the simulation. Cannot be undone.";
    footer.appendChild(this.deleteBtn);
    this.flightEl.appendChild(footer);

    panel.appendChild(this.flightEl);

    this.root.appendChild(panel);

    this.syncDirButtons();
    this.syncGuidanceButtons();
    this.flightEl.style.display = "none";
  }

  private select(id: string): void {
    this.selectedId = id;
    if (this.sim.world.ships.get(id)) this.frameShip(id);
    this.flightEl.style.display = "block";
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
    const elements = shipOsculatingElements(ship, this.sim.world.t);
    const ra = elements.a * (1 + elements.e);
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
    const elements = shipOsculatingElements(ship, this.sim.world.t);
    if (elements.e >= 1 || elements.a <= 0) return false; // unbound — not a tight fast loop
    const period = orbitalPeriod(elements.a, primaryMu(ship));
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
      this.shipListEl.appendChild(el("div", "ship-empty", "No ships yet — ✚ Design one to launch."));
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
    // A destroyed ship has no live orbit to read — show the loss, offer only deletion.
    if (ship.status === "lost") {
      this.renderLost(ship);
      return;
    }

    const ctx = flightCtx(ship, this.sim, t);

    // Headline + chips.
    const banner = statusBanner(ctx);
    this.statusEl.className = `flight-status ${banner.cls}`;
    this.statusEl.textContent = banner.text;
    const chips = statusChips(ctx, this.sim);
    this.chipsEl.innerHTML = "";
    for (const c of chips) this.chipsEl.appendChild(el("span", "chip" + (c.cls ? ` ${c.cls}` : ""), c.text));
    this.chipsEl.style.display = chips.length ? "flex" : "none";

    // Primary readout (+ a planned-transfer one-liner).
    this.readoutEl.innerHTML = primaryLines(ctx) + transferSummaryLine(ctx);

    // Advanced groups — populate + show only when they carry content this frame.
    this.applyGroup(this.orbitGroup, orbitDetailGroup(ctx));
    this.applyGroup(this.driveGroup, driveDetailGroup(ctx));
    this.applyGroup(this.transferGroup, transferDetailGroup(ctx));
    this.applyGroup(this.thermalGroup, thermalDetailGroup(ctx));

    // Planner gating (a transfer can only be planned from a parking orbit; etc.).
    const tr = ship.transfer;
    const leg = ship.interstellarLeg;
    setDisabled(this.planBtn, ship.primary === "sun" || !!leg || !!ship.landed || (!!tr && tr.departed),
      ship.landed ? "Launch to a parking orbit first." : "Plan a transfer only from a parking orbit around a body (not mid-transfer or interstellar).");
    setDisabled(this.interstellarBtn, !!leg || !!ship.landed,
      ship.landed ? "Launch to a parking orbit first." : "Already on an interstellar leg.");
    const planned = !!tr && !tr.departed;
    this.warpDepartBtn.style.display = planned ? "block" : "none";
    if (planned) {
      setDisabled(this.warpDepartBtn, this.sim.anyThrust(), "Can't skip time while a burn is running.");
      this.warpDepartBtn.textContent = `⏩ Warp to ${formatDate(tr!.tDepart)}`;
    }

    // Burn gating.
    if (ship.mode === "thrust" && ship.burn) {
      setDisabled(this.executeBtn, true, "Burn in progress.");
      this.executeBtn.textContent = "Burning…";
      this.setGuidanceDisabled(true);
    } else {
      setDisabled(this.executeBtn, false);
      this.executeBtn.textContent = "Execute burn";
      this.setGuidanceDisabled(false);
    }

    // Contextual actions: surface ops, electric spiral, dock.
    this.updateSurfaceOps(ship);
    const stage = activeStage(ship);
    const canSpiral = !!stage?.electric && ship.mode === "coast" && ship.primary !== "sun"
      && !ship.landed && !ship.interstellarLeg && !ship.spiral;
    this.electricEl.style.display = canSpiral ? "block" : "none";
    setDisabled(this.spiralBtn, !canSpiral,
      "Available only with an electric drive while coasting in orbit around a body.");
    this.operationsEl.style.display = (this.surfaceEl.style.display !== "none" || canSpiral) ? "flex" : "none";

    this.dockBtn.style.display = dockCandidates(this.sim, ship.id).length > 0 ? "block" : "none";
  }

  /** Populate a disclosure group and show it only when it has content this frame. */
  private applyGroup(group: Collapsible, g: ReadoutGroup): void {
    group.root.style.display = g.show ? "" : "none";
    if (g.show) group.body.innerHTML = g.html;
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
    this.statusEl.className = "flight-status lost";
    this.statusEl.textContent = `CONTACT LOST · impact with ${where}`;
    this.chipsEl.innerHTML = "";
    this.chipsEl.style.display = "none";
    this.readoutEl.innerHTML = `<div class="warn">✗ ${ship.name} was destroyed — impact with ${where}.</div>`;
    for (const g of [this.orbitGroup, this.driveGroup, this.transferGroup, this.thermalGroup]) {
      g.root.style.display = "none";
    }
    this.operationsEl.style.display = "none";
    this.dockBtn.style.display = "none";
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
