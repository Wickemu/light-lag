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
import { computePorkchop, type Porkchop, type PorkCell } from "../core/maneuver/porkchop.ts";
import { hohmann, synodicPeriod } from "../core/maneuver/hohmann.ts";
import { searchAssist, type AssistResult } from "../core/maneuver/assist.ts";
import { planTransfer, planAssist } from "../app/commands.ts";
import { dvRemaining, shipWorldState, shipOsculatingElements } from "../core/ships.ts";
import { periapsisRadius, orbitalPeriod } from "../core/orbit.ts";
import { bodyElements } from "../core/ephemeris.ts";
import { formatDate } from "../core/time.ts";
import { BODIES, BODY_BY_ID, DAY, MU_SUN, DEFAULT_CAPTURE_ALT } from "../core/constants.ts";

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
  private shipId: string | null = null;
  private targetId = "mars";
  private viaId = ""; // "" = direct; otherwise a flyby body id
  private assist: AssistResult | null = null;
  private pork: Porkchop | null = null;
  private selI = -1;
  private selJ = -1;

  constructor(
    private root: HTMLElement,
    private sim: Simulation,
    private sm: SceneManager,
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

    // Gravity-assist search (when a flyby body is chosen): scan a few departure
    // dates, and for each grid the flyby/arrival times, keeping the cheapest.
    this.assist = null;
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
      if (this.viaId) { this.updateReadout(); return; } // assist mode draws its own readout
      this.readout.textContent = "No transfer solution in range.";
      return;
    }
    const b = this.pork.best;
    this.selI = Math.round((b.depT - this.pork.depStart) / this.pork.depStep);
    this.selJ = Math.round((b.tof - this.pork.tofStart) / this.pork.tofStep);
    this.draw();
    this.updateReadout();
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
    const feasible = cell.dvDepart <= haveDv;
    this.axisEl.innerHTML =
      `<span>↑ flight time &nbsp; → departure date</span>`;
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
    const plan = planTransfer(this.sim, this.shipId, this.targetId, cell.depT, cell.arrT);
    if (!plan) return;
    // Focus the ship and let the player fast-forward to the window.
    this.sm.setFocusTarget(this.shipId, (t) => {
      const s = this.sim.world.ships.get(this.shipId!);
      return s ? shipWorldState(s, t).r : { x: 0, y: 0, z: 0 };
    }, 500);
    this.close();
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────
function div(className: string, text = ""): HTMLElement {
  const e = document.createElement("div");
  e.className = className;
  if (text) e.textContent = text;
  return e;
}
function btn(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = onClick;
  return b;
}
function kv(k: string, v: string): string {
  return `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}
/** Disable a button and surface the reason as a native hover tooltip. */
function setDisabled(btn: HTMLButtonElement, disabled: boolean, reason = ""): void {
  btn.disabled = disabled;
  if (disabled && reason) btn.title = reason;
  else btn.removeAttribute("title");
}
