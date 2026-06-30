/**
 * The Shipyard — a full-viewport build workspace, lifted out of the Mission panel.
 *
 * Building a vehicle is a distinct, form-heavy task from flying one, so it gets
 * its own room: a two-column workspace (stack editor | live performance) that
 * temporarily takes over the viewport. The left column edits a staged stack
 * (dry mass, propellant, Isp, thrust, strap-on boosters) and the design params;
 * the right column shows it back as instruments — a stacked rocket diagram, the
 * Δv budget as bars, thrust-to-weight as a gauge, and the role-aware launch.
 *
 * It reuses every piece of the existing build math/commands unchanged
 * ({@link deltaVBudget}, {@link initialTWR}, {@link ascentPreview},
 * {@link spawnShip}/{@link spawnOnPad}/{@link expressToOrbit}); only the layout
 * and the visualisation are new. On launch it hands the new ship's id back to the
 * flight console and closes. Nothing here runs per frame — it refreshes only on
 * user edits, so it may rebuild its readout freely.
 */

import { type Simulation } from "@lightlag/engine/sim";
import {
  type ShipDesign,
  defaultDesign,
  spawnShip,
  spawnOnPad,
  ascentPreview,
} from "../app/commands.ts";
import {
  type ShipPreset,
  PRESETS_BY_ID,
  presetsByCategory,
  presetToDesign,
} from "../app/shipCatalog.ts";
import { deltaVBudget, initialTWR, stageLiftoffThrust } from "@lightlag/engine/propulsion";
import { el, button, numberField, compactField, setDisabled } from "./dom.ts";
import { radialGauge } from "./instruments.ts";

const SVGNS = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export class Shipyard {
  private design: ShipDesign = defaultDesign();
  private panelEl!: HTMLElement;
  private presetSelect!: HTMLSelectElement;
  private presetCaption!: HTMLElement;
  private nameInput!: HTMLInputElement;
  private payloadInput!: HTMLInputElement;
  private altInput!: HTMLInputElement;
  private inclInput!: HTMLInputElement;
  private stagesEl!: HTMLElement;
  private perfEl!: HTMLElement;
  private launchArea!: HTMLElement;
  /** "Roll to Pad" — disabled (with a reason) when the design can't reach orbit. */
  private padBtn: HTMLButtonElement | null = null;

  constructor(
    private root: HTMLElement,
    private sim: Simulation,
    private onLaunched: (shipId: string) => void,
  ) {
    this.build();
  }

  open(): void { this.panelEl.style.display = "flex"; }
  close(): void { this.panelEl.style.display = "none"; }
  isOpen(): boolean { return this.panelEl.style.display !== "none"; }
  toggle(): void { this.isOpen() ? this.close() : this.open(); }

  private build(): void {
    const panel = el("div", "panel shipyard");
    panel.style.display = "none";
    this.panelEl = panel;

    const head = el("div", "panel-head");
    head.appendChild(el("div", "panel-title", "SHIPYARD"));
    const close = button("✕", () => this.close());
    close.className = "panel-close";
    close.title = "Close (B or Esc)";
    head.appendChild(close);
    panel.appendChild(head);

    // Preset + name row, spanning the workspace.
    const top = el("div", "yard-top");
    this.presetSelect = this.buildPresetSelect();
    top.appendChild(this.presetSelect);
    const nameField = el("label", "field name-field");
    nameField.appendChild(el("span", "field-label", "Name"));
    this.nameInput = document.createElement("input");
    this.nameInput.type = "text";
    this.nameInput.value = this.design.name;
    this.nameInput.oninput = () => { this.design.name = this.nameInput.value; };
    nameField.appendChild(this.nameInput);
    top.appendChild(nameField);
    panel.appendChild(top);

    this.presetCaption = el("div", "preset-caption");
    panel.appendChild(this.presetCaption);

    // Two columns: STACK editor | PERFORMANCE readout.
    const cols = el("div", "yard-cols");

    const stackCol = el("div", "yard-col yard-stack");
    stackCol.appendChild(el("div", "section-label", "STACK"));
    this.stagesEl = el("div", "stages");
    stackCol.appendChild(this.stagesEl);
    const addBtn = button("+ add stage", () => {
      this.design.stages.push({ name: `Stage ${this.design.stages.length + 1}`, dryMass: 1000, propMass: 8000, isp: 320, thrust: 1e5 });
      this.markCustom();
      this.renderStages();
      this.refresh();
    });
    addBtn.className = "wide-btn";
    addBtn.title = "Add another stage to the stack.";
    stackCol.appendChild(addBtn);

    const params = el("div", "design-params");
    this.payloadInput = numberField(params, "Payload (t)", this.design.payloadMass / 1000, (v) => {
      this.design.payloadMass = v * 1000; this.markCustom(); this.refresh();
    });
    this.altInput = numberField(params, "LEO alt (km)", this.design.altitudeKm, (v) => {
      this.design.altitudeKm = v; this.markCustom(); this.refresh();
    });
    this.inclInput = numberField(params, "Incl / pad lat (°)", this.design.inclinationDeg, (v) => {
      this.design.inclinationDeg = Math.max(0, Math.min(90, v)); this.markCustom(); this.refresh();
    });
    stackCol.appendChild(params);

    const perfCol = el("div", "yard-col yard-perf");
    perfCol.appendChild(el("div", "section-label", "PERFORMANCE"));
    this.perfEl = el("div", "yard-perf-body");
    perfCol.appendChild(this.perfEl);

    cols.append(stackCol, perfCol);
    panel.appendChild(cols);

    // Role-aware launch controls.
    this.launchArea = el("div", "yard-launch");
    panel.appendChild(this.launchArea);

    this.root.appendChild(panel);

    this.renderStages();
    this.renderLaunchArea();
    this.refresh();
  }

  // ── Designer editing (moved from ShipPanel, layout-adapted) ──────────────────

  private renderStages(): void {
    this.stagesEl.innerHTML = "";
    this.design.stages.forEach((s, i) => {
      const block = el("div", "stage-block");
      const row = el("div", "stage-row");
      row.appendChild(el("span", "stage-name", `${i + 1}`));
      compactField(row, "dry t", s.dryMass / 1000, (v) => { s.dryMass = v * 1000; this.markCustom(); this.refresh(); });
      compactField(row, "prop t", s.propMass / 1000, (v) => { s.propMass = v * 1000; this.markCustom(); this.refresh(); });
      compactField(row, "Isp s", s.isp, (v) => { s.isp = Math.max(v, 1); this.markCustom(); this.refresh(); });
      compactField(row, "kN", s.thrust / 1000, (v) => { s.thrust = Math.max(v * 1000, 1); this.markCustom(); this.refresh(); });
      if (this.design.stages.length > 1) {
        const rm = button("✕", () => { this.design.stages.splice(i, 1); this.markCustom(); this.renderStages(); this.refresh(); });
        rm.className = "rm-btn";
        row.appendChild(rm);
      }
      block.appendChild(row);

      (s.boosters ?? []).forEach((bst, j) => {
        const brow = el("div", "stage-row booster-row");
        brow.appendChild(el("span", "stage-name", "↳"));
        compactField(brow, "×N", bst.count ?? 1, (v) => { bst.count = Math.max(1, Math.round(v)); this.markCustom(); this.refresh(); });
        compactField(brow, "dry t", bst.dryMass / 1000, (v) => { bst.dryMass = v * 1000; this.markCustom(); this.refresh(); });
        compactField(brow, "prop t", bst.propMass / 1000, (v) => { bst.propMass = v * 1000; this.markCustom(); this.refresh(); });
        compactField(brow, "Isp s", bst.isp, (v) => { bst.isp = Math.max(v, 1); this.markCustom(); this.refresh(); });
        compactField(brow, "kN", bst.thrust / 1000, (v) => { bst.thrust = Math.max(v * 1000, 1); this.markCustom(); this.refresh(); });
        const rm = button("✕", () => {
          s.boosters!.splice(j, 1);
          if (s.boosters!.length === 0) delete s.boosters;
          this.markCustom(); this.renderStages(); this.refresh();
        });
        rm.className = "rm-btn";
        brow.appendChild(rm);
        block.appendChild(brow);
      });

      const addB = button("+ booster", () => {
        (s.boosters ??= []).push({ name: "Booster", dryMass: 2000, propMass: 20000, isp: 280, thrust: 5e5, count: 2 });
        this.markCustom(); this.renderStages(); this.refresh();
      });
      addB.className = "add-booster";
      if (s.electric) setDisabled(addB, true, "Electric stages can't carry strap-on boosters.");
      else addB.title = "Add strap-on boosters that ignite with this stage and burn in parallel.";
      block.appendChild(addB);

      this.stagesEl.appendChild(block);
    });
  }

  /** Rebuild the right-column performance readout (rocket diagram + bars + gauge +
   *  masses + ascent feasibility). Cheap — only runs on user edits. */
  private refresh(): void {
    const b = deltaVBudget(this.design.stages, this.design.payloadMass);
    const twr = initialTWR(this.design.stages, this.design.payloadMass);
    this.perfEl.innerHTML = "";

    this.perfEl.appendChild(this.renderRocket());

    // Headline Δv + thrust-to-weight gauge, side by side.
    const hero = el("div", "yard-hero");
    const dvBox = el("div", "yard-dv");
    dvBox.append(el("div", "yard-dv-num", `${(b.total / 1000).toFixed(2)}`), el("div", "yard-dv-unit", "km/s total Δv"));
    hero.appendChild(dvBox);
    const g = radialGauge({ size: 76, label: "T/W liftoff" });
    g.set(Math.min(twr / 2, 1), { text: twr.toFixed(2), state: twr >= 1 ? "ok" : "warn" });
    hero.appendChild(g.root);
    this.perfEl.appendChild(hero);

    // Per-stage Δv bars (normalised to the strongest stage).
    const maxDv = Math.max(1, ...b.perStage);
    const bars = el("div", "yard-bars");
    b.perStage.forEach((dv, i) => {
      const rowEl = el("div", "yard-bar-row");
      rowEl.appendChild(el("span", "yard-bar-label", `S${i + 1}`));
      const track = el("div", "yard-bar-track");
      const fill = el("div", "yard-bar-fill");
      fill.style.width = `${((dv / maxDv) * 100).toFixed(1)}%`;
      track.appendChild(fill);
      rowEl.appendChild(track);
      rowEl.appendChild(el("span", "yard-bar-val", `${(dv / 1000).toFixed(2)}`));
      bars.appendChild(rowEl);
    });
    this.perfEl.appendChild(bars);

    // Masses + liftoff thrust.
    const first = this.design.stages[0];
    const hasBoosters = !!(first && first.boosters && first.boosters.length > 0);
    const stats = el("div", "yard-stats");
    stats.innerHTML =
      statRow("Wet mass", `${(b.wetMass / 1000).toFixed(1)} t`) +
      statRow("Final mass", `${(b.finalMass / 1000).toFixed(1)} t`) +
      (hasBoosters ? statRow("Liftoff thrust", `${(stageLiftoffThrust(first!) / 1000).toFixed(0)} kN`) : "") +
      statRow("Initial T/W", twr.toFixed(2) + (twr < 1 ? " · low" : ""));
    this.perfEl.appendChild(stats);

    // Ascent feasibility — always shown, and gates "Roll to Pad": you can only roll
    // out a design that can actually fly itself to orbit.
    const pv = ascentPreview(this.design);
    if (pv) {
      const asc = el("div", "yard-ascent");
      asc.innerHTML = statRow("Ascent to LEO", `${(pv.ascentDv / 1000).toFixed(2)} km/s`);
      const verdict = el("div", pv.reachesOrbit ? "yard-ok" : "yard-warn");
      verdict.textContent = pv.reachesOrbit
        ? `✓ reaches LEO — survivor ${(pv.survivorMass / 1000).toFixed(1)} t, ${(pv.survivorDv / 1000).toFixed(2)} km/s in orbit`
        : `✗ ${((pv.ascentDv - pv.stackDv) / 1000).toFixed(2)} km/s short of LEO — trim payload or lower the target orbit`;
      asc.appendChild(verdict);
      this.perfEl.appendChild(asc);
    }
    if (this.padBtn) setDisabled(this.padBtn, !pv?.reachesOrbit, "This design can't reach orbit from the pad — trim payload or lower the target orbit.");
  }

  /** A stacked rocket diagram: each stage a segment (height ∝ total mass), boosters
   *  as side pods, payload on top. Rebuilt on design change. */
  private renderRocket(): SVGSVGElement {
    const W = 200, H = 250, pad = 18;
    const s = svg("svg", { class: "yard-rocket", viewBox: `0 0 ${W} ${H}`, width: "100%" });
    const stages = this.design.stages;
    const stageMass = (i: number) => {
      const st = stages[i]!;
      const boost = (st.boosters ?? []).reduce((a, bz) => a + (bz.dryMass + bz.propMass) * (bz.count ?? 1), 0);
      return st.dryMass + st.propMass + boost;
    };
    const payload = this.design.payloadMass;
    let totalMass = payload;
    for (let i = 0; i < stages.length; i++) totalMass += stageMass(i);
    const usableH = H - 2 * pad;
    const minSeg = 14;
    // Provisional heights ∝ mass, then floor each at minSeg and renormalise to fit.
    const segs = stages.map((_, i) => stageMass(i));
    const rawHeights = segs.map((m) => (m / totalMass) * usableH);
    const payloadRaw = (payload / totalMass) * usableH;
    const heights = rawHeights.map((h) => Math.max(minSeg, h));
    const payloadH = Math.max(minSeg, payloadRaw);
    const sum = heights.reduce((a, h) => a + h, 0) + payloadH;
    const k = usableH / sum;
    const coreW = 54;
    const coreX = (W - coreW) / 2;
    let y = pad;

    // Payload nose on top.
    const ph = payloadH * k;
    const nose = svg("path", { d: `M ${W / 2} ${y} L ${coreX + coreW} ${y + ph} L ${coreX} ${y + ph} Z`, class: "yard-rk-payload" });
    nose.style.fill = "color-mix(in srgb, var(--info) 45%, var(--panel-bg))";
    nose.style.stroke = "var(--panel-border)";
    s.appendChild(nose);
    const plLabel = svg("text", { x: W / 2, y: y + ph - 3, class: "yard-rk-label", "text-anchor": "middle" });
    plLabel.textContent = "PAYLOAD";
    s.appendChild(plLabel);
    y += ph;

    // Stages top-to-bottom in DISPLAY order = reverse of firing order (last stage
    // sits just under the payload; the first stage / booster cluster is at the base).
    for (let i = stages.length - 1; i >= 0; i--) {
      const h = heights[i]! * k;
      const rect = svg("rect", { x: coreX, y, width: coreW, height: h, rx: 3, class: "yard-rk-stage" });
      const tint = Math.max(20, 68 - i * 14);
      rect.style.fill = `color-mix(in srgb, var(--accent) ${tint}%, var(--panel-bg))`;
      rect.style.stroke = "var(--panel-border)";
      s.appendChild(rect);
      const lab = svg("text", { x: W / 2, y: y + h / 2 + 3, class: "yard-rk-label", "text-anchor": "middle" });
      lab.textContent = `S${i + 1}`;
      s.appendChild(lab);

      // Strap-on boosters: pods flanking this stage.
      const boosters = stages[i]!.boosters ?? [];
      if (boosters.length > 0) {
        const bst = boosters[0]!;
        const podW = 16;
        const podH = Math.min(h * 1.05, h + 10);
        const podY = y + h - podH;
        for (const side of [-1, 1]) {
          const px = side < 0 ? coreX - podW - 2 : coreX + coreW + 2;
          const pod = svg("rect", { x: px, y: podY, width: podW, height: podH, rx: 3, class: "yard-rk-booster" });
          pod.style.fill = "color-mix(in srgb, var(--warn) 42%, var(--panel-bg))";
          pod.style.stroke = "var(--panel-border)";
          s.appendChild(pod);
        }
        const cnt = svg("text", { x: coreX + coreW + 2 + 8, y: podY - 3, class: "yard-rk-mini", "text-anchor": "middle" });
        cnt.textContent = `×${bst.count ?? 1}`;
        s.appendChild(cnt);
      }
      y += h;
    }
    return s;
  }

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
    sel.onchange = () => { if (sel.value) this.loadPreset(sel.value); else this.clearCaption(); };
    return sel;
  }

  private loadPreset(id: string): void {
    const preset = PRESETS_BY_ID.get(id);
    if (!preset) return;
    this.design = presetToDesign(preset);
    this.nameInput.value = this.design.name;
    this.payloadInput.value = String(this.design.payloadMass / 1000);
    this.altInput.value = String(this.design.altitudeKm);
    this.inclInput.value = String(this.design.inclinationDeg);
    this.renderStages();
    this.renderLaunchArea();
    this.refresh();
    this.showCaption(preset);
  }

  private showCaption(p: ShipPreset): void {
    const role = p.role === "launcher" ? "launch vehicle" : "in-space craft";
    this.presetCaption.innerHTML =
      `<span class="preset-meta">${p.category} · ${p.era} · ${role}</span>` +
      `<span class="preset-blurb">${p.blurb}</span>`;
  }

  private clearCaption(): void { this.presetCaption.innerHTML = ""; }

  private markCustom(): void {
    if (this.presetSelect.value !== "") { this.presetSelect.value = ""; this.clearCaption(); }
  }

  private renderLaunchArea(): void {
    this.launchArea.innerHTML = "";
    // Two paths, always offered: stand it on the pad and fly the ascent yourself,
    // or place it directly in a parking orbit. "Roll to Pad" is gated by ascent
    // feasibility (set in refresh()); "Construct In LEO" always works.
    this.padBtn = button("Roll to Pad", () => this.finishLaunch(spawnOnPad(this.sim, this.design)));
    this.padBtn.className = "wide-btn";
    this.padBtn.title = "Stand this vehicle on the Earth pad; fly the ascent with Launch in the flight console.";
    const construct = button("Construct In LEO", () => this.finishLaunch(spawnShip(this.sim, this.design)));
    construct.className = "wide-btn primary";
    construct.title = "Place this craft directly in a circular low orbit, fully fuelled.";
    this.launchArea.append(this.padBtn, construct);
  }

  /** Hand the new ship to the flight console and leave the Shipyard. */
  private finishLaunch(id: string): void {
    this.close();
    this.onLaunched(id);
  }
}

/** A small static label/value row for the performance readout (not per-frame). */
function statRow(k: string, v: string): string {
  return `<div class="ins-row"><span class="ins-row-k">${k}</span><span class="ins-row-v">${v}</span></div>`;
}
