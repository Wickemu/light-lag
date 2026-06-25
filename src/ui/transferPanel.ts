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
import { planTransfer } from "../app/commands.ts";
import { dvRemaining, shipWorldState, shipOsculatingElements } from "../core/ships.ts";
import { periapsisRadius } from "../core/orbit.ts";
import { formatDate } from "../core/time.ts";
import { BODY_BY_ID, DAY, DEFAULT_CAPTURE_ALT } from "../core/constants.ts";

const TARGETS = ["mercury", "venus", "mars", "jupiter", "saturn"];
const CANVAS_W = 300;
const CANVAS_H = 210;

export class TransferPanel {
  private panel!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private readout!: HTMLElement;
  private commitBtn!: HTMLButtonElement;
  private targetSel!: HTMLSelectElement;
  private axisEl!: HTMLElement;

  private shipId: string | null = null;
  private targetId = "mars";
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
    head.appendChild(div("panel-label", "TRANSFER PLANNER"));
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
    // One synodic-ish departure span guarantees the next window is included.
    this.pork = computePorkchop({
      fromId,
      toId: this.targetId,
      depStart: t0,
      depEnd: t0 + 800 * DAY,
      depN: 64,
      tofMin: 80 * DAY,
      tofMax: 400 * DAY,
      tofN: 48,
      rParkFrom,
      rParkTo,
    });
    this.selectBest();
  }

  private selectBest(): void {
    if (!this.pork || !this.pork.best) {
      this.draw();
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
    const cell = this.selectedCell();
    const ship = this.shipId ? this.sim.world.ships.get(this.shipId) : undefined;
    if (!cell || !ship || !isFinite(cell.total)) {
      this.readout.textContent = "No solution for this cell.";
      this.commitBtn.disabled = true;
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
    this.commitBtn.disabled = !feasible;
  }

  private commit(): void {
    const cell = this.selectedCell();
    if (!cell || !this.shipId) return;
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
