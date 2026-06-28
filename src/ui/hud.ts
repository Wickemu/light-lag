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
import { type Visibility, type LayerKey } from "../render/visibility.ts";
import { BODIES, BODY_BY_ID, AU, C, MU_SUN, type BodyKind } from "../core/constants.ts";
import { bodyState, bodyElements } from "../core/ephemeris.ts";
import { solarFlux } from "../core/thermal.ts";
import { surfaceGravity, escapeVelocity } from "../core/surface.ts";
import { period as orbitalPeriod } from "../core/math/kepler.ts";
import { length, distance } from "../core/math/vec3.ts";
import { formatDate } from "../core/time.ts";
import { el, button, kv } from "./dom.ts";
import { markTerm } from "./tooltip.ts";
import { popover, type Popover } from "./popover.ts";
import { getFlag, setFlag } from "./uiState.ts";

/** Focus-list groups, in display order. The Sun (star) gets no header — it sits
 *  alone at the top, directly under FOCUS. BODIES is ordered by heliocentric
 *  distance, which interleaves moons and dwarfs; grouping by kind gives one clean
 *  section per kind (distance order preserved within each). */
const GROUPS: { kind: BodyKind; label: string }[] = [
  { kind: "star", label: "" },
  { kind: "planet", label: "Planets" },
  { kind: "dwarf", label: "Dwarf planets" },
  { kind: "asteroid", label: "Asteroids" },
  { kind: "moon", label: "Moons" },
  { kind: "satellite", label: "Satellites" },
  { kind: "comet", label: "Comets" },
];

/** Label de-collision order: when several bodies project to the same pixel
 *  (a planet with its moons and satellites, common when zoomed out), the
 *  higher-priority label wins the spot and the rest are suppressed. Lower
 *  number = placed first. The focused body is promoted above everything. */
const LABEL_PRIORITY: Record<BodyKind, number> = {
  star: 0,
  planet: 1,
  dwarf: 2,
  moon: 3,
  comet: 4,
  asteroid: 5,
  satellite: 6,
};

/** Cross-cutting overlay toggles shown as chips above the body list. */
const LAYER_CHIPS: { key: LayerKey; label: string }[] = [
  { key: "orbits", label: "Orbits" },
  { key: "trajectory", label: "Path" },
  { key: "route", label: "Route" },
  { key: "labels", label: "Labels" },
  { key: "stars", label: "Stars" },
  { key: "starLabels", label: "Star names" },
  { key: "constellations", label: "Constellations" },
  { key: "ships", label: "Ships" },
  { key: "comms", label: "Comms" },
  { key: "doppler_tint", label: "Doppler" },
  { key: "forces", label: "Forces" },
];

export class Hud {
  private dateEl!: HTMLElement;
  private warpEl!: HTMLElement;
  private pauseBtn!: HTMLButtonElement;
  private focusTitle!: HTMLElement;
  private focusBody!: HTMLElement;
  private fpsEl!: HTMLElement;
  private labelLayer!: HTMLElement;
  private systemBtn!: HTMLButtonElement;
  private interstellarBtn!: HTMLButtonElement;
  private layersPopover!: Popover;
  private helpEl!: HTMLElement;
  private showFps = getFlag("showFps", false);
  private bloomOn = getFlag("bloom", true);
  private perfMode = getFlag("perfMode", false);
  private labels = new Map<string, HTMLElement>();
  // Cached rendered width per label (text is static), so de-collision can do a
  // bounding-box test without forcing a layout read every frame.
  private labelWidths = new Map<string, number>();
  private listButtons = new Map<string, HTMLButtonElement>();
  // Show/hide controls: eye toggles per body and per kind, layer chips, and the
  // body rows (so a hidden body can be dimmed). Repainted from Visibility.onChange.
  private bodyEyes = new Map<string, HTMLButtonElement>();
  private bodyRows = new Map<string, HTMLElement>();
  private kindEyes = new Map<BodyKind, HTMLButtonElement>();
  private layerChips = new Map<LayerKey, HTMLButtonElement>();
  /** Focus-list order as displayed (grouped by kind) — drives Tab cycling so the
   *  keyboard and the visible list agree. */
  private focusOrder: string[] = [];

  constructor(
    private root: HTMLElement,
    private sim: Simulation,
    private sm: SceneManager,
    private vis: Visibility,
  ) {
    this.build();
    // Apply the persisted graphics choice before the first frame.
    this.sm.setBloomEnabled(this.bloomOn);
    this.sm.setPerformanceMode(this.perfMode);
    this.vis.onChange(() => this.refreshVisibilityUI());
    this.refreshVisibilityUI();
    this.refreshViewSwitch();
  }

  private build(): void {
    // Note: do NOT clear this.root here — other overlays (ship labels, panels)
    // share #ui-root and would be wiped.

    // Compact wordmark (top-left). The subtitle moved to the Help overlay; the
    // mark just anchors the corner now that the controls live on the right.
    const header = el("div", "panel header");
    header.innerHTML = `<div class="title">LIGHTLAG</div>`;
    this.root.appendChild(header);

    // Clock + warp (top centre) — the one always-critical global control.
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

    // Top-right control cluster: the scene's chrome, gathered into one card
    // instead of scattered loose icons — view switch, a Layers popover (the
    // cross-cutting overlay toggles), theme, and help.
    this.root.appendChild(this.buildTopCluster());

    // Right "Navigation" dock: the body selector (scrolls — 43 bodies overflow)
    // with the focused-body readout pinned beneath it, so you pick and inspect in
    // one place. Each row carries an eye toggle (show/hide that body); each group
    // header an eye toggle for the whole kind.
    const dock = el("div", "panel nav-dock");
    const list = el("div", "nav-list");
    const head = el("div", "list-head");
    head.appendChild(el("div", "panel-title", "FOCUS"));
    list.appendChild(head);

    for (const g of GROUPS) {
      const inGroup = BODIES.filter((b) => b.kind === g.kind);
      if (inGroup.length === 0) continue;
      if (g.label) {
        const groupRow = el("div", "body-group-row");
        const eye = this.eyeButton(`Show / hide all ${g.label.toLowerCase()}`, () =>
          this.vis.toggleKind(g.kind),
        );
        groupRow.append(eye, el("span", "body-group", g.label));
        this.kindEyes.set(g.kind, eye);
        list.appendChild(groupRow);
      }
      for (const b of inGroup) {
        this.focusOrder.push(b.id);
        const row = el("div", "body-row");
        const eye = this.eyeButton(`Show / hide ${b.name}`, () => this.vis.toggleBody(b.id));
        const btn = button(b.name, () => this.focus(b.id));
        btn.classList.add("body-btn");
        const swatch = el("span", "swatch");
        swatch.style.background = `#${b.color.toString(16).padStart(6, "0")}`;
        btn.prepend(swatch);
        row.append(eye, btn);
        this.listButtons.set(b.id, btn);
        this.bodyEyes.set(b.id, eye);
        this.bodyRows.set(b.id, row);
        list.appendChild(row);
      }
    }
    dock.appendChild(list);

    // Focused-body readout — pinned as the dock's non-scrolling footer, directly
    // under the body you just picked from the list above it.
    const focus = el("div", "nav-focus");
    this.focusTitle = el("div", "focus-title");
    this.focusBody = el("div", "focus-body");
    focus.append(this.focusTitle, this.focusBody);
    dock.appendChild(focus);
    this.root.appendChild(dock);

    // Tiny FPS readout (bottom-right), off by default — a debug aid, not chrome.
    // Toggled from the Help overlay; the per-frame write is cheap regardless.
    this.fpsEl = el("div", "fps-mini");
    this.fpsEl.style.display = this.showFps ? "block" : "none";
    this.root.appendChild(this.fpsEl);

    // Help overlay — the keyboard reference (formerly an always-on footer) plus
    // the FPS toggle, opened from the cluster's ? button or the ? key.
    this.helpEl = this.buildHelpOverlay();
    this.root.appendChild(this.helpEl);

    // Label layer.
    this.labelLayer = el("div", "label-layer");
    this.root.appendChild(this.labelLayer);
    for (const b of BODIES) {
      // The kind class drives the per-type tint/weight in styles.css.
      const lbl = el("div", `body-label kind-${b.kind}`, b.name);
      this.labels.set(b.id, lbl);
      this.labelLayer.appendChild(lbl);
    }

    this.focus(this.sm.focusId);
  }

  /** The top-right control cluster: view switch, Layers popover, theme, help. */
  private buildTopCluster(): HTMLElement {
    const cluster = el("div", "panel top-cluster");

    // System ⇄ Interstellar segmented toggle (keyboard: M).
    const seg = el("div", "view-switch");
    this.systemBtn = button("System", () => this.setView("system"));
    this.interstellarBtn = button("Interstellar", () => this.setView("interstellar"));
    this.systemBtn.title = "In-system orrery (M)";
    this.interstellarBtn.title = "Interstellar map (M)";
    seg.append(this.systemBtn, this.interstellarBtn);
    cluster.appendChild(seg);

    // Layers popover: the cross-cutting overlay toggles, lifted out of the body
    // list into a menu you open only when you want it.
    this.layersPopover = popover(this.root, "≣ Layers ▾", {
      title: "Scene overlays",
      className: "layers-popover",
    });
    this.layersPopover.content.appendChild(el("div", "section-label", "SCENE LAYERS"));
    this.layersPopover.content.appendChild(this.buildLayerChips());
    cluster.appendChild(this.layersPopover.trigger);

    // Theme + help icons.
    const themeBtn = button("◐", () => this.toggleTheme());
    themeBtn.className = "icon-btn";
    themeBtn.title = "Toggle light / dark";
    const helpBtn = button("?", () => this.toggleHelp());
    helpBtn.className = "icon-btn";
    helpBtn.title = "Keyboard shortcuts & help (?)";
    cluster.append(themeBtn, helpBtn);

    return cluster;
  }

  /** The help modal: the keyboard reference (formerly an always-on footer) and
   *  the FPS-readout toggle. Opened from the ? button or the ? key. */
  private buildHelpOverlay(): HTMLElement {
    const panel = el("div", "panel help-overlay");
    panel.style.display = "none";

    const head = el("div", "panel-head");
    head.appendChild(el("div", "panel-title", "CONTROLS"));
    const close = button("✕", () => this.closeHelp());
    close.className = "panel-close";
    close.title = "Close (Esc)";
    head.appendChild(close);
    panel.appendChild(head);

    panel.appendChild(
      el("div", "subtitle", "a physics-true Solar System · nothing hand-waved"),
    );

    const shortcuts: [string, string][] = [
      ["drag / WASD", "orbit camera"],
      ["scroll / + −", "zoom"],
      ["space", "pause / resume"],
      [", .", "slower / faster warp"],
      ["1–8", "focus Sun … Saturn"],
      ["tab", "cycle focus"],
      ["M", "system ⇄ interstellar map"],
      ["F", "ship / flight panel"],
      ["V", "cycle view angle"],
      ["R", "reset camera framing"],
      ["?", "this help"],
      ["esc", "close panel / overlay"],
    ];
    const keys = el("div", "help-keys");
    for (const [k, label] of shortcuts) {
      const item = el("div", "help-key-row");
      item.appendChild(el("span", "key", k));
      item.appendChild(el("span", "lbl", label));
      keys.appendChild(item);
    }
    panel.appendChild(keys);

    // Graphics toggles. Bloom (the soft glow on the Sun, bright limbs and stars)
    // is by far the most expensive effect — turning it off bypasses the whole post
    // chain for a large frame-rate gain while keeping tone mapping, the lit Sun,
    // atmospheres, the ring shadow and the accurate star colours.
    const bloomRow = el("label", "help-toggle");
    const bloomCb = document.createElement("input");
    bloomCb.type = "checkbox";
    bloomCb.checked = this.bloomOn;
    bloomCb.onchange = () => this.setBloom(bloomCb.checked);
    bloomRow.append(bloomCb, el("span", "", "Bloom / glow (off boosts FPS)"));
    panel.appendChild(bloomRow);

    // Performance mode: lower device-pixel cap, half-res bloom and 2× (vs 4×)
    // MSAA. A big frame-rate win on integrated GPUs / HiDPI displays for a small,
    // mostly-invisible softening; keeps bloom and everything else on.
    const perfRow = el("label", "help-toggle");
    const perfCb = document.createElement("input");
    perfCb.type = "checkbox";
    perfCb.checked = this.perfMode;
    perfCb.onchange = () => this.setPerfMode(perfCb.checked);
    perfRow.append(perfCb, el("span", "", "Performance mode (lower res, faster)"));
    panel.appendChild(perfRow);

    const fpsRow = el("label", "help-toggle");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = this.showFps;
    cb.onchange = () => this.setShowFps(cb.checked);
    fpsRow.append(cb, el("span", "", "Show FPS counter"));
    panel.appendChild(fpsRow);

    return panel;
  }

  /** Toggle the help overlay (cluster ? button and the ? key). */
  toggleHelp(): void {
    if (this.isHelpOpen()) this.closeHelp();
    else this.helpEl.style.display = "flex";
  }
  isHelpOpen(): boolean {
    return this.helpEl.style.display !== "none";
  }
  closeHelp(): void {
    this.helpEl.style.display = "none";
  }

  private setShowFps(on: boolean): void {
    this.showFps = on;
    this.fpsEl.style.display = on ? "block" : "none";
    setFlag("showFps", on);
  }

  private setBloom(on: boolean): void {
    this.bloomOn = on;
    this.sm.setBloomEnabled(on);
    setFlag("bloom", on);
  }

  private setPerfMode(on: boolean): void {
    this.perfMode = on;
    this.sm.setPerformanceMode(on);
    setFlag("perfMode", on);
  }

  /** The chip row of cross-cutting overlay toggles (orbits, labels, stars, …). */
  private buildLayerChips(): HTMLElement {
    const row = el("div", "layers-row");
    for (const { key, label } of LAYER_CHIPS) {
      const chip = button(label, () => this.vis.toggleLayer(key));
      chip.classList.add("layer-chip");
      markTerm(chip, label, { decorate: false }); // glossary hover for any defined chip
      this.layerChips.set(key, chip);
      row.appendChild(chip);
    }
    return row;
  }

  /** A small open/closed-eye toggle that does not steal focus selection. */
  private eyeButton(title: string, onClick: () => void): HTMLButtonElement {
    const b = button("", onClick);
    b.classList.add("eye-btn");
    b.title = title;
    return b;
  }

  private setEye(btn: HTMLButtonElement, shown: boolean): void {
    btn.textContent = shown ? "◉" : "○";
    btn.classList.toggle("off", !shown);
  }

  /** Repaint every visibility control from the shared Visibility state. */
  private refreshVisibilityUI(): void {
    for (const [key, chip] of this.layerChips) chip.classList.toggle("active", this.vis.layer(key));
    for (const [kind, eye] of this.kindEyes) this.setEye(eye, this.vis.kindVisible(kind));
    for (const b of BODIES) {
      const shown = this.vis.bodyVisible(b.id, b.kind);
      const eye = this.bodyEyes.get(b.id);
      if (eye) this.setEye(eye, shown);
      this.bodyRows.get(b.id)?.classList.toggle("hidden-body", !shown);
    }
  }

  /** Switch the active map. Exposed for the keyboard (M) and the HUD buttons. */
  setView(mode: "system" | "interstellar"): void {
    this.sm.setViewMode(mode);
    this.refreshViewSwitch();
  }

  toggleView(): void {
    this.setView(this.sm.viewMode === "system" ? "interstellar" : "system");
  }

  private refreshViewSwitch(): void {
    this.systemBtn.classList.toggle("active", this.sm.viewMode === "system");
    this.interstellarBtn.classList.toggle("active", this.sm.viewMode === "interstellar");
  }

  focus(id: string): void {
    // Choosing a body implies the in-system view — return from the interstellar
    // map if we're on it, then frame the body.
    if (this.sm.viewMode !== "system") this.setView("system");
    this.sm.focusBody(id);
    for (const [bid, btn] of this.listButtons) {
      const active = bid === id;
      btn.classList.toggle("active", active);
      // Keep the focused body visible when it's selected from off-screen (Tab/1–8).
      if (active) btn.scrollIntoView({ block: "nearest" });
    }
  }

  /** Step focus through the displayed (grouped) order; used by Tab cycling. */
  cycleFocus(dir: 1 | -1): void {
    const order = this.focusOrder;
    if (order.length === 0) return;
    const idx = order.indexOf(this.sm.focusId);
    const next = (idx + dir + order.length) % order.length;
    this.focus(order[next]!);
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
    try {
      localStorage.setItem("lightlag.theme", next);
    } catch (e) {
      // Private-mode / storage-disabled: theme just won't persist. Non-fatal.
    }
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
      lines.push(kv("Distance from Sun", `${(rSun / AU).toFixed(3)} AU`));
      lines.push(kv("Orbital speed", `${(length(state.v) / 1000).toFixed(2)} km/s`));
      lines.push(kv("Solar flux", `${solarFlux(rSun).toFixed(0)} W/m²`));

      const el = bodyElements(def, t);
      const parent = def.parent ? BODY_BY_ID.get(def.parent) : undefined;
      const mu = parent && parent.id !== "sun" ? parent.mu : MU_SUN;
      if (el) {
        const T = orbitalPeriod(el.a, mu);
        lines.push(kv("Orbital period", formatPeriod(T)));
        lines.push(kv("Eccentricity", el.e.toFixed(4)));
        lines.push(kv("Inclination", `${((el.i * 180) / Math.PI).toFixed(2)}°`));
      }

      // Surface physics (drives the landing/takeoff budget in the ship panel).
      lines.push(kv("Surface gravity", `${surfaceGravity(def).toFixed(2)} m/s²`));
      lines.push(kv("Escape velocity", `${(escapeVelocity(def) / 1000).toFixed(2)} km/s`));
      if (def.atmosphere) {
        const bar = def.atmosphere.surfacePressure / 101325;
        lines.push(kv("Surface pressure", bar >= 0.01 ? `${bar.toFixed(2)} atm` : `${def.atmosphere.surfacePressure.toFixed(1)} Pa`));
      } else if (def.hasSurface !== false) {
        lines.push(kv("Atmosphere", "none (airless)"));
      }
    } else {
      lines.push(kv("Role", "central star"));
      lines.push(kv("Luminosity", "3.828×10²⁶ W"));
    }

    // The light-lag teaser: one-way light-time from Earth.
    if (def.id !== "earth") {
      const earth = BODY_BY_ID.get("earth")!;
      const d = distance(bodyState(earth, t).r, state.r);
      lines.push(kv("Light-time from Earth", formatLightTime(d / C)));
    } else {
      lines.push(kv("Light-time from Earth", "— (you are here)"));
    }

    this.focusBody.innerHTML = lines.join("");
  }

  private updateLabels(views: BodyViews): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // Body labels belong to the in-system view; the interstellar map draws its own.
    const labelsOn = this.vis.layer("labels") && this.sm.viewMode === "system";

    // First pass: hide anything that can't be drawn (layer off, body hidden, or
    // off-screen) and collect the on-screen candidates with their screen anchor.
    const candidates: { id: string; lbl: HTMLElement; kind: BodyKind; x: number; y: number }[] = [];
    for (const anchor of views.labelAnchors()) {
      const lbl = this.labels.get(anchor.id);
      if (!lbl) continue;
      const def = BODY_BY_ID.get(anchor.id);
      if (!labelsOn || !def || !this.vis.bodyVisible(anchor.id, def.kind)) {
        lbl.style.display = "none";
        continue;
      }
      const { ndc } = anchor;
      const visible = ndc.z < 1 && ndc.x >= -1 && ndc.x <= 1 && ndc.y >= -1 && ndc.y <= 1;
      if (!visible) {
        lbl.style.display = "none";
        continue;
      }
      const x = (ndc.x * 0.5 + 0.5) * w;
      const y = (-ndc.y * 0.5 + 0.5) * h;
      candidates.push({ id: anchor.id, lbl, kind: def.kind, x, y });
    }

    // Greedy de-collision: place labels in priority order (focused body first,
    // then by kind), and suppress any whose text box would overlap one already
    // placed. This stops a planet and its moons/satellites — which project to the
    // same pixel when zoomed out — from stacking their names on one spot.
    const focusId = this.sm.focusId;
    candidates.sort((a, b) => {
      const pa = a.id === focusId ? -1 : LABEL_PRIORITY[a.kind];
      const pb = b.id === focusId ? -1 : LABEL_PRIORITY[b.kind];
      return pa - pb;
    });

    // Text box geometry: .body-label sits at (x,y) offset by its 10px CSS margin,
    // is ~14px tall, and as wide as its (cached) rendered text. A little padding
    // keeps near-touching labels from reading as one.
    const MARGIN_X = 10;
    const MARGIN_Y = 10;
    const LABEL_H = 14;
    const PAD = 3;
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    for (const c of candidates) {
      c.lbl.style.display = "block";
      let width = this.labelWidths.get(c.id);
      if (width === undefined || width === 0) {
        width = c.lbl.offsetWidth;
        if (width > 0) this.labelWidths.set(c.id, width);
      }
      const x0 = c.x + MARGIN_X - PAD;
      const y0 = c.y + MARGIN_Y - PAD;
      const x1 = c.x + MARGIN_X + width + PAD;
      const y1 = c.y + MARGIN_Y + LABEL_H + PAD;
      const collides = placed.some((r) => x0 < r.x1 && x1 > r.x0 && y0 < r.y1 && y1 > r.y0);
      if (collides) {
        c.lbl.style.display = "none";
        continue;
      }
      placed.push({ x0, y0, x1, y1 });
      c.lbl.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px)`;
      c.lbl.classList.toggle("focused", c.id === focusId);
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────
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
