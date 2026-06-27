/**
 * The transfer planner: a porkchop plot for choosing a real launch window.
 *
 * The canvas sweeps departure date (x) against time-of-flight (y); each pixel is
 * a Lambert solution coloured by total Δv. The blue low-Δv island IS the launch
 * window — it isn't a rule we impose, it falls out of where the planets are.
 * Click a cell (or take the optimum), see the true injection and arrival Δv and
 * the months-long flight time, and commit — the departure is then scheduled and
 * fires when the clock reaches it.
 */

import { type Simulation } from "../core/sim.ts";
import { type SceneManager } from "../render/SceneManager.ts";
import { type TrajectoryViews } from "../render/trajectoryViews.ts";
import { computePorkchop, type Porkchop, type PorkCell } from "../core/maneuver/porkchop.ts";
import { hohmann, synodicPeriod } from "../core/maneuver/hohmann.ts";
import { searchAssist, searchChain, type AssistResult, type ChainAssistResult } from "../core/maneuver/assist.ts";
import { planTransfer, planAssist, planChainAssist, aerocapturePreview } from "../app/commands.ts";
import { dvRemaining, shipWorldState, shipOsculatingElements } from "../core/ships.ts";
import { periapsisRadius, orbitalPeriod } from "../core/orbit.ts";
import { bodyElements } from "../core/ephemeris.ts";
import { formatDate } from "../core/time.ts";
import { BODIES, BODY_BY_ID, DAY, MU_SUN, DEFAULT_CAPTURE_ALT } from "../core/constants.ts";
import { div, btn, kv, setDisabled } from "./dom.ts";

/** Every heliocentric body (planets, dwarfs, asteroids) is a valid destination;
 *  the porkchop solves any of them. Ordered by distance from the Sun. */
const TARGETS = BODIES.filter((b) => b.parent === "sun" && b.id !== "earth")
  .sort((a, b) => (bodyElements(a, 0)?.a ?? 0) - (bodyElements(b, 0)?.a ?? 0))
  .map((b) => b.id);
const CANVAS_W = 300;
const CANVAS_H = 210;

export class TransferPanel {
  private panel!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private readout!: HTMLElement;
  private commitBtn!: HTMLButtonElement;
  private targetSel!: HTMLSelectElement;
  private axisEl!: HTMLElement;

  private viaSel!: HTMLSelectElement;
  private via2Sel!: HTMLSelectElement;
  private captureSel!: HTMLSelectElement;
  private captureMode: "propulsive" | "aerocapture" = "propulsive";
  private shipId: string | null = null;
  private targetId = "mars";
  private viaId = ""; // "" = direct; otherwise the first flyby body id
  private via2Id = ""; // "" = single flyby; otherwise a second flyby body id (a chain)
  private assist: AssistResult | null = null;
  private chain: { result: ChainAssistResult; times: number[]; bodyIds: string[] } | null = null;
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

  private build(): void {
    this.panel = div("panel transfer-panel");
    this.panel.style.display = "none";

    const head = div("transfer-head");
    head.appendChild(div("panel-title", "TRANSFER PLANNER"));
    this.targetSel = document.createElement("select");
    this.targetSel.className = "target-sel";
    for (const id of TARGETS) {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = BODY_BY_ID.get(id)!.name;
      this.targetSel.appendChild(o);
    }
    this.targetSel.value = this.targetId;
    this.targetSel.onchange = () => {
      this.targetId = this.targetSel.value;
      this.recompute();
    };
    head.appendChild(this.targetSel);
    this.panel.appendChild(head);

    // Optional gravity-assist flyby body. "Direct" = no assist.
    const viaRow = div("transfer-head");
    viaRow.appendChild(div("section-label", "VIA FLYBY"));
    this.viaSel = document.createElement("select");
    this.viaSel.className = "target-sel";
    const none = document.createElement("option");
    none.value = ""; none.textContent = "— Direct (no assist) —";
    this.viaSel.appendChild(none);
    for (const id of TARGETS) {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = BODY_BY_ID.get(id)!.name;
      this.viaSel.appendChild(o);
    }
    this.viaSel.onchange = () => { this.viaId = this.viaSel.value; this.recompute(); };
    viaRow.appendChild(this.viaSel);
    this.panel.appendChild(viaRow);

    // Optional SECOND flyby body — turns the assist into a chain (origin → via → via2 →
    // target). "—" = single flyby.
    const via2Row = div("transfer-head");
    via2Row.appendChild(div("section-label", "VIA FLYBY 2"));
    this.via2Sel = document.createElement("select");
    this.via2Sel.className = "target-sel";
    const none2 = document.createElement("option");
    none2.value = ""; none2.textContent = "— Single flyby —";
    this.via2Sel.appendChild(none2);
    for (const id of TARGETS) {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = BODY_BY_ID.get(id)!.name;
      this.via2Sel.appendChild(o);
    }
    this.via2Sel.onchange = () => { this.via2Id = this.via2Sel.value; this.recompute(); };
    via2Row.appendChild(this.via2Sel);
    this.panel.appendChild(via2Row);

    // Capture mode for a DIRECT arrival: a propulsive burn, or an atmospheric drag pass
    // (aerocapture) that captures for only a small periapsis-raise trim.
    const capRow = div("transfer-head");
    capRow.appendChild(div("section-label", "CAPTURE MODE"));
    this.captureSel = document.createElement("select");
    this.captureSel.className = "target-sel";
    for (const [val, label] of [["propulsive", "Propulsive (burn)"], ["aerocapture", "Aerocapture (drag pass)"]] as const) {
      const o = document.createElement("option");
      o.value = val; o.textContent = label;
      this.captureSel.appendChild(o);
    }
    this.captureSel.onchange = () => { this.captureMode = this.captureSel.value as "propulsive" | "aerocapture"; this.updateReadout(); this.updatePreview(); };
    capRow.appendChild(this.captureSel);
    this.panel.appendChild(capRow);

    this.canvas = document.createElement("canvas");
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.canvas.className = "porkchop";
    this.canvas.onclick = (e) => this.onCanvasClick(e);
    this.panel.appendChild(this.canvas);

    this.axisEl = div("pork-axis");
    this.panel.appendChild(this.axisEl);

    this.readout = div("transfer-readout");
    this.panel.appendChild(this.readout);

    const btns = div("transfer-btns");
    const opt = btn("Use optimum", () => this.selectBest());
    opt.title = "Jump to the lowest-Δv departure/arrival in the porkchop.";
    this.commitBtn = btn("Commit transfer", () => this.commit());
    this.commitBtn.className = "primary";
    const close = btn("Close", () => this.close());
    btns.append(opt, this.commitBtn, close);
    this.panel.appendChild(btns);

    this.root.appendChild(this.panel);
  }

  open(shipId: string): void {
    this.shipId = shipId;
    this.panel.style.display = "flex";
    this.recompute();
  }

  isOpen(): boolean {
    return this.panel.style.display !== "none";
  }

  close(): void {
    this.panel.style.display = "none";
    this.traj.setPreviewRoute(null); // tear down the preview ghost route
  }

  /** Feed the renderer a ghost preview of the currently selected window (the
   *  whole planned path), or clear it. Recomputed on every selection change. */
  private updatePreview(): void {
    const ship = this.shipId ? this.sim.world.ships.get(this.shipId) : undefined;
    if (!ship) {
      this.traj.setPreviewRoute(null);
      return;
    }
    const fromId = ship.primary === "sun" ? "earth" : ship.primary;
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
    if (!cell || !isFinite(cell.total)) {
      this.traj.setPreviewRoute(null);
      return;
    }
    this.traj.setPreviewRoute({
      fromId, targetId: this.targetId, tDepart: cell.depT, tArrive: cell.arrT, rParkFrom, rParkTo,
    });
  }

  private recompute(): void {
    if (!this.shipId) return;
    const ship = this.sim.world.ships.get(this.shipId);
    if (!ship) return;
    const t0 = this.sim.world.t;
    const fromId = ship.primary === "sun" ? "earth" : ship.primary;
    const rParkFrom =
      ship.primary === "sun"
        ? BODY_BY_ID.get("earth")!.radius + DEFAULT_CAPTURE_ALT
        : periapsisRadius(shipOsculatingElements(ship, t0).a, shipOsculatingElements(ship, t0).e);
    const rParkTo = BODY_BY_ID.get(this.targetId)!.radius + DEFAULT_CAPTURE_ALT;

    // Scale the search grid to the target's transfer so distant bodies (the
    // giants, the dwarf planets) get a usable window instead of the inner-planet
    // 80–400 day box. The Hohmann time-of-flight sets the tof span; the synodic
    // period sets how far ahead to look for the next departure window.
    const aFrom = bodyElements(BODY_BY_ID.get(fromId)!, t0)?.a ?? BODY_BY_ID.get("earth")!.radius;
    const aTo = bodyElements(BODY_BY_ID.get(this.targetId)!, t0)?.a ?? aFrom;
    const hTof = hohmann(MU_SUN, aFrom, aTo).tof;
    const synodic = synodicPeriod(orbitalPeriod(aFrom, MU_SUN), orbitalPeriod(aTo, MU_SUN));
    const depSpan = Math.min(Math.max(1.3 * synodic, 500 * DAY), 8000 * DAY);
    const tofMin = Math.max(20 * DAY, 0.3 * hTof);
    const tofMax = 1.9 * hTof;

    this.pork = computePorkchop({
      fromId,
      toId: this.targetId,
      depStart: t0,
      depEnd: t0 + depSpan,
      depN: 64,
      tofMin,
      tofMax,
      tofN: 48,
      rParkFrom,
      rParkTo,
    });

    // Two-flyby CHAIN search (when a second via body is chosen): scan a few
    // departure dates, grid each leg's time-of-flight, keep the cheapest chain.
    this.assist = null;
    this.chain = null;
    const distinct = new Set([fromId, this.viaId, this.via2Id, this.targetId]);
    if (this.viaId && this.via2Id && distinct.size === 4) {
      const bodyIds = [fromId, this.viaId, this.via2Id, this.targetId];
      let best: { result: ChainAssistResult; times: number[] } | null = null;
      for (let k = 0; k < 8; k++) {
        const tDep = t0 + (depSpan * k) / 7;
        const r = searchChain(bodyIds, { tDepart: tDep, rParkFrom, rParkTo, steps: 7 });
        if (r && (!best || r.result.dvTotal < best.result.dvTotal)) best = r;
      }
      this.chain = best ? { ...best, bodyIds } : null;
      this.selectBest();
      return;
    }

    // Single gravity-assist search (when one flyby body is chosen): scan a few
    // departure dates, and for each grid the flyby/arrival times, keeping the cheapest.
    if (this.viaId && this.viaId !== this.targetId && this.viaId !== fromId) {
      const aFly = bodyElements(BODY_BY_ID.get(this.viaId)!, t0)?.a ?? aFrom;
      const tofToFly = hohmann(MU_SUN, aFrom, aFly).tof;
      const tofFlyToTgt = hohmann(MU_SUN, aFly, aTo).tof;
      let best: AssistResult | null = null;
      for (let k = 0; k < 8; k++) {
        const tDep = t0 + (depSpan * k) / 7;
        const r = searchAssist(fromId, this.viaId, this.targetId, {
          tDepart: tDep,
          flybyWindow: [tDep + 0.6 * tofToFly, tDep + 1.6 * tofToFly],
          arriveWindow: [tDep + 0.6 * tofToFly + 0.5 * tofFlyToTgt, tDep + 1.6 * tofToFly + 2.2 * tofFlyToTgt],
          rParkFrom,
          rParkTo,
          steps: 16,
        });
        if (r && (!best || r.dvTotal < best.dvTotal)) best = r;
      }
      this.assist = best;
    }
    this.selectBest();
  }

  private selectBest(): void {
    if (!this.pork || !this.pork.best) {
      this.draw();
      if (this.viaId) { this.updateReadout(); this.updatePreview(); return; } // assist mode draws its own readout
      this.readout.textContent = "No transfer solution in range.";
      this.traj.setPreviewRoute(null);
      return;
    }
    const b = this.pork.best;
    this.selI = Math.round((b.depT - this.pork.depStart) / this.pork.depStep);
    this.selJ = Math.round((b.tof - this.pork.tofStart) / this.pork.tofStep);
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
    const j = this.pork.tofN - 1 - jFromTop; // tof increases upward
    if (i < 0 || i >= this.pork.depN || j < 0 || j >= this.pork.tofN) return;
    this.selI = i;
    this.selJ = j;
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

    // Colour scale: best..~2.2× best across the blue→red ramp.
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

    // Best (white ring) and selection (crosshair).
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

  private updateReadout(): void {
    const ship = this.shipId ? this.sim.world.ships.get(this.shipId) : undefined;

    // Aerocapture is a direct-arrival option at a body with an atmosphere only.
    const hasAtm = !!BODY_BY_ID.get(this.targetId)?.atmosphere;
    this.captureSel.disabled = !hasAtm || !!this.viaId;
    if (this.captureSel.disabled && this.captureMode === "aerocapture") {
      this.captureMode = "propulsive";
      this.captureSel.value = "propulsive";
    }

    // Chain mode: show the multi-flyby ledger (per-leg Δv) and compare to direct.
    if (this.chain && ship) {
      const r = this.chain.result;
      const haveDv = dvRemaining(ship);
      const need = r.dvDepart + r.dvFlybyTotal; // injection + every flyby residual
      const feasible = need <= haveDv;
      const directBest = this.pork?.best?.total;
      const names = r.flybys.map((f) => BODY_BY_ID.get(f.bodyId)!.name).join(" → ");
      this.axisEl.innerHTML = `<span>gravity-assist chain via ${names}</span>`;
      this.readout.innerHTML =
        kv("Depart", formatDate(r.tDepart)) +
        r.flybys.map((f) =>
          kv(`Flyby ${BODY_BY_ID.get(f.bodyId)!.name}`,
            `${formatDate(f.t)} · turn ${((f.turnRequired * 180) / Math.PI).toFixed(0)}° · ${(f.dvFlyby / 1000).toFixed(3)} km/s${f.unpowered ? " (free)" : ""}`),
        ).join("") +
        kv("Arrive", formatDate(r.tArrive)) +
        kv("Injection Δv", `${(r.dvDepart / 1000).toFixed(3)} km/s`) +
        kv("Flyby Δv (total)", `${(r.dvFlybyTotal / 1000).toFixed(3)} km/s${r.unpowered ? " (all free)" : ""}`) +
        kv("Capture Δv", `${(r.dvArrive / 1000).toFixed(3)} km/s`) +
        kv("Total Δv", `${(r.dvTotal / 1000).toFixed(3)} km/s`) +
        (directBest ? kv("Direct best Δv", `${(directBest / 1000).toFixed(3)} km/s`) : "") +
        (feasible
          ? `<div class="ok">✓ injection + flybys within budget</div>`
          : `<div class="warn">✗ exceeds Δv budget</div>`);
      setDisabled(this.commitBtn, !feasible, "Injection + flyby Δv exceeds the ship's budget.");
      return;
    }

    // Chain requested but no feasible schedule found.
    if (this.via2Id && ship && !this.chain) {
      this.readout.innerHTML = "No usable two-flyby chain in range — try different via bodies.";
      setDisabled(this.commitBtn, true, "No usable gravity-assist chain in range.");
      return;
    }

    // Gravity-assist mode: show the assisted plan and compare to the direct best.
    if (this.viaId && ship) {
      const a = this.assist;
      if (!a) {
        this.readout.innerHTML = `No usable ${BODY_BY_ID.get(this.viaId)?.name ?? this.viaId} assist in range.`;
        setDisabled(this.commitBtn, true, "No usable gravity-assist solution in range.");
        return;
      }
      const haveDv = dvRemaining(ship);
      const need = a.dvDepart + a.dvFlyby; // the ship must afford injection + flyby burn
      const feasible = need <= haveDv;
      const directBest = this.pork?.best?.total;
      this.axisEl.innerHTML = `<span>gravity assist via ${BODY_BY_ID.get(this.viaId)!.name}</span>`;
      this.readout.innerHTML =
        kv("Depart", formatDate(a.tDepart)) +
        kv(`Flyby ${BODY_BY_ID.get(this.viaId)!.name}`, `${formatDate(a.tFlyby)} · ${(a.flybyRadius / 1000).toFixed(0)} km, turn ${((a.turnRequired * 180) / Math.PI).toFixed(0)}°`) +
        kv("Arrive", formatDate(a.tArrive)) +
        kv("Injection Δv", `${(a.dvDepart / 1000).toFixed(3)} km/s`) +
        kv("Flyby Δv", `${(a.dvFlyby / 1000).toFixed(3)} km/s${a.unpowered ? " (free)" : ""}`) +
        kv("Capture Δv", `${(a.dvArrive / 1000).toFixed(3)} km/s`) +
        kv("Total Δv", `${(a.dvTotal / 1000).toFixed(3)} km/s`) +
        (directBest ? kv("Direct best Δv", `${(directBest / 1000).toFixed(3)} km/s`) : "") +
        (feasible
          ? `<div class="ok">✓ injection + flyby within budget</div>`
          : `<div class="warn">✗ exceeds Δv budget</div>`);
      setDisabled(this.commitBtn, !feasible, "Injection + flyby Δv exceeds the ship's budget.");
      return;
    }

    const cell = this.selectedCell();
    if (!cell || !ship || !isFinite(cell.total)) {
      this.readout.textContent = "No solution for this cell.";
      setDisabled(this.commitBtn, true, "No transfer solution for this cell — pick another or use the optimum.");
      return;
    }
    const haveDv = dvRemaining(ship);
    const target = BODY_BY_ID.get(this.targetId);
    const fromId = ship.primary === "sun" ? "earth" : ship.primary;
    this.axisEl.innerHTML = `<span>↑ flight time &nbsp; → departure date</span>`;

    // Aerocapture mode (direct arrival at a body with an atmosphere): the drag pass
    // replaces the propulsive capture for a small trim, so only the injection must fit.
    const aero = this.captureMode === "aerocapture" && target?.atmosphere
      ? aerocapturePreview(this.targetId, fromId, cell.depT, cell.arrT) : null;
    if (this.captureMode === "aerocapture" && target?.atmosphere) {
      const feasible = aero != null && aero.feasible && cell.dvDepart <= haveDv;
      this.readout.innerHTML =
        kv("Depart", formatDate(cell.depT)) +
        kv("Arrive", formatDate(cell.arrT)) +
        kv("Flight time", `${(cell.tof / DAY).toFixed(0)} days`) +
        kv("Injection Δv", `${(cell.dvDepart / 1000).toFixed(3)} km/s`) +
        kv("Capture", aero?.feasible ? "aerocapture — drag pass" : "aerocapture not possible") +
        (aero?.feasible ? kv("Arrival trim Δv", `${(aero.trimDv / 1000).toFixed(3)} km/s`) : "") +
        (aero ? kv("Saved vs propulsive", `${(aero.propulsiveDv / 1000).toFixed(3)} km/s`) : "") +
        kv("Ship Δv available", `${(haveDv / 1000).toFixed(2)} km/s`) +
        (feasible
          ? `<div class="ok">✓ injection within budget — atmosphere does the braking</div>`
          : aero && !aero.feasible
            ? `<div class="warn">✗ arrival too fast to aerocapture here</div>`
            : `<div class="warn">✗ injection exceeds Δv budget</div>`);
      setDisabled(this.commitBtn, !feasible, "Aerocapture infeasible or injection exceeds budget.");
      return;
    }

    const feasible = cell.dvDepart <= haveDv;
    this.readout.innerHTML =
      kv("Depart", formatDate(cell.depT)) +
      kv("Arrive", formatDate(cell.arrT)) +
      kv("Flight time", `${(cell.tof / DAY).toFixed(0)} days`) +
      kv("Injection Δv", `${(cell.dvDepart / 1000).toFixed(3)} km/s`) +
      kv("Arrival (capture) Δv", `${(cell.dvArrive / 1000).toFixed(3)} km/s`) +
      kv("Total Δv", `${(cell.total / 1000).toFixed(3)} km/s`) +
      kv("Ship Δv available", `${(haveDv / 1000).toFixed(2)} km/s`) +
      (feasible
        ? `<div class="ok">✓ injection within budget</div>`
        : `<div class="warn">✗ injection exceeds Δv budget</div>`);
    setDisabled(this.commitBtn, !feasible, "Injection Δv exceeds the ship's budget.");
  }

  private commit(): void {
    if (!this.shipId) return;
    if (this.chain) {
      if (!planChainAssist(this.sim, this.shipId, this.chain.bodyIds, this.chain.times)) return;
      this.sm.setFocusTarget(this.shipId, (t) => {
        const s = this.sim.world.ships.get(this.shipId!);
        return s ? shipWorldState(s, t).r : { x: 0, y: 0, z: 0 };
      }, 500);
      this.close();
      return;
    }
    if (this.viaId && this.assist) {
      const a = this.assist;
      if (!planAssist(this.sim, this.shipId, this.viaId, this.targetId, a.tDepart, a.tFlyby, a.tArrive)) return;
      this.sm.setFocusTarget(this.shipId, (t) => {
        const s = this.sim.world.ships.get(this.shipId!);
        return s ? shipWorldState(s, t).r : { x: 0, y: 0, z: 0 };
      }, 500);
      this.close();
      return;
    }
    const cell = this.selectedCell();
    if (!cell) return;
    const target = BODY_BY_ID.get(this.targetId);
    const mode = this.captureMode === "aerocapture" && target?.atmosphere ? "aerocapture" : "propulsive";
    const plan = planTransfer(this.sim, this.shipId, this.targetId, cell.depT, cell.arrT, mode);
    if (!plan) return;
    // Focus the ship and let the player fast-forward to the window.
    this.sm.setFocusTarget(this.shipId, (t) => {
      const s = this.sim.world.ships.get(this.shipId!);
      return s ? shipWorldState(s, t).r : { x: 0, y: 0, z: 0 };
    }, 500);
    this.close();
  }
}

