/**
 * The bottom-centre telemetry rail — a thin always-on broadcast line for the
 * selected ship, sitting just above the scale bar. It keeps the game's defining
 * fact, the one-way light-lag, permanently on screen: the range to the control
 * node and how long its signal takes to cross that gap. Read-only over the
 * world; built once, mutated per frame. Hidden when no ship is selected (or the
 * craft is lost), so it never clutters the empty orrery.
 */

import { type Simulation } from "@lightlag/engine/sim";
import type { ShipPanel } from "./shipPanel.ts";
import { shipWorldState } from "@lightlag/engine/ships";
import { bodyPosition } from "@lightlag/engine/ephemeris";
import { retardedTime } from "@lightlag/engine/comms";
import { distance } from "@lightlag/engine/math/vec3";
import { el, formatLength } from "./dom.ts";
import { fmtDelay } from "./shipStatus.ts";

export class BottomTelemetry {
  private rail: HTMLElement;
  private nameEl: HTMLElement;
  private rangeEl: HTMLElement;
  private signalEl: HTMLElement;
  private lastSig = "";

  constructor(
    root: HTMLElement,
    private sim: Simulation,
    private shipPanel: ShipPanel,
  ) {
    this.rail = el("div", "telemetry-rail");
    this.rail.style.display = "none";
    this.nameEl = el("div", "trail-name");
    this.rangeEl = this.seg("Range");
    this.signalEl = this.seg("1-way signal");
    this.rail.append(this.nameEl, divider(), this.rangeEl.parentElement!, divider(), this.signalEl.parentElement!);
    root.appendChild(this.rail);
  }

  /** One labelled segment; returns the value element (the label is a sibling). */
  private seg(label: string): HTMLElement {
    const wrap = el("div", "trail-seg");
    wrap.appendChild(el("span", "trail-lab", label));
    const v = el("span", "trail-val");
    wrap.appendChild(v);
    return v;
  }

  update(t: number): void {
    const sel = this.shipPanel.selected;
    const ship = sel ? this.sim.world.ships.get(sel) : undefined;
    if (!ship || ship.status === "lost") {
      if (this.rail.style.display !== "none") this.rail.style.display = "none";
      return;
    }
    this.rail.style.display = "flex";

    const controlPos = bodyPosition(this.sim.world.controlNode, t);
    const shipPos = shipWorldState(ship, t).r;
    const range = distance(shipPos, controlPos);
    // What the control node *knows*: the retarded emit time whose light reaches it
    // now; t − that is the one-way light-lag across the current range.
    const tKnown = retardedTime(controlPos, (tt) => shipWorldState(ship, tt).r, t);

    if (ship.name !== this.lastSig) {
      this.nameEl.textContent = ship.name;
      this.lastSig = ship.name;
    }
    this.rangeEl.textContent = formatLength(range);
    this.signalEl.textContent = fmtDelay(t - tKnown);
  }
}

function divider(): HTMLElement {
  return el("div", "trail-div");
}
