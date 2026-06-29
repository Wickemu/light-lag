/**
 * The ship designer — a centred modal workspace.
 *
 * Edit a staged stack (dry mass, propellant, Isp, thrust) and watch the Δv budget,
 * masses, and thrust-to-weight update live from the rocket equation. Launch is
 * role-aware: an in-space craft deploys directly into a circular LEO (full
 * propellant); a launch vehicle rolls out to the Earth pad and flies (or expresses)
 * the ascent, expending its boost stages — the designer shows the live ascent budget
 * and the projected orbital survivor, and gates launch on it.
 *
 * Pulled out of the docked Mission console into its own modal so the build-time
 * workflow gets the viewport room a 286px column can't afford (a two-column layout:
 * the stack editor on the left, the live budget + launch controls on the right) and
 * the console can stay a lean flight readout. On launch it hands the new ship's id
 * back through {@link DesignerPanel.constructor}'s `onLaunched` callback and closes.
 */

import { type Simulation } from "../core/sim.ts";
import {
  type ShipDesign,
  defaultDesign,
  spawnShip,
  spawnOnPad,
  expressToOrbit,
  ascentPreview,
} from "../app/commands.ts";
import {
  type ShipPreset,
  PRESETS_BY_ID,
  presetsByCategory,
  presetToDesign,
} from "../app/shipCatalog.ts";
import { deltaVBudget, initialTWR, stageLiftoffThrust } from "../core/propulsion.ts";
import { el, button, kv, setDisabled, numberField, compactField } from "./dom.ts";

export class DesignerPanel {
  private design: ShipDesign = defaultDesign();

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

  constructor(
    private root: HTMLElement,
    private sim: Simulation,
    private onLaunched?: (shipId: string) => void,
  ) {
    this.build();
  }

  open(): void {
    this.panelEl.style.display = "flex";
  }
  close(): void {
    this.panelEl.style.display = "none";
  }
  isOpen(): boolean {
    return this.panelEl.style.display !== "none";
  }

  private build(): void {
    const panel = el("div", "panel designer-panel");
    this.panelEl = panel;
    panel.style.display = "none";

    const head = el("div", "panel-head");
    head.appendChild(el("div", "panel-title", "SHIP DESIGNER"));
    const close = button("✕", () => this.close());
    close.className = "panel-close";
    close.title = "Close (Esc)";
    head.appendChild(close);
    panel.appendChild(head);

    // Two columns: the stack editor on the left, the budget + launch on the right.
    const cols = el("div", "designer-cols");
    const left = el("div", "designer-stack");
    const right = el("div", "designer-side");
    cols.append(left, right);
    panel.appendChild(cols);

    // ── Left column ──────────────────────────────────────────────────────────
    // Preset fleet picker — load a real or inferred design, then tweak freely.
    this.presetSelect = this.buildPresetSelect();
    left.appendChild(this.presetSelect);
    this.presetCaption = el("div", "preset-caption");
    left.appendChild(this.presetCaption);

    // Editable name (mirrors the loaded preset; the launched ship takes it).
    const nameField = el("label", "field name-field");
    nameField.appendChild(el("span", "field-label", "Name"));
    this.nameInput = document.createElement("input");
    this.nameInput.type = "text";
    this.nameInput.value = this.design.name;
    this.nameInput.oninput = () => { this.design.name = this.nameInput.value; };
    nameField.appendChild(this.nameInput);
    left.appendChild(nameField);

    this.stagesEl = el("div", "stages");
    left.appendChild(this.stagesEl);
    const addBtn = button("+ add stage", () => {
      this.design.stages.push({ name: `Stage ${this.design.stages.length + 1}`, dryMass: 1000, propMass: 8000, isp: 320, thrust: 1e5 });
      this.markCustom();
      this.renderStages();
      this.refreshBudget();
    });
    addBtn.className = "wide-btn";
    addBtn.title = "Add another stage to the stack.";
    left.appendChild(addBtn);

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
    left.appendChild(params);

    // Start-on-pad toggle: a LAUNCH VEHICLE starts on the Earth pad and flies the ascent
    // (its boost stages are expended in the climb); an IN-SPACE craft deploys directly in
    // LEO. Set automatically when a preset is loaded; the player can override for a custom
    // design.
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
    left.appendChild(padRow);

    // ── Right column ─────────────────────────────────────────────────────────
    this.budgetEl = el("div", "budget");
    right.appendChild(this.budgetEl);

    // Role-aware launch controls (rebuilt by renderLaunchArea on toggle / preset load).
    this.launchArea = el("div", "launch-area");
    right.appendChild(this.launchArea);

    this.root.appendChild(panel);

    this.renderStages();
    this.renderLaunchArea();
    this.refreshBudget();
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

  private launch(): void {
    this.finishLaunch(spawnShip(this.sim, this.design));
  }

  /** Stand a launch vehicle on the Earth pad (fly the ascent from the flight console). */
  private rollOut(): void {
    this.finishLaunch(spawnOnPad(this.sim, this.design));
  }

  /** Resolve the ascent instantly and seat the survivor in LEO. The express button is
   *  gated off when the design can't reach orbit; if a stale click still slips through,
   *  refresh the budget so the "✗ short of LEO" readout is shown rather than failing silently. */
  private express(): void {
    const { id } = expressToOrbit(this.sim, this.design);
    if (id) this.finishLaunch(id);
    else this.refreshBudget();
  }

  /** Hand the new ship to the console (which selects + frames it) and close the modal. */
  private finishLaunch(id: string): void {
    this.onLaunched?.(id);
    this.close();
  }
}
