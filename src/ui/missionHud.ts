/**
 * The closed-panel mission HUD — a compact glance at the selected ship that lives
 * on the viewport when the full Mission panel is hidden. It carries the headline
 * status, a live mini-orbit, the few vitals worth seeing at a glance, and the
 * latest mission events; cycling between ships and re-opening the panel are one
 * click away. Read-only over the world; built once, mutated per frame.
 *
 * It also owns the small re-open tab shown whenever the Mission panel is closed,
 * so a hidden panel is always recoverable without the keyboard.
 */

import { type Simulation } from "../core/sim.ts";
import type { ShipPanel } from "./shipPanel.ts";
import { type EventFeed } from "./events.ts";
import {
  dvRemaining,
  shipRelativeState,
  shipWorldState,
  shipOsculatingElements,
  primaryMu,
} from "../core/ships.ts";
import { summarizeOrbit } from "../core/orbit.ts";
import { bodyPosition } from "../core/ephemeris.ts";
import { retardedTime } from "../core/comms.ts";
import { BODY_BY_ID } from "../core/constants.ts";
import { length } from "../core/math/vec3.ts";
import { el, button } from "./dom.ts";
import { statPill, statTable, miniOrbit, type StatPill, type StatTable, type MiniOrbit } from "./instruments.ts";
import { bannerOf, orbitViewOf, orbitCaptionOf, fmtDelay } from "./shipStatus.ts";

export class MissionHud {
  private card!: HTMLElement;
  private tab!: HTMLButtonElement;
  private nameEl!: HTMLElement;
  private statePill!: StatPill;
  private orbit!: MiniOrbit;
  private table!: StatTable;
  private alertsEl!: HTMLElement;
  private lastAlertKey = "";

  constructor(
    private root: HTMLElement,
    private sim: Simulation,
    private shipPanel: ShipPanel,
    private events: EventFeed,
  ) {
    this.build();
  }

  private build(): void {
    // Re-open tab (always available when the panel is closed).
    this.tab = button("▸ MISSION", () => this.shipPanel.toggle());
    this.tab.className = "dock-tab mission-tab";
    this.tab.title = "Open the Mission panel (F)";
    this.tab.style.display = "none";
    this.root.appendChild(this.tab);

    // The glance card.
    const card = el("div", "panel mission-hud");
    card.style.display = "none";
    this.card = card;

    const head = el("div", "mhud-head");
    this.nameEl = el("div", "mhud-name");
    const nav = el("div", "mhud-nav");
    const prev = button("‹", () => this.cycle(-1));
    prev.className = "mhud-cyc";
    prev.title = "Previous ship";
    const openBtn = button("⤢", () => this.shipPanel.toggle());
    openBtn.className = "mhud-cyc";
    openBtn.title = "Open the Mission panel (F)";
    const next = button("›", () => this.cycle(1));
    next.className = "mhud-cyc";
    next.title = "Next ship";
    nav.append(prev, openBtn, next);
    head.append(this.nameEl, nav);
    card.appendChild(head);

    this.statePill = statPill("", "info");
    this.statePill.root.classList.add("banner");
    card.appendChild(this.statePill.root);

    this.orbit = miniOrbit({ width: 220, height: 120 });
    card.appendChild(this.orbit.root);

    this.table = statTable();
    this.table.row("Speed");
    this.table.row("Δv");
    this.table.row("Signal");
    card.appendChild(this.table.root);

    this.alertsEl = el("div", "mhud-alerts");
    card.appendChild(this.alertsEl);

    this.root.appendChild(card);
  }

  /** Select the next/previous ship without opening the panel. */
  private cycle(dir: number): void {
    const ids = Array.from(this.sim.world.ships.keys());
    if (ids.length < 2) return;
    const i = ids.indexOf(this.shipPanel.selected ?? "");
    const next = ids[(i + dir + ids.length) % ids.length]!;
    this.shipPanel.selectShip(next);
  }

  update(t: number): void {
    const open = this.shipPanel.isOpen();
    const sel = this.shipPanel.selected;
    const ship = sel ? this.sim.world.ships.get(sel) : undefined;

    // When the panel is open, the full console has it covered.
    if (open || !ship) {
      this.card.style.display = "none";
      this.tab.style.display = open ? "none" : "flex";
      return;
    }
    this.tab.style.display = "none";
    this.card.style.display = "flex";

    this.nameEl.textContent = ship.name;
    const primary = BODY_BY_ID.get(ship.primary)!;
    const sum = ship.primary !== "sun" && primary ? summarizeOrbit(shipOsculatingElements(ship, t), primaryMu(ship), primary.radius) : null;
    const b = bannerOf(ship, t, sum, primary);
    this.statePill.set(b.text, b.state);
    this.orbit.set(orbitViewOf(ship, t), orbitCaptionOf(ship, t));

    if (ship.status === "lost") {
      this.table.hide("Speed"); this.table.hide("Δv"); this.table.hide("Signal");
    } else {
      const controlPos = bodyPosition(this.sim.world.controlNode, t);
      const tKnown = retardedTime(controlPos, (tt) => shipWorldState(ship, tt).r, t);
      const rel = shipRelativeState(ship, t);
      this.table.set("Speed", `${(length(rel.v) / 1000).toFixed(2)} km/s`);
      this.table.set("Δv", `${(dvRemaining(ship) / 1000).toFixed(2)} km/s`);
      this.table.set("Signal", fmtDelay(t - tKnown));
    }

    this.fillAlerts();
  }

  /** Rebuild the alert lines only when the latest event changes. */
  private fillAlerts(): void {
    const recent = this.events.recent(3);
    const key = recent.map((e) => e.t + e.text).join("|");
    if (key === this.lastAlertKey) return;
    this.lastAlertKey = key;
    this.alertsEl.innerHTML = "";
    for (const e of recent) {
      const line = el("div", "mhud-alert", e.text);
      line.dataset.state = e.state;
      this.alertsEl.appendChild(line);
    }
  }
}
