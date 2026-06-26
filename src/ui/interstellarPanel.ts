/**
 * The interstellar planner — the first step beyond the Solar System.
 *
 * Pick a nearby star and a torchship, and see the brutal honesty of interstellar
 * flight: the relativistic mass ratio, the cruise fraction of c, and the two
 * clocks that no longer agree — the years the crew ages (proper time) versus the
 * years Earth waits (coordinate time) — plus the one-way light-lag that turns
 * every command into a multi-year letter. Dispatch flies the ship there in-sim on
 * an analytic flip-and-burn.
 */

import { type Simulation } from "../core/sim.ts";
import { type SceneManager } from "../render/SceneManager.ts";
import { STARS, STAR_BY_ID } from "../core/stars.ts";
import { torchTransit, type InterstellarTransit } from "../core/maneuver/interstellar.ts";
import { INTERSTELLAR_CRAFT } from "../app/shipCatalog.ts";
import { dispatchInterstellar } from "../app/commands.ts";
import { shipWorldState } from "../core/ships.ts";
import { C } from "../core/constants.ts";

export class InterstellarPanel {
  private panel!: HTMLElement;
  private starSel!: HTMLSelectElement;
  private craftSel!: HTMLSelectElement;
  private readout!: HTMLElement;
  private dispatchBtn!: HTMLButtonElement;

  private shipId: string | null = null;
  private starId = "proxima";
  private craftIndex = 0;

  constructor(
    private root: HTMLElement,
    private sim: Simulation,
    private sm: SceneManager,
  ) {
    this.build();
  }

  private build(): void {
    this.panel = div("panel interstellar-panel");
    this.panel.style.display = "none";

    const head = div("transfer-head");
    head.appendChild(div("panel-title", "INTERSTELLAR"));
    this.panel.appendChild(head);

    this.starSel = document.createElement("select");
    this.starSel.className = "target-sel";
    for (const s of [...STARS].sort((a, b) => a.distanceLy - b.distanceLy)) {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = `${s.name} — ${s.distanceLy.toFixed(2)} ly`;
      this.starSel.appendChild(o);
    }
    this.starSel.value = this.starId;
    this.starSel.onchange = () => { this.starId = this.starSel.value; this.recompute(); };
    this.panel.appendChild(this.starSel);

    this.craftSel = document.createElement("select");
    this.craftSel.className = "target-sel";
    INTERSTELLAR_CRAFT.forEach((c, i) => {
      const o = document.createElement("option");
      o.value = String(i);
      o.textContent = c.name;
      this.craftSel.appendChild(o);
    });
    this.craftSel.onchange = () => { this.craftIndex = Number(this.craftSel.value); this.recompute(); };
    this.panel.appendChild(this.craftSel);

    this.readout = div("transfer-readout");
    this.panel.appendChild(this.readout);

    const btns = div("transfer-btns");
    this.dispatchBtn = btn("Dispatch ▸", () => this.dispatch());
    this.dispatchBtn.className = "primary";
    btns.append(this.dispatchBtn, btn("Close", () => this.close()));
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

  private estimate(): InterstellarTransit | null {
    const star = STAR_BY_ID.get(this.starId);
    const craft = INTERSTELLAR_CRAFT[this.craftIndex];
    if (!star || !craft) return null;
    return torchTransit({ exhaustVelocity: craft.exhaustVelocity, properAccel: craft.properAccel }, star);
  }

  private recompute(): void {
    const t = this.estimate();
    const craft = INTERSTELLAR_CRAFT[this.craftIndex];
    if (!t || !craft) {
      this.readout.textContent = "No solution.";
      setDisabled(this.dispatchBtn, true, "No transit solution for this star / craft.");
      return;
    }
    const ratio = isFinite(t.massRatio)
      ? (t.massRatio < 1e4 ? t.massRatio.toFixed(1) : t.massRatio.toExponential(1))
      : "∞";
    this.readout.innerHTML =
      kv("Drive", `${(craft.exhaustVelocity / C).toFixed(2)} c exhaust · ${(craft.properAccel / 9.80665).toFixed(2)} g`) +
      kv("Cruise speed", `${(t.cruiseFraction * 100).toFixed(1)}% c (γ ${t.peakLorentz.toFixed(2)})`) +
      kv("Crew time (proper)", `${t.properTimeYr.toFixed(2)} yr`) +
      kv("Earth time (coord.)", `${t.coordinateTimeYr.toFixed(2)} yr`) +
      kv("Mass ratio m₀/m_f", ratio) +
      kv("One-way light-lag", `${t.oneWayLightLagYr.toFixed(2)} yr`) +
      `<div class="note-line">${craft.note}</div>`;
    setDisabled(this.dispatchBtn, !this.shipId, "Select a ship first.");
  }

  private dispatch(): void {
    const craft = INTERSTELLAR_CRAFT[this.craftIndex];
    if (!this.shipId || !craft) return;
    const ok = dispatchInterstellar(this.sim, this.shipId, this.starId, craft.properAccel, craft.exhaustVelocity);
    if (!ok) return;
    this.sm.setFocusTarget(this.shipId, (t) => {
      const s = this.sim.world.ships.get(this.shipId!);
      return s ? shipWorldState(s, t).r : { x: 0, y: 0, z: 0 };
    }, 1000);
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
