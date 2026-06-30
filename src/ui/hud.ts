/**
 * The heads-up display: date & time-warp, a body selector, per-body physics
 * readouts, and floating labels. Pure DOM over the WebGL canvas — it reads the
 * sim and renderer, and dispatches focus/warp intents back to them.
 *
 * The readouts already start telling the truth the game is built on: real
 * orbital periods, real heliocentric speeds, and the one-way light-time from
 * Earth — the first taste of the light-lag that defines everything later.
 */

import { Simulation } from "@lightlag/engine/sim";
import { SceneManager } from "../render/SceneManager.ts";
import { BodyViews } from "../render/bodyViews.ts";
import { type Visibility, type LayerKey } from "../render/visibility.ts";
import { BODIES, BODY_BY_ID, AU, C, MU_SUN, type BodyKind } from "@lightlag/engine/constants";
import { bodyState, bodyElements } from "@lightlag/engine/ephemeris";
import { solarFlux } from "@lightlag/engine/thermal";
import { surfaceGravity, escapeVelocity } from "@lightlag/engine/surface";
import { period as orbitalPeriod } from "@lightlag/engine/math/kepler";
import { length, distance } from "@lightlag/engine/math/vec3";
import { formatDate } from "@lightlag/engine/time";
import { STAR_BY_ID, starPosition, LIGHT_YEAR, type StarDef } from "@lightlag/engine/stars";
import { pickNearest } from "../render/overlayUtil.ts";
import { interstellarFleet, interstellarStarList } from "../app/commands.ts";
import { el, button, kvAuto } from "./dom.ts";
import { markTerm } from "./tooltip.ts";
import { popover, type Popover } from "./popover.ts";
import { ACCENTS, applyAccent, currentAccent, type AccentName } from "./themes.ts";
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
  { key: "perturbed", label: "Perturbed" },
  { key: "labels", label: "Labels" },
  { key: "stars", label: "Stars" },
  { key: "starLabels", label: "Star names" },
  { key: "constellations", label: "Constellations" },
  { key: "ships", label: "Ships" },
  { key: "comms", label: "Comms" },
  { key: "doppler_tint", label: "Doppler" },
  { key: "forces", label: "Forces" },
];

/** Pointer-pick tuning for the orrery (mirrors the interstellar map). A press that
 *  travels more than DRAG_PX between down and up was an OrbitControls orbit/zoom,
 *  not a tap, so it never selects; a tap focuses the nearest body within PICK_PX of
 *  the release point — a comfortable radius around the screen-fixed marker. */
const DRAG_PX = 5;
const PICK_PX = 18;

export class Hud {
  private dateEl!: HTMLElement;
  private warpEl!: HTMLElement;
  private pauseBtn!: HTMLButtonElement;
  private navDockEl!: HTMLElement;
  private navTab!: HTMLButtonElement;
  private focusTitle!: HTMLElement;
  private focusBody!: HTMLElement;
  private fpsEl!: HTMLElement;
  private labelLayer!: HTMLElement;
  private systemBtn!: HTMLButtonElement;
  private interstellarBtn!: HTMLButtonElement;
  private layersPopover!: Popover;
  private helpEl!: HTMLElement;
  // Theme picker (light/dark + accent palette), built into the top cluster.
  private themeModeBtns: { light: HTMLButtonElement; dark: HTMLButtonElement } | null = null;
  private accentSwatches = new Map<AccentName, HTMLButtonElement>();
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
  // Interstellar FOLLOW selector (shown only on the interstellar map): a Sol button
  // plus one per ship in transit. Rebuilt only when the in-transit id-set changes.
  private followSection!: HTMLElement;
  private followList!: HTMLElement;
  private solFollowBtn!: HTMLButtonElement;
  private followButtons = new Map<string, HTMLButtonElement>();
  private followSig = "";
  // Interstellar STARS picker (shown only on the interstellar map): one button per
  // navigable system, nearest first. Static catalog ⇒ built once; clicking one
  // frames that system, the same `setInterstellarFocus` path a marker-click uses.
  private starSection!: HTMLElement;
  private starButtons = new Map<string, HTMLButtonElement>();
  // Click-any-body-to-focus (orrery): the latest BodyViews instance (its
  // `labelAnchors()` supplies the per-frame screen projection the pick reuses) and
  // the tap-vs-drag pointer origin.
  private bodyViews?: BodyViews;
  private bodyPointerDown: { x: number; y: number } | null = null;

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

    // Click any body in the orrery to focus it — the in-system twin of the
    // interstellar star-pick. OrbitControls owns drag/zoom on the same canvas, so
    // we act only on a tap (down+up with little travel) in the system view, routed
    // through the same `focus(id)` the body list and keyboard shortcuts use.
    const canvas = this.sm.renderer.domElement;
    canvas.addEventListener("pointerdown", (e) => {
      this.bodyPointerDown = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    });
    canvas.addEventListener("pointerup", (e) => this.onSystemPointerUp(e));
  }

  /** A left-button tap in the orrery focuses the nearest body, reusing `focus(id)`
   *  (the body-list / keyboard path: camera fly-to + nav-list sync). A press that
   *  travelled more than DRAG_PX was an orbit/zoom and is ignored; so is a tap on
   *  empty space (no accidental deselect). */
  private onSystemPointerUp(e: PointerEvent): void {
    const down = this.bodyPointerDown;
    this.bodyPointerDown = null;
    if (!down || e.button !== 0 || this.sm.viewMode !== "system") return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX) return;
    const hit = this.pickBody(e.clientX, e.clientY);
    if (hit) this.focus(hit.id);
  }

  /** Project every on-screen, visible body to screen pixels (the `updateLabels`
   *  math, via `BodyViews.labelAnchors`) and return the nearest within PICK_PX of
   *  the click, or undefined. Reuses the same NDC anchors and visibility filter the
   *  label layer uses, so only currently-drawn bodies are pickable. */
  private pickBody(clientX: number, clientY: number): { id: string } | undefined {
    const views = this.bodyViews;
    if (!views) return undefined;
    const rect = this.sm.renderer.domElement.getBoundingClientRect();
    const w = rect.width || window.innerWidth;
    const h = rect.height || window.innerHeight;
    const pts: { id: string; x: number; y: number; priority: number }[] = [];
    for (const a of views.labelAnchors()) {
      const def = BODY_BY_ID.get(a.id);
      if (!def || !this.vis.bodyVisible(a.id, def.kind)) continue;
      const ndc = a.ndc;
      if (ndc.z >= 1 || Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) continue;
      // Prominence = the label de-collision rank, so a click in a tight cluster
      // (Earth + its LEO satellites) lands on the dominant body, not the marker
      // that happens to be a pixel closer.
      pts.push({ id: a.id, x: (ndc.x * 0.5 + 0.5) * w, y: (-ndc.y * 0.5 + 0.5) * h, priority: LABEL_PRIORITY[def.kind] });
    }
    return pickNearest(pts, clientX - rect.left, clientY - rect.top, PICK_PX);
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
    this.navDockEl = dock;
    const list = el("div", "nav-list");
    const head = el("div", "list-head");
    const headRow = el("div", "panel-head");
    headRow.appendChild(el("div", "panel-title", "FOCUS"));
    const navClose = button("✕", () => this.toggleNav());
    navClose.className = "panel-close";
    navClose.title = "Hide the Navigation dock (N or Esc)";
    headRow.appendChild(navClose);
    head.appendChild(headRow);
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

    // Interstellar FOLLOW selector — shown only on the interstellar map, where the
    // body list above is inert (it ignores the floating origin). Sol recentres the
    // neighbourhood; each ship button locks the camera onto a craft in transit.
    this.followSection = el("div", "nav-follow");
    this.followSection.style.display = "none";
    this.followSection.appendChild(el("div", "section-label", "FOLLOW"));
    this.followList = el("div", "follow-list");
    this.solFollowBtn = button("Sol", () => this.setFollow(null));
    this.solFollowBtn.classList.add("body-btn", "follow-btn");
    this.followList.appendChild(this.solFollowBtn);
    this.followSection.appendChild(this.followList);
    dock.appendChild(this.followSection);

    // Interstellar STARS picker — the always-available counterpart to clicking a
    // star marker: a list of the navigable systems (nearest first), each framing
    // its system on click. Shown only on the interstellar map (same gate as FOLLOW).
    this.starSection = el("div", "nav-follow");
    this.starSection.style.display = "none";
    this.starSection.appendChild(el("div", "section-label", "STARS"));
    const starList = el("div", "follow-list");
    for (const s of interstellarStarList()) {
      const b = button(`${s.name} · ${s.distanceLy.toFixed(2)} ly`, () => this.setFollow(s.id));
      b.classList.add("body-btn", "follow-btn");
      starList.appendChild(b);
      this.starButtons.set(s.id, b);
    }
    this.starSection.appendChild(starList);
    dock.appendChild(this.starSection);

    // Focused-body readout — pinned as the dock's non-scrolling footer, directly
    // under the body you just picked from the list above it.
    const focus = el("div", "nav-focus");
    this.focusTitle = el("div", "focus-title");
    this.focusBody = el("div", "focus-body");
    focus.append(this.focusTitle, this.focusBody);
    dock.appendChild(focus);
    this.root.appendChild(dock);

    // Navigation dock toggle: a re-open tab + persisted open/closed state, so the
    // right edge can be cleared just like the Mission panel.
    this.navTab = button("◂ NAV", () => this.toggleNav());
    this.navTab.className = "dock-tab nav-tab";
    this.navTab.title = "Show the Navigation dock (N)";
    this.root.appendChild(this.navTab);
    this.setNavOpen(getFlag("dock.nav.open", true));

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

    // Theme picker (light/dark + accent palette) + help icon.
    const helpBtn = button("?", () => this.toggleHelp());
    helpBtn.className = "icon-btn";
    helpBtn.title = "Keyboard shortcuts & help (?)";
    cluster.append(this.buildThemePicker(), helpBtn);

    return cluster;
  }

  /** The theme picker: a popover holding the light/dark mode toggle and the five
   *  accent-palette swatches. Replaces the old lone ◐ button so colour themes flip
   *  the same way light/dark always has. */
  private buildThemePicker(): HTMLButtonElement {
    const pop = popover(this.root, "◐", { title: "Theme & colour palette", className: "theme-popover" });
    pop.trigger.classList.add("icon-btn");

    pop.content.appendChild(el("div", "section-label", "MODE"));
    const modeRow = el("div", "theme-mode");
    const darkBtn = button("Dark", () => { this.applyTheme("dark"); this.refreshThemeUI(); });
    const lightBtn = button("Light", () => { this.applyTheme("light"); this.refreshThemeUI(); });
    darkBtn.classList.add("mode-btn");
    lightBtn.classList.add("mode-btn");
    modeRow.append(darkBtn, lightBtn);
    pop.content.appendChild(modeRow);
    this.themeModeBtns = { light: lightBtn, dark: darkBtn };

    pop.content.appendChild(el("div", "section-label", "ACCENT"));
    const swatches = el("div", "swatch-row");
    for (const a of ACCENTS) {
      const b = button("", () => { applyAccent(a.id); this.refreshThemeUI(); });
      b.className = "accent-swatch";
      b.style.setProperty("--sw", a.swatch);
      b.title = a.label;
      this.accentSwatches.set(a.id, b);
      swatches.appendChild(b);
    }
    pop.content.appendChild(swatches);

    this.refreshThemeUI();
    return pop.trigger;
  }

  /** Repaint the picker's active mode + accent from the live document state. */
  private refreshThemeUI(): void {
    const light = document.documentElement.getAttribute("data-theme") === "light";
    this.themeModeBtns?.light.classList.toggle("active", light);
    this.themeModeBtns?.dark.classList.toggle("active", !light);
    const acc = currentAccent();
    for (const [id, b] of this.accentSwatches) b.classList.toggle("active", id === acc);
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
      ["F", "Mission panel"],
      ["B", "Shipyard (build)"],
      ["N", "Navigation dock"],
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

  /** Toggle the right Navigation dock (keyboard N, its ✕, or the re-open tab). */
  toggleNav(): void { this.setNavOpen(!this.isNavOpen()); }
  isNavOpen(): boolean { return this.navDockEl.style.display !== "none"; }
  private setNavOpen(open: boolean): void {
    this.navDockEl.style.display = open ? "flex" : "none";
    this.navTab.style.display = open ? "none" : "flex";
    setFlag("dock.nav.open", open);
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
    this.refreshFollow();
  }

  /** Choose what the interstellar camera follows (a ship id, or null for Sol) and
   *  repaint the active states. */
  private setFollow(id: string | null): void {
    this.sm.setInterstellarFocus(id);
    this.refreshFollowActive();
  }

  /** Repaint the interstellar FOLLOW list: toggle the whole section by view mode,
   *  and rebuild the ship buttons only when the in-transit id-set actually changes
   *  (the active-state repaint below is cheap and runs every call). */
  private refreshFollow(): void {
    const interstellar = this.sm.viewMode === "interstellar";
    this.followSection.style.display = interstellar ? "block" : "none";
    this.starSection.style.display = interstellar ? "block" : "none";
    if (!interstellar) return;
    const fleet = interstellarFleet(this.sim.world);
    const sig = fleet.map((f) => f.id).join(",");
    if (sig !== this.followSig) {
      this.followSig = sig;
      for (const b of this.followButtons.values()) b.remove();
      this.followButtons.clear();
      for (const f of fleet) {
        const b = button(f.name, () => this.setFollow(f.id));
        b.classList.add("body-btn", "follow-btn");
        this.followList.appendChild(b);
        this.followButtons.set(f.id, b);
      }
    }
    this.refreshFollowActive();
  }

  private refreshFollowActive(): void {
    const focus = this.sm.interstellarFocusId;
    this.solFollowBtn.classList.toggle("active", focus === null);
    for (const [id, b] of this.followButtons) b.classList.toggle("active", id === focus);
    for (const [id, b] of this.starButtons) b.classList.toggle("active", id === focus);
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

  /** Set the light/dark mode: HTML attribute, renderer, and persistence. */
  private applyTheme(next: "light" | "dark"): void {
    document.documentElement.setAttribute("data-theme", next);
    this.sm.setTheme(next);
    try {
      localStorage.setItem("lightlag.theme", next);
    } catch (e) {
      // Private-mode / storage-disabled: theme just won't persist. Non-fatal.
    }
  }

  /** Flip light ⇄ dark (kept for the keyboard shortcut / external callers). */
  toggleTheme(): void {
    const light = document.documentElement.getAttribute("data-theme") === "light";
    this.applyTheme(light ? "dark" : "light");
    this.refreshThemeUI();
  }

  /** Called once per frame. */
  update(fps: number, views: BodyViews): void {
    this.bodyViews = views; // stash the (stable) instance for the body-pick handler
    const t = this.sim.world.t;
    this.dateEl.textContent = formatDate(t);
    this.warpEl.textContent = this.sim.paused ? "paused" : this.sim.warpLabel;
    this.fpsEl.textContent = `${fps.toFixed(0)} fps`;

    this.updateFocusReadout(t);
    this.updateLabels(views);
    // The interstellar FOLLOW list tracks ships dispatched/arrived/deleted over time,
    // and reflects an auto-recenter the view may have triggered (a deleted follow).
    this.refreshFollow();
  }

  private updateFocusReadout(t: number): void {
    // On the interstellar map a focused star takes over the dock footer (which
    // doubles as the star readout there); otherwise it shows the in-system body.
    if (this.sm.viewMode === "interstellar") {
      const focusId = this.sm.interstellarFocusId;
      const star = focusId ? STAR_BY_ID.get(focusId) : undefined;
      if (star) {
        this.showStarReadout(star, t);
        return;
      }
    }

    const def = BODY_BY_ID.get(this.sm.focusId);
    if (!def) return;
    this.focusTitle.textContent = def.name;

    const lines: string[] = [];
    const state = bodyState(def, t);

    if (def.id !== "sun") {
      const rSun = length(state.r);
      lines.push(kvAuto("Distance from Sun", `${(rSun / AU).toFixed(3)} AU`));
      lines.push(kvAuto("Orbital speed", `${(length(state.v) / 1000).toFixed(2)} km/s`));
      lines.push(kvAuto("Solar flux", `${solarFlux(rSun).toFixed(0)} W/m²`));

      const el = bodyElements(def, t);
      const parent = def.parent ? BODY_BY_ID.get(def.parent) : undefined;
      const mu = parent && parent.id !== "sun" ? parent.mu : MU_SUN;
      if (el) {
        const T = orbitalPeriod(el.a, mu);
        lines.push(kvAuto("Orbital period", formatPeriod(T)));
        lines.push(kvAuto("Eccentricity", el.e.toFixed(4)));
        lines.push(kvAuto("Inclination", `${((el.i * 180) / Math.PI).toFixed(2)}°`));
      }

      // Surface physics (drives the landing/takeoff budget in the ship panel).
      lines.push(kvAuto("Surface gravity", `${surfaceGravity(def).toFixed(2)} m/s²`));
      lines.push(kvAuto("Escape velocity", `${(escapeVelocity(def) / 1000).toFixed(2)} km/s`));
      if (def.atmosphere) {
        const bar = def.atmosphere.surfacePressure / 101325;
        lines.push(kvAuto("Surface pressure", bar >= 0.01 ? `${bar.toFixed(2)} atm` : `${def.atmosphere.surfacePressure.toFixed(1)} Pa`));
      } else if (def.hasSurface !== false) {
        lines.push(kvAuto("Atmosphere", "none (airless)"));
      }
    } else {
      lines.push(kvAuto("Role", "central star"));
      lines.push(kvAuto("Luminosity", "3.828×10²⁶ W"));
    }

    // The light-lag teaser: one-way light-time from Earth.
    if (def.id !== "earth") {
      const earth = BODY_BY_ID.get("earth")!;
      const d = distance(bodyState(earth, t).r, state.r);
      lines.push(kvAuto("Light-time from Earth", formatLightTime(d / C)));
    } else {
      lines.push(kvAuto("Light-time from Earth", "— (you are here)"));
    }

    this.focusBody.innerHTML = lines.join("");
  }

  /** Render the focused interstellar system into the dock footer: its live distance
   *  (it drifts under real proper motion), light-time from Sol, spectral class,
   *  luminosity and mass — the "frame that system and read its facts" half of the
   *  click-to-focus feature. */
  private showStarReadout(star: StarDef, t: number): void {
    this.focusTitle.textContent = star.bayer ? `${star.name} (${star.bayer})` : star.name;
    const dLy = length(starPosition(star, t)) / LIGHT_YEAR;
    const lum = star.luminosity >= 1 ? star.luminosity.toFixed(2) : star.luminosity.toPrecision(2);
    const lines = [
      kvAuto("Distance from Sol", `${dLy.toFixed(2)} ly`),
      kvAuto("Light-time from Sol", `${dLy.toFixed(2)} yr`),
      kvAuto("Spectral type", star.spectralType),
      kvAuto("Luminosity", `${lum} L☉`),
      kvAuto("Mass", `${star.massSun.toFixed(3)} M☉`),
    ];
    if (star.con) lines.push(kvAuto("Constellation", star.con));
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
