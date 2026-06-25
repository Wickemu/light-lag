/**
 * The heads-up display: date & time-warp, a body selector, per-body physics
 * readouts, and floating labels. Pure DOM over the WebGL canvas — it reads the
 * sim and renderer, and dispatches focus/warp intents back to them.
 *
 * The readouts already start telling the truth the game is built on: real
 * orbital periods, real heliocentric speeds, and the one-way light-time from
 * Earth — the first taste of the light-lag that defines everything later.
 */

import { Simulation } from "../core/sim.ts";
import { SceneManager } from "../render/SceneManager.ts";
import { BodyViews } from "../render/bodyViews.ts";
import { BODIES, BODY_BY_ID, AU, C, MU_SUN } from "../core/constants.ts";
import { bodyState, bodyElements } from "../core/ephemeris.ts";
import { period as orbitalPeriod } from "../core/math/kepler.ts";
import { length, distance } from "../core/math/vec3.ts";
import { formatDate } from "../core/time.ts";

export class Hud {
  private dateEl!: HTMLElement;
  private warpEl!: HTMLElement;
  private pauseBtn!: HTMLButtonElement;
  private focusTitle!: HTMLElement;
  private focusBody!: HTMLElement;
  private fpsEl!: HTMLElement;
  private labelLayer!: HTMLElement;
  private labels = new Map<string, HTMLElement>();
  private listButtons = new Map<string, HTMLButtonElement>();

  constructor(
    private root: HTMLElement,
    private sim: Simulation,
    private sm: SceneManager,
  ) {
    this.build();
  }

  private build(): void {
    // Note: do NOT clear this.root here — other overlays (ship labels, panels)
    // share #ui-root and would be wiped.

    // Header.
    const header = el("div", "panel header");
    header.innerHTML = `<div class="title">LIGHTLAG</div>
      <div class="subtitle">a physics-true Solar System · nothing hand-waved</div>`;
    this.root.appendChild(header);

    // Theme toggle.
    const themeBtn = el("button", "icon-btn theme-toggle") as HTMLButtonElement;
    themeBtn.textContent = "◐";
    themeBtn.title = "Toggle light / dark";
    themeBtn.onclick = () => this.toggleTheme();
    this.root.appendChild(themeBtn);

    // Clock + warp (top centre).
    const clock = el("div", "panel clock");
    this.dateEl = el("div", "date");
    this.warpEl = el("div", "warp");
    const warpRow = el("div", "warp-row");
    const down = button("«", () => this.sim.cycleWarp(-1));
    this.pauseBtn = button("⏸", () => this.togglePause());
    const up = button("»", () => this.sim.cycleWarp(1));
    warpRow.append(down, this.pauseBtn, up, this.warpEl);
    clock.append(this.dateEl, warpRow);
    this.root.appendChild(clock);

    // Body selector (right).
    const list = el("div", "panel body-list");
    list.appendChild(el("div", "panel-label", "FOCUS"));
    for (const b of BODIES) {
      const btn = button(b.name, () => this.focus(b.id));
      btn.classList.add("body-btn");
      const swatch = el("span", "swatch");
      swatch.style.background = `#${b.color.toString(16).padStart(6, "0")}`;
      btn.prepend(swatch);
      this.listButtons.set(b.id, btn);
      list.appendChild(btn);
    }
    this.root.appendChild(list);

    // Focus readout (bottom-left).
    const focus = el("div", "panel focus");
    this.focusTitle = el("div", "focus-title");
    this.focusBody = el("div", "focus-body");
    focus.append(this.focusTitle, this.focusBody);
    this.root.appendChild(focus);

    // Controls hint + fps.
    const foot = el("div", "panel foot");
    this.fpsEl = el("span", "fps");
    foot.innerHTML = `<span class="hint">drag/WASD/↑↓←→ orbit · scroll/±zoom · space pause · ,. warp · 1-8 focus · tab cycle · [F] ships · [V] views · [R] reset</span>`;
    foot.appendChild(this.fpsEl);
    this.root.appendChild(foot);

    // Label layer.
    this.labelLayer = el("div", "label-layer");
    this.root.appendChild(this.labelLayer);
    for (const b of BODIES) {
      const lbl = el("div", "body-label", b.name);
      this.labels.set(b.id, lbl);
      this.labelLayer.appendChild(lbl);
    }

    this.focus(this.sm.focusId);
  }

  focus(id: string): void {
    this.sm.focusBody(id);
    for (const [bid, btn] of this.listButtons) {
      btn.classList.toggle("active", bid === id);
    }
  }

  togglePause(): void {
    this.sim.togglePause();
    this.pauseBtn.textContent = this.sim.paused ? "▶" : "⏸";
  }

  private toggleTheme(): void {
    const html = document.documentElement;
    const next = html.getAttribute("data-theme") === "light" ? "dark" : "light";
    html.setAttribute("data-theme", next);
    this.sm.setTheme(next);
  }

  /** Called once per frame. */
  update(fps: number, views: BodyViews): void {
    const t = this.sim.world.t;
    this.dateEl.textContent = formatDate(t);
    this.warpEl.textContent = this.sim.paused ? "paused" : this.sim.warpLabel;
    this.fpsEl.textContent = `${fps.toFixed(0)} fps`;

    this.updateFocusReadout(t);
    this.updateLabels(views);
  }

  private updateFocusReadout(t: number): void {
    const def = BODY_BY_ID.get(this.sm.focusId);
    if (!def) return;
    this.focusTitle.textContent = def.name;

    const lines: string[] = [];
    const state = bodyState(def, t);

    if (def.id !== "sun") {
      const rSun = length(state.r);
      lines.push(row("Distance from Sun", `${(rSun / AU).toFixed(3)} AU`));
      lines.push(row("Orbital speed", `${(length(state.v) / 1000).toFixed(2)} km/s`));

      const el = bodyElements(def, t);
      const parent = def.parent ? BODY_BY_ID.get(def.parent) : undefined;
      const mu = parent && parent.id !== "sun" ? parent.mu : MU_SUN;
      if (el) {
        const T = orbitalPeriod(el.a, mu);
        lines.push(row("Orbital period", formatPeriod(T)));
        lines.push(row("Eccentricity", el.e.toFixed(4)));
        lines.push(row("Inclination", `${((el.i * 180) / Math.PI).toFixed(2)}°`));
      }
    } else {
      lines.push(row("Role", "central star"));
      lines.push(row("Luminosity", "3.828×10²⁶ W"));
    }

    // The light-lag teaser: one-way light-time from Earth.
    if (def.id !== "earth") {
      const earth = BODY_BY_ID.get("earth")!;
      const d = distance(bodyState(earth, t).r, state.r);
      lines.push(row("Light-time from Earth", formatLightTime(d / C)));
    } else {
      lines.push(row("Light-time from Earth", "— (you are here)"));
    }

    this.focusBody.innerHTML = lines.join("");
  }

  private updateLabels(views: BodyViews): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const anchor of views.labelAnchors()) {
      const lbl = this.labels.get(anchor.id);
      if (!lbl) continue;
      const { ndc } = anchor;
      const visible = ndc.z < 1 && ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1;
      if (!visible) {
        lbl.style.display = "none";
        continue;
      }
      lbl.style.display = "block";
      const x = (ndc.x * 0.5 + 0.5) * w;
      const y = (-ndc.y * 0.5 + 0.5) * h;
      lbl.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      lbl.classList.toggle("focused", anchor.id === this.sm.focusId);
    }
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

function row(k: string, v: string): string {
  return `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

function formatPeriod(seconds: number): string {
  if (!isFinite(seconds)) return "—";
  const years = seconds / (365.25 * 86400);
  if (years >= 1) return `${years.toFixed(2)} yr`;
  const days = seconds / 86400;
  return `${days.toFixed(2)} d`;
}

function formatLightTime(seconds: number): string {
  if (seconds < 90) return `${seconds.toFixed(1)} s`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(1)} min`;
  if (seconds < 172800) return `${(seconds / 3600).toFixed(1)} hr`;
  return `${(seconds / 86400).toFixed(1)} d`;
}
