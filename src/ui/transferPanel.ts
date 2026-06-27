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

import { type Simulation } from "../core/sim.ts";
import { type SceneManager } from "../render/SceneManager.ts";
import { type TrajectoryViews } from "../render/trajectoryViews.ts";
import { computePorkchop, type Porkchop, type PorkCell } from "../core/maneuver/porkchop.ts";
import { type AssistResult, type ChainAssistResult } from "../core/maneuver/assist.ts";
import { type Criterion } from "../core/maneuver/criteria.ts";
import {
  suggestRoutes, transferWindow, bestAssist, bestChain, bestPorkCell, type SuggestedRoute,
} from "../core/maneuver/suggest.ts";
import { planTransfer, planAssist, planChainAssist, aerocapturePreview } from "../app/commands.ts";
import { dvRemaining, shipWorldState, shipOsculatingElements } from "../core/ships.ts";
import { periapsisRadius } from "../core/orbit.ts";
import { formatDate } from "../core/time.ts";
import { type BodyDef, type BodyKind, BODIES, BODY_BY_ID, DAY, DEFAULT_CAPTURE_ALT } from "../core/constants.ts";
import { div, btn, kv, setDisabled } from "./dom.ts";

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
  private modeBtns: Partial<Record<RouteMode, HTMLButtonElement>> = {};

  private captureMode: "propulsive" | "aerocapture" = "propulsive";
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

  /** Can the ship reach this moon? Same-parent moons fly in Phase B; cross-parent moons
   *  need a two-stage mission (Phase C). Until those land, moons are shown but disabled. */
  private moonEligible(_moon: BodyDef): Eligible {
    return { show: true, enabled: false, note: "(transfer to its planet first)" };
  }

  private destEligible = (b: BodyDef): Eligible => {
    const origin = this.originId();
    if (b.id === origin || b.id === "sun") return { show: false, enabled: false };
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
    this.fillSelect(this.viaSel, "— pick a flyby —", this.flybyEligible(this.via2Id), this.viaId);
    this.fillSelect(this.via2Sel, "— pick a flyby —", this.flybyEligible(this.viaId), this.via2Id);
    this.originEl.textContent = `From: ${this.originId() === "earth" && (!this.shipId || this.sim.world.ships.get(this.shipId!)?.primary === "sun")
      ? "Earth (heliocentric)" : BODY_BY_ID.get(this.originId())?.name ?? "—"}`;
  }

  private firstEnabledDestination(): string {
    for (const g of GROUPS) for (const b of BODIES) if (b.kind === g.kind && this.destEligible(b).enabled) return b.id;
    return "mars";
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
    const modeRow = div("transfer-modes");
    for (const [m, label] of [["direct", "Direct"], ["suggest", "Suggest"], ["via1", "1 flyby"], ["via2", "2 flybys"]] as const) {
      const b = btn(label, () => this.setRouteMode(m));
      this.modeBtns[m] = b;
      modeRow.appendChild(b);
    }
    this.panel.appendChild(modeRow);

    // Flyby pickers (shown only in via1/via2).
    this.viaRow = div("transfer-head");
    this.viaRow.appendChild(div("section-label", "VIA FLYBY"));
    this.viaSel = document.createElement("select");
    this.viaSel.className = "target-sel";
    this.viaSel.onchange = () => { this.viaId = this.viaSel.value; this.refreshSelects(); this.recompute(); };
    this.viaRow.appendChild(this.viaSel);
    this.panel.appendChild(this.viaRow);

    this.via2Row = div("transfer-head");
    this.via2Row.appendChild(div("section-label", "VIA FLYBY 2"));
    this.via2Sel = document.createElement("select");
    this.via2Sel.className = "target-sel";
    this.via2Sel.onchange = () => { this.via2Id = this.via2Sel.value; this.refreshSelects(); this.recompute(); };
    this.via2Row.appendChild(this.via2Sel);
    this.panel.appendChild(this.via2Row);

    // Optimize for — drives the porkchop crosshair and the assist/suggest ranking.
    const critRow = div("transfer-head");
    critRow.appendChild(div("section-label", "OPTIMIZE FOR"));
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

    // Capture mode (direct arrivals at a body with an atmosphere).
    this.capRow = div("transfer-head");
    this.capRow.appendChild(div("section-label", "CAPTURE MODE"));
    this.captureSel = document.createElement("select");
    this.captureSel.className = "target-sel";
    for (const [val, label] of [["propulsive", "Propulsive (burn)"], ["aerocapture", "Aerocapture (drag pass)"]] as const) {
      const o = document.createElement("option");
      o.value = val; o.textContent = label;
      this.captureSel.appendChild(o);
    }
    this.captureSel.onchange = () => { this.captureMode = this.captureSel.value as "propulsive" | "aerocapture"; this.updateReadout(); this.updatePreview(); };
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
    this.viaRow.style.display = m === "via1" || m === "via2" ? "flex" : "none";
    this.via2Row.style.display = m === "via2" ? "flex" : "none";
    this.suggestEl.style.display = m === "suggest" ? "block" : "none";
    this.canvas.style.display = m === "suggest" ? "none" : "block";
    this.refreshSelects();
    this.recompute();
  }

  // ── Preview ──────────────────────────────────────────────────────────────────

  private updatePreview(): void {
    const ship = this.shipId ? this.sim.world.ships.get(this.shipId) : undefined;
    if (!ship) { this.traj.setPreviewRoute(null); return; }
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
    const rParkTo = BODY_BY_ID.get(this.targetId)!.radius + DEFAULT_CAPTURE_ALT;
    return { rParkFrom, rParkTo };
  }

  private recompute(): void {
    if (!this.shipId || !this.sim.world.ships.get(this.shipId)) return;
    const t0 = this.sim.world.t;
    const fromId = this.originId();
    const { rParkFrom, rParkTo } = this.parkRadii();
    const win = transferWindow(fromId, this.targetId, t0);

    // The porkchop underpins Direct and Via modes (and the Suggest list's Direct option).
    this.pork = computePorkchop({
      fromId, toId: this.targetId, depStart: t0, depEnd: t0 + win.depSpan, depN: 64,
      tofMin: win.tofMin, tofMax: win.tofMax, tofN: 48, rParkFrom, rParkTo,
    });
    this.assist = null;
    this.chain = null;
    this.suggestions = [];

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
      ctx.strokeStyle = "#4fd1e0";
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

  private updateReadout(): void {
    const ship = this.shipId ? this.sim.world.ships.get(this.shipId) : undefined;

    // Capture mode is a direct-arrival option at a body with an atmosphere only.
    const hasAtm = !!BODY_BY_ID.get(this.targetId)?.atmosphere;
    this.captureSel.disabled = !hasAtm || this.routeMode !== "direct";
    this.capRow.style.display = this.routeMode === "direct" ? "flex" : "none";
    if (this.captureSel.disabled && this.captureMode === "aerocapture") {
      this.captureMode = "propulsive"; this.captureSel.value = "propulsive";
    }

    if (this.routeMode === "suggest") return; // the list is the readout

    const optLine = kv("Optimizing", this.criterionLabel());

    if (this.chain && ship) {
      const r = this.chain.result;
      const haveDv = dvRemaining(ship);
      const need = r.dvDepart + r.dvFlybyTotal;
      const feasible = need <= haveDv;
      const names = r.flybys.map((f) => BODY_BY_ID.get(f.bodyId)!.name).join(" → ");
      this.axisEl.innerHTML = `<span>gravity-assist chain via ${names}</span>`;
      this.readout.innerHTML =
        optLine +
        kv("Depart", formatDate(r.tDepart)) +
        r.flybys.map((f) => kv(`Flyby ${BODY_BY_ID.get(f.bodyId)!.name}`,
          `${formatDate(f.t)} · ${(f.dvFlyby / 1000).toFixed(3)} km/s${f.unpowered ? " (free)" : ""}`)).join("") +
        kv("Arrive", formatDate(r.tArrive)) +
        kv("Flight time", `${((r.tArrive - r.tDepart) / DAY).toFixed(0)} days`) +
        kv("Injection Δv", `${(r.dvDepart / 1000).toFixed(3)} km/s`) +
        kv("Flyby Δv (total)", `${(r.dvFlybyTotal / 1000).toFixed(3)} km/s${r.unpowered ? " (all free)" : ""}`) +
        kv("Capture Δv", `${(r.dvArrive / 1000).toFixed(3)} km/s`) +
        kv("Total Δv", `${(r.dvTotal / 1000).toFixed(3)} km/s`) +
        (feasible ? `<div class="ok">✓ injection + flybys within budget</div>` : `<div class="warn">✗ exceeds Δv budget</div>`);
      setDisabled(this.commitBtn, !feasible, "Injection + flyby Δv exceeds the ship's budget.");
      return;
    }

    if (this.routeMode === "via2" && ship && !this.chain) {
      this.readout.innerHTML = optLine + "No usable two-flyby chain in range — try different via bodies.";
      setDisabled(this.commitBtn, true, "No usable gravity-assist chain in range.");
      return;
    }

    if (this.viaId && ship) {
      const a = this.assist;
      if (!a) {
        this.readout.innerHTML = optLine + `No usable ${BODY_BY_ID.get(this.viaId)?.name ?? this.viaId} assist in range.`;
        setDisabled(this.commitBtn, true, "No usable gravity-assist solution in range.");
        return;
      }
      const haveDv = dvRemaining(ship);
      const need = a.dvDepart + a.dvFlyby;
      const feasible = need <= haveDv;
      const directBest = this.pork ? bestPorkCell(this.pork, "dv")?.total : undefined;
      this.axisEl.innerHTML = `<span>gravity assist via ${BODY_BY_ID.get(this.viaId)!.name}</span>`;
      this.readout.innerHTML =
        optLine +
        kv("Depart", formatDate(a.tDepart)) +
        kv(`Flyby ${BODY_BY_ID.get(this.viaId)!.name}`, `${formatDate(a.tFlyby)} · ${(a.flybyRadius / 1000).toFixed(0)} km, turn ${((a.turnRequired * 180) / Math.PI).toFixed(0)}°`) +
        kv("Arrive", formatDate(a.tArrive)) +
        kv("Flight time", `${((a.tArrive - a.tDepart) / DAY).toFixed(0)} days`) +
        kv("Injection Δv", `${(a.dvDepart / 1000).toFixed(3)} km/s`) +
        kv("Flyby Δv", `${(a.dvFlyby / 1000).toFixed(3)} km/s${a.unpowered ? " (free)" : ""}`) +
        kv("Capture Δv", `${(a.dvArrive / 1000).toFixed(3)} km/s`) +
        kv("Total Δv", `${(a.dvTotal / 1000).toFixed(3)} km/s`) +
        (directBest ? kv("Direct best Δv", `${(directBest / 1000).toFixed(3)} km/s`) : "") +
        (feasible ? `<div class="ok">✓ injection + flyby within budget</div>` : `<div class="warn">✗ exceeds Δv budget</div>`);
      setDisabled(this.commitBtn, !feasible, "Injection + flyby Δv exceeds the ship's budget.");
      return;
    }

    const cell = this.selectedCell();
    if (!cell || !ship || !isFinite(cell.total)) {
      this.readout.innerHTML = optLine + "No solution for this cell.";
      setDisabled(this.commitBtn, true, "No transfer solution for this cell — pick another or use the optimum.");
      return;
    }
    const haveDv = dvRemaining(ship);
    const target = BODY_BY_ID.get(this.targetId);
    const fromId = this.originId();
    this.axisEl.innerHTML = `<span>↑ flight time &nbsp; → departure date</span>`;
    const dvMin = this.pork ? bestPorkCell(this.pork, "dv") : null;
    const trade = this.criterion !== "dv" && dvMin
      ? kv("Min-Δv flight time", `${(dvMin.tof / DAY).toFixed(0)} days @ ${(dvMin.total / 1000).toFixed(2)} km/s`) : "";

    const aero = this.captureMode === "aerocapture" && target?.atmosphere
      ? aerocapturePreview(this.targetId, fromId, cell.depT, cell.arrT) : null;
    if (this.captureMode === "aerocapture" && target?.atmosphere) {
      const feasible = aero != null && aero.feasible && cell.dvDepart <= haveDv;
      this.readout.innerHTML =
        optLine +
        kv("Depart", formatDate(cell.depT)) + kv("Arrive", formatDate(cell.arrT)) +
        kv("Flight time", `${(cell.tof / DAY).toFixed(0)} days`) + trade +
        kv("Injection Δv", `${(cell.dvDepart / 1000).toFixed(3)} km/s`) +
        kv("Capture", aero?.feasible ? "aerocapture — drag pass" : "aerocapture not possible") +
        (aero?.feasible ? kv("Arrival trim Δv", `${(aero.trimDv / 1000).toFixed(3)} km/s`) : "") +
        (aero ? kv("Saved vs propulsive", `${(aero.propulsiveDv / 1000).toFixed(3)} km/s`) : "") +
        (feasible ? `<div class="ok">✓ injection within budget — atmosphere does the braking</div>`
          : aero && !aero.feasible ? `<div class="warn">✗ arrival too fast to aerocapture here</div>`
          : `<div class="warn">✗ injection exceeds Δv budget</div>`);
      setDisabled(this.commitBtn, !feasible, "Aerocapture infeasible or injection exceeds budget.");
      return;
    }

    const feasible = cell.dvDepart <= haveDv;
    this.readout.innerHTML =
      optLine +
      kv("Depart", formatDate(cell.depT)) + kv("Arrive", formatDate(cell.arrT)) +
      kv("Flight time", `${(cell.tof / DAY).toFixed(0)} days`) + trade +
      kv("Injection Δv", `${(cell.dvDepart / 1000).toFixed(3)} km/s`) +
      kv("Arrival (capture) Δv", `${(cell.dvArrive / 1000).toFixed(3)} km/s`) +
      kv("Total Δv", `${(cell.total / 1000).toFixed(3)} km/s`) +
      kv("Ship Δv available", `${(haveDv / 1000).toFixed(2)} km/s`) +
      (feasible ? `<div class="ok">✓ injection within budget</div>` : `<div class="warn">✗ injection exceeds Δv budget</div>`);
    setDisabled(this.commitBtn, !feasible, "Injection Δv exceeds the ship's budget.");
  }

  private commit(): void {
    if (!this.shipId) return;
    if (this.chain) {
      if (!planChainAssist(this.sim, this.shipId, this.chain.bodyIds, this.chain.times)) return;
      this.focusAndClose();
      return;
    }
    if (this.viaId && this.assist) {
      const a = this.assist;
      if (!planAssist(this.sim, this.shipId, this.viaId, this.targetId, a.tDepart, a.tFlyby, a.tArrive)) return;
      this.focusAndClose();
      return;
    }
    const cell = this.selectedCell();
    if (!cell) return;
    const target = BODY_BY_ID.get(this.targetId);
    const mode = this.captureMode === "aerocapture" && target?.atmosphere ? "aerocapture" : "propulsive";
    if (!planTransfer(this.sim, this.shipId, this.targetId, cell.depT, cell.arrT, mode)) return;
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
