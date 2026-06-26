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
  planSpiral,
  shipSurfaceParams,
} from "../app/commands.ts";
import {
  ascentBudget,
  descentBudget,
  surfaceManeuverCost,
} from "../core/surface.ts";
import {
  type ShipPreset,
  PRESETS_BY_ID,
  presetsByCategory,
  presetToDesign,
} from "../app/shipCatalog.ts";
import { deltaVBudget, initialTWR, availablePowerW, thrustAt } from "../core/propulsion.ts";
import {
  totalMass,
  dvRemaining,
  activeStage,
  shipOsculatingElements,
  shipRelativeState,
  shipWorldState,
  shipThermalState,
  primaryMu,
} from "../core/ships.ts";
import { summarizeOrbit, periapsisRadius, j2Rates } from "../core/orbit.ts";
import { bodyPosition } from "../core/ephemeris.ts";
import { retardedTime } from "../core/comms.ts";
import { STAR_BY_ID } from "../core/stars.ts";
import { BODY_BY_ID, AU, DAY, RAD, JULIAN_YEAR } from "../core/constants.ts";
import { formatDate } from "../core/time.ts";
import { length } from "../core/math/vec3.ts";

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
  private surfaceEl!: HTMLElement;
  private surfaceReadout!: HTMLElement;
  private surfaceAltInput!: HTMLInputElement;
  private landBtn!: HTMLButtonElement;
  private launchBtn!: HTMLButtonElement;
  private electricEl!: HTMLElement;
  private spiralAltInput!: HTMLInputElement;
  private spiralBtn!: HTMLButtonElement;

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

    panel.appendChild(el("div", "panel-label", "SHIP DESIGNER"));

    // Preset fleet picker — load a real or inferred design, then tweak freely.
    this.presetSelect = this.buildPresetSelect();
    panel.appendChild(this.presetSelect);
    this.presetCaption = el("div", "preset-caption");
    panel.appendChild(this.presetCaption);

    // Editable name (mirrors the loaded preset; the launched ship takes it).
    const nameField = el("label", "field name-field");
    nameField.appendChild(el("span", "field-label", "Name"));
    this.nameInput = document.createElement("input");
    this.nameInput.type = "text";
    this.nameInput.value = this.design.name;
    this.nameInput.oninput = () => { this.design.name = this.nameInput.value; };
    nameField.appendChild(this.nameInput);
    panel.appendChild(nameField);

    this.stagesEl = el("div", "stages");
    panel.appendChild(this.stagesEl);
    const addBtn = button("+ add stage", () => {
      this.design.stages.push({ name: `Stage ${this.design.stages.length + 1}`, dryMass: 1000, propMass: 8000, isp: 320, thrust: 1e5 });
      this.markCustom();
      this.renderStages();
      this.refreshBudget();
    });
    addBtn.className = "wide-btn";
    panel.appendChild(addBtn);

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
    panel.appendChild(params);

    this.budgetEl = el("div", "budget");
    panel.appendChild(this.budgetEl);

    const launch = button("▶ Launch to LEO", () => this.launch());
    launch.className = "wide-btn primary";
    panel.appendChild(launch);

    panel.appendChild(el("hr"));
    panel.appendChild(el("div", "panel-label", "SHIPS"));
    this.shipListEl = el("div", "ship-list");
    panel.appendChild(this.shipListEl);

    this.flightEl = el("div", "flight");
    this.readoutEl = el("div", "flight-readout");
    this.flightEl.appendChild(this.readoutEl);

    this.planBtn = button("Plan transfer ▸", () => {
      if (this.selectedId && this.onPlanTransfer) this.onPlanTransfer(this.selectedId);
    });
    this.planBtn.className = "wide-btn";
    this.flightEl.appendChild(this.planBtn);

    this.interstellarBtn = button("Interstellar ▸", () => {
      if (this.selectedId && this.onPlanInterstellar) this.onPlanInterstellar(this.selectedId);
    });
    this.interstellarBtn.className = "wide-btn";
    this.flightEl.appendChild(this.interstellarBtn);

    // Surface ops — landing & takeoff Δv budgeting (shown only when the ship is
    // coasting in the SOI of a body with a surface, or already landed).
    this.surfaceEl = el("div", "surface-ops");
    this.surfaceEl.appendChild(el("div", "panel-label", "SURFACE OPS"));
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
    this.flightEl.appendChild(this.surfaceEl);

    // Electric drive — commit a low-thrust spiral to a target orbit (shown only
    // when the active stage is electric and the ship is coasting about a body).
    this.electricEl = el("div", "surface-ops");
    this.electricEl.appendChild(el("div", "panel-label", "ELECTRIC SPIRAL"));
    const elRow = el("div", "dv-row");
    this.spiralAltInput = document.createElement("input");
    this.spiralAltInput.type = "number";
    this.spiralAltInput.value = "35786"; // GEO
    this.spiralAltInput.min = "0";
    this.spiralAltInput.className = "dv-input";
    this.spiralBtn = button("⟳ Spiral", () => this.doSpiral());
    elRow.append(el("span", "dv-label", "to (km)"), this.spiralAltInput, this.spiralBtn);
    this.electricEl.appendChild(elRow);
    this.flightEl.appendChild(this.electricEl);

    const burnControls = el("div", "burn-controls");
    burnControls.appendChild(el("div", "panel-label", "MANEUVER"));
    this.dirRow = el("div", "dir-row");
    for (const d of DIRS) {
      const b = button(DIR_LABEL[d], () => {
        this.dir = d;
        this.syncDirButtons();
      });
      b.className = "dir-btn";
      b.dataset.dir = d;
      this.dirRow.appendChild(b);
    }
    burnControls.appendChild(this.dirRow);

    const dvRow = el("div", "dv-row");
    this.dvInput = document.createElement("input");
    this.dvInput.type = "number";
    this.dvInput.value = "500";
    this.dvInput.min = "0";
    this.dvInput.className = "dv-input";
    const dvLabel = el("span", "dv-label", "Δv (m/s)");
    this.executeBtn = button("Execute burn", () => this.execute());
    this.executeBtn.className = "primary";
    dvRow.append(dvLabel, this.dvInput, this.executeBtn);
    burnControls.appendChild(dvRow);

    this.flightEl.appendChild(burnControls);
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
      const row = el("div", "stage-row");
      row.appendChild(el("span", "stage-name", `${i + 1}`));
      compactField(row, "dry t", s.dryMass / 1000, (v) => { s.dryMass = v * 1000; this.markCustom(); this.refreshBudget(); });
      compactField(row, "prop t", s.propMass / 1000, (v) => { s.propMass = v * 1000; this.markCustom(); this.refreshBudget(); });
      compactField(row, "Isp s", s.isp, (v) => { s.isp = v; this.markCustom(); this.refreshBudget(); });
      compactField(row, "kN", s.thrust / 1000, (v) => { s.thrust = v * 1000; this.markCustom(); this.refreshBudget(); });
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
      this.stagesEl.appendChild(row);
    });
  }

  private refreshBudget(): void {
    const b = deltaVBudget(this.design.stages, this.design.payloadMass);
    const twr = initialTWR(this.design.stages, this.design.payloadMass);
    const perStage = b.perStage.map((d, i) => `S${i + 1}: ${(d / 1000).toFixed(2)}`).join("  ");
    this.budgetEl.innerHTML =
      kv("Total Δv", `${(b.total / 1000).toFixed(2)} km/s`) +
      kv("Wet / final mass", `${(b.wetMass / 1000).toFixed(1)} / ${(b.finalMass / 1000).toFixed(1)} t`) +
      kv("Initial T/W", twr.toFixed(2) + (twr < 1 ? " (low thrust)" : "")) +
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
    const ship = this.sim.world.ships.get(id);
    if (ship) {
      const el = shipOsculatingElements(ship, this.sim.world.t);
      const ra = el.a * (1 + el.e);
      const distUnits = Math.max((ra / 1e9) * 2.2, 0.02);
      this.sm.setFocusTarget(id, (t) => {
        const s = this.sim.world.ships.get(id);
        return s ? shipWorldState(s, t).r : { x: 0, y: 0, z: 0 };
      }, distUnits);
    }
    this.flightEl.style.display = "block";
    this.refreshShipList();
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
    if (this.sim.world.ships.size === 0) {
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
        const r = j2Rates(mu, primary.radius, primary.J2, el.a, el.e, el.i);
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
    this.spiralBtn.disabled = !canSpiral;

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
    this.planBtn.disabled = ship.primary === "sun" || !!leg || (!!tr && tr.departed);
    this.interstellarBtn.disabled = !!leg;

    // Thermal & detection — there is no stealth in space.
    const th = shipThermalState(ship, t);
    lines.push(kv("Solar flux", `${th.solarFlux.toFixed(0)} W/m² @ ${(th.distanceFromSun / AU).toFixed(2)} AU`));
    lines.push(kv("Hull temp", `${th.hullTempK.toFixed(0)} K`));
    lines.push(kv("IR signature", fmtPower(th.signatureW) + (th.thrusting ? " — drive HOT" : "")));
    lines.push(kv("Detectable to", fmtRange(th.detectionRangeM)));
    if (th.thrusting) {
      lines.push(kv("Drive waste heat", fmtPower(th.driveWasteW)));
      lines.push(kv("Radiator needed", `${Math.round(th.radiatorAreaM2).toLocaleString("en-US")} m²`));
    }

    if (ship.landed) lines.unshift(kv("Surface", `landed on ${BODY_BY_ID.get(ship.landed.bodyId)?.name ?? ship.landed.bodyId}`));

    if (ship.mode === "thrust" && ship.burn) {
      const pct = (100 * ship.burn.dvDone) / ship.burn.dvTarget;
      lines.push(kv("BURNING", `${ship.burn.dvDone.toFixed(0)} / ${ship.burn.dvTarget.toFixed(0)} m/s (${pct.toFixed(0)}%)`));
      this.executeBtn.disabled = true;
      this.executeBtn.textContent = "Burning…";
    } else {
      this.executeBtn.disabled = false;
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
      this.landBtn.disabled = true;
      this.launchBtn.disabled = !feasible;
    } else {
      const orbEl = shipOsculatingElements(ship, this.sim.world.t);
      const alt = Math.max(0, periapsisRadius(orbEl.a, orbEl.e) - body.radius);
      const desc = descentBudget(body, shipSurfaceParams(ship, body, alt))!;
      const cost = surfaceManeuverCost(remaining, ship.payloadMass, desc.dvTotal);
      const canLand = cost.feasible >= 0;
      this.surfaceReadout.innerHTML =
        kv("Body", `${body.name} (${body.atmosphere ? "atmosphere" : "airless"})`) +
        kv("Descent Δv", `${(desc.dvTotal / 1000).toFixed(2)} km/s`) +
        (body.atmosphere ? kv("Aerobraking", `${(desc.aerobrakeFraction * 100).toFixed(0)}% shed for free`) : "") +
        kv("Land propellant", `${(cost.propellant / 1000).toFixed(1)} t`) +
        (canLand ? `<div class="ok">✓ can land</div>` : `<div class="warn">✗ insufficient Δv to land</div>`);
      this.landBtn.disabled = !canLand;
      this.launchBtn.disabled = true;
    }
  }

  private doLand(): void {
    if (this.selectedId) landShip(this.sim, this.selectedId);
  }

  private doLaunch(): void {
    if (!this.selectedId) return;
    launchShip(this.sim, this.selectedId, Math.max(0, Number(this.surfaceAltInput.value) || 0));
  }

  /** Commit a low-thrust Edelbaum spiral from the current circular orbit to the
   *  requested altitude — charged up front, then flown as an analytic leg. */
  private doSpiral(): void {
    if (this.selectedId) planSpiral(this.sim, this.selectedId, Math.max(0, Number(this.spiralAltInput.value) || 0));
  }
}

// ── tiny DOM helpers ────────────────────────────────────────────────────────
function el(tag: string, className = "", text = ""): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function kv(k: string, v: string): string {
  return `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

function numberField(parent: HTMLElement, label: string, value: number, onChange: (v: number) => void): HTMLInputElement {
  const wrap = el("label", "field");
  wrap.appendChild(el("span", "field-label", label));
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.oninput = () => { const v = parseFloat(input.value); if (isFinite(v)) onChange(v); };
  wrap.appendChild(input);
  parent.appendChild(wrap);
  return input;
}

function compactField(parent: HTMLElement, label: string, value: number, onChange: (v: number) => void): void {
  const wrap = el("label", "cfield");
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.oninput = () => { const v = parseFloat(input.value); if (isFinite(v)) onChange(v); };
  wrap.append(input, el("span", "cfield-label", label));
  parent.appendChild(wrap);
}

function formatDur(s: number): string {
  if (!isFinite(s)) return "—";
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(2)} hr`;
  return `${(s / 86400).toFixed(2)} d`;
}

/** Light-delay readout: live for the local case, then seconds → minutes → hours. */
function fmtDelay(s: number): string {
  if (s < 1) return "live";
  if (s < 90) return `${s.toFixed(0)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(2)} hr`;
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
