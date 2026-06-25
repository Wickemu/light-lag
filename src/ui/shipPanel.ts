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
import { type BurnDir } from "../core/world.ts";
import {
  type ShipDesign,
  defaultDesign,
  spawnShip,
  startBurn,
} from "../app/commands.ts";
import { deltaVBudget, initialTWR } from "../core/propulsion.ts";
import {
  totalMass,
  dvRemaining,
  shipOsculatingElements,
  shipRelativeState,
  shipWorldState,
  primaryMu,
} from "../core/ships.ts";
import { summarizeOrbit } from "../core/orbit.ts";
import { BODY_BY_ID, AU, DAY } from "../core/constants.ts";
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

  private stagesEl!: HTMLElement;
  private budgetEl!: HTMLElement;
  private shipListEl!: HTMLElement;
  private flightEl!: HTMLElement;
  private readoutEl!: HTMLElement;
  private dvInput!: HTMLInputElement;
  private dirRow!: HTMLElement;
  private executeBtn!: HTMLButtonElement;
  private planBtn!: HTMLButtonElement;

  constructor(
    private root: HTMLElement,
    private sim: Simulation,
    private sm: SceneManager,
    private onPlanTransfer?: (shipId: string) => void,
  ) {
    this.build();
  }

  private build(): void {
    const panel = el("div", "panel ship-panel");

    panel.appendChild(el("div", "panel-label", "SHIP DESIGNER"));
    this.stagesEl = el("div", "stages");
    panel.appendChild(this.stagesEl);
    const addBtn = button("+ add stage", () => {
      this.design.stages.push({ name: `Stage ${this.design.stages.length + 1}`, dryMass: 1000, propMass: 8000, isp: 320, thrust: 1e5 });
      this.renderStages();
      this.refreshBudget();
    });
    addBtn.className = "wide-btn";
    panel.appendChild(addBtn);

    const params = el("div", "design-params");
    numberField(params, "Payload (t)", this.design.payloadMass / 1000, (v) => {
      this.design.payloadMass = v * 1000;
      this.refreshBudget();
    });
    numberField(params, "LEO alt (km)", this.design.altitudeKm, (v) => {
      this.design.altitudeKm = v;
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
      compactField(row, "dry t", s.dryMass / 1000, (v) => { s.dryMass = v * 1000; this.refreshBudget(); });
      compactField(row, "prop t", s.propMass / 1000, (v) => { s.propMass = v * 1000; this.refreshBudget(); });
      compactField(row, "Isp s", s.isp, (v) => { s.isp = v; this.refreshBudget(); });
      compactField(row, "kN", s.thrust / 1000, (v) => { s.thrust = v * 1000; this.refreshBudget(); });
      if (this.design.stages.length > 1) {
        const rm = button("✕", () => {
          this.design.stages.splice(i, 1);
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
    startBurn(this.sim, this.selectedId, dv, this.dir);
  }

  private syncDirButtons(): void {
    for (const b of Array.from(this.dirRow.children) as HTMLButtonElement[]) {
      b.classList.toggle("active", b.dataset.dir === this.dir);
    }
  }

  private refreshShipList(): void {
    this.shipListEl.innerHTML = "";
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

    const mu = primaryMu(ship);
    const primary = BODY_BY_ID.get(ship.primary)!;
    const el = shipOsculatingElements(ship, t);
    const rel = shipRelativeState(ship, t);
    const speed = length(rel.v);

    const lines: string[] = [];
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
    }
    lines.push(kv("Speed", `${(speed / 1000).toFixed(3)} km/s`));
    lines.push(kv("Mass", `${(totalMass(ship) / 1000).toFixed(2)} t`));
    lines.push(kv("Δv remaining", `${(dvRemaining(ship) / 1000).toFixed(2)} km/s`));

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
    // A transfer can only be planned from a planet (not mid-flight).
    this.planBtn.disabled = ship.primary === "sun" || (!!tr && tr.departed);

    if (ship.mode === "thrust" && ship.burn) {
      const pct = (100 * ship.burn.dvDone) / ship.burn.dvTarget;
      lines.push(kv("BURNING", `${ship.burn.dvDone.toFixed(0)} / ${ship.burn.dvTarget.toFixed(0)} m/s (${pct.toFixed(0)}%)`));
      this.executeBtn.disabled = true;
      this.executeBtn.textContent = "Burning…";
    } else {
      this.executeBtn.disabled = false;
      this.executeBtn.textContent = "Execute burn";
    }

    this.readoutEl.innerHTML = lines.join("");
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
