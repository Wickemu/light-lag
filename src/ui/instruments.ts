/**
 * Instrument primitives for the flight console — the "rich instrument panel"
 * building blocks that replace flat lines of text with gauges, bars, sparklines,
 * keyed tables, and a live mini-orbit diagram.
 *
 * The contract every primitive honours: BUILD the DOM once, then MUTATE values
 * per frame. A primitive returns `{ root, set(...) }` (or `.push()`); the panel
 * appends `root` once in its build phase and calls `set()` from its per-frame
 * `update()`. Nothing here rebuilds DOM via innerHTML in the hot path — updates
 * touch `textContent`, a width, a `data-state`, or a single SVG attribute.
 *
 * Colour comes entirely from the theme tokens (`--ok`, `--warn`, `--danger`,
 * `--info`, `--accent`, `--text`, `--text-dim`), so both light and dark work for
 * free. State → token mapping lives in styles.css under the INSTRUMENTS block.
 */

import { el } from "./dom.ts";
import { markTerm } from "./tooltip.ts";

/** Semantic state shared by every instrument; drives the themed colour. */
export type InstrumentState = "ok" | "warn" | "danger" | "info" | "neutral" | "active";

const SVGNS = "http://www.w3.org/2000/svg";

/** Create an SVG element with attributes (SVG needs the namespaced factory). */
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

// ── statPill ──────────────────────────────────────────────────────────────────
export interface StatPill {
  root: HTMLElement;
  set(text: string, state?: InstrumentState): void;
}

/** A small colour-coded status chip (headline state, DRIVE HOT, ORDER EN ROUTE). */
export function statPill(initial = "", state: InstrumentState = "neutral"): StatPill {
  const root = el("span", "ins-pill", initial);
  root.dataset.state = state;
  return {
    root,
    set(text, st = "neutral") {
      if (root.textContent !== text) root.textContent = text;
      if (root.dataset.state !== st) root.dataset.state = st;
    },
  };
}

// ── meter (horizontal bar gauge) ────────────────────────────────────────────────
export interface Meter {
  root: HTMLElement;
  /** `frac` is clamped to 0..1; `text` overrides the right-hand readout. */
  set(frac: number, opts?: { text?: string; state?: InstrumentState }): void;
}

/** A labelled horizontal bar: label · filled track · numeric readout. */
export function meter(label: string, opts: { term?: boolean } = {}): Meter {
  const root = el("div", "ins-meter");
  const head = el("div", "ins-meter-head");
  const lbl = el("span", "ins-meter-label", label);
  if (opts.term !== false) markTerm(lbl, label);
  const val = el("span", "ins-meter-val", "");
  head.append(lbl, val);
  const track = el("div", "ins-meter-track");
  const fill = el("div", "ins-meter-fill");
  track.appendChild(fill);
  root.append(head, track);
  return {
    root,
    set(frac, o = {}) {
      const f = Math.max(0, Math.min(1, isFinite(frac) ? frac : 0));
      const pct = `${(f * 100).toFixed(1)}%`;
      if (fill.style.width !== pct) fill.style.width = pct;
      const st = o.state ?? "info";
      if (fill.dataset.state !== st) fill.dataset.state = st;
      const text = o.text ?? "";
      if (val.textContent !== text) val.textContent = text;
    },
  };
}

// ── radialGauge (SVG arc) ───────────────────────────────────────────────────────
export interface RadialGauge {
  root: HTMLElement;
  set(frac: number, opts?: { text?: string; sub?: string; state?: InstrumentState }): void;
}

/** A compact SVG arc gauge for a hero value (burn progress, T/W). */
export function radialGauge(opts: { size?: number; label?: string } = {}): RadialGauge {
  const size = opts.size ?? 76;
  const r = size / 2 - 7;
  const c = size / 2;
  const circ = 2 * Math.PI * r;
  const root = el("div", "ins-gauge");
  const s = svg("svg", { viewBox: `0 0 ${size} ${size}`, width: size, height: size });
  s.appendChild(svg("circle", { cx: c, cy: c, r, class: "ins-gauge-track" }));
  // Start the arc at 12 o'clock and sweep clockwise.
  const arc = svg("circle", {
    cx: c, cy: c, r,
    class: "ins-gauge-arc",
    "stroke-dasharray": `0 ${circ.toFixed(2)}`,
    transform: `rotate(-90 ${c} ${c})`,
  });
  s.appendChild(arc);
  const valTxt = svg("text", { x: c, y: c, class: "ins-gauge-text", "text-anchor": "middle", "dominant-baseline": "central" });
  s.appendChild(valTxt);
  root.appendChild(s);
  const sub = opts.label ? el("div", "ins-gauge-sub", opts.label) : null;
  if (sub) root.appendChild(sub);
  return {
    root,
    set(frac, o = {}) {
      const f = Math.max(0, Math.min(1, isFinite(frac) ? frac : 0));
      arc.setAttribute("stroke-dasharray", `${(f * circ).toFixed(2)} ${circ.toFixed(2)}`);
      const st = o.state ?? "info";
      if (arc.getAttribute("data-state") !== st) arc.setAttribute("data-state", st);
      const text = o.text ?? `${Math.round(f * 100)}%`;
      if (valTxt.textContent !== text) valTxt.textContent = text;
      if (sub && o.sub !== undefined && sub.textContent !== o.sub) sub.textContent = o.sub;
    },
  };
}

// ── sparkline (SVG trend) ───────────────────────────────────────────────────────
export interface Sparkline {
  root: HTMLElement;
  push(value: number): void;
  reset(): void;
}

/** A tiny rolling trend line; per-frame `push()` mutates one `points` attribute. */
export function sparkline(opts: { width?: number; height?: number; samples?: number } = {}): Sparkline {
  const w = opts.width ?? 56;
  const h = opts.height ?? 16;
  const n = opts.samples ?? 40;
  const root = el("span", "ins-spark");
  const s = svg("svg", { viewBox: `0 0 ${w} ${h}`, width: w, height: h, preserveAspectRatio: "none" });
  const poly = svg("polyline", { class: "ins-spark-line", points: "" });
  s.appendChild(poly);
  root.appendChild(s);
  const buf: number[] = [];
  function redraw(): void {
    if (buf.length < 2) { poly.setAttribute("points", ""); return; }
    let lo = Infinity, hi = -Infinity;
    for (const v of buf) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = hi - lo || 1;
    const step = w / (n - 1);
    const start = n - buf.length; // right-align newest sample
    let pts = "";
    for (let i = 0; i < buf.length; i++) {
      const x = (start + i) * step;
      const y = h - 1 - ((buf[i]! - lo) / span) * (h - 2);
      pts += `${x.toFixed(1)},${y.toFixed(1)} `;
    }
    poly.setAttribute("points", pts.trim());
  }
  return {
    root,
    push(value) {
      if (!isFinite(value)) return;
      buf.push(value);
      if (buf.length > n) buf.shift();
      redraw();
    },
    reset() { buf.length = 0; poly.setAttribute("points", ""); },
  };
}

// ── statTable (keyed label/value grid) ──────────────────────────────────────────
export interface StatTable {
  root: HTMLElement;
  /** Pre-declare a row (fixes display order); label defaults to the key. */
  row(key: string, label?: string): void;
  /** Create-if-missing, show, and update a row's value. */
  set(key: string, value: string, opts?: { state?: InstrumentState }): void;
  /** Hide a row without losing its slot (keeps declared order stable). */
  hide(key: string): void;
  /** How many rows are currently visible — drives "show the group only when it has content". */
  visibleCount(): number;
  clear(): void;
}

/** A compact aligned table that replaces flat kv() dumps. Rows are keyed; the
 *  per-frame path only mutates the value cell's text + state. */
export function statTable(): StatTable {
  const root = el("div", "ins-table");
  interface Row { root: HTMLElement; val: HTMLElement; visible: boolean; }
  const rows = new Map<string, Row>();

  function ensure(key: string, label?: string): Row {
    let row = rows.get(key);
    if (row) return row;
    const r = el("div", "ins-row");
    const k = el("span", "ins-row-k", label ?? key);
    markTerm(k, (label ?? key).trim());
    const v = el("span", "ins-row-v", "");
    r.append(k, v);
    r.style.display = "none";
    root.appendChild(r);
    row = { root: r, val: v, visible: false };
    rows.set(key, row);
    return row;
  }

  return {
    root,
    row(key, label) { ensure(key, label); },
    set(key, value, opts = {}) {
      const row = ensure(key);
      if (!row.visible) { row.root.style.display = ""; row.visible = true; }
      if (row.val.textContent !== value) row.val.textContent = value;
      const st = opts.state ?? "neutral";
      if (row.val.dataset.state !== st) row.val.dataset.state = st;
    },
    hide(key) {
      const row = rows.get(key);
      if (row && row.visible) { row.root.style.display = "none"; row.visible = false; }
    },
    visibleCount() {
      let n = 0;
      for (const r of rows.values()) if (r.visible) n++;
      return n;
    },
    clear() {
      for (const r of rows.values()) { r.root.style.display = "none"; r.visible = false; }
    },
  };
}

// ── miniOrbit (live schematic SVG) ──────────────────────────────────────────────

/** What the mini-orbit should draw this frame. A clean 2-D schematic — NOT the
 *  3-D camera view — so it stays readable at any zoom. */
export type OrbitView =
  | { kind: "orbit"; e: number; nu: number; bound: boolean }
  | { kind: "transfer"; frac: number }
  | { kind: "interstellar"; frac: number }
  | { kind: "landed" }
  | { kind: "none" };

export interface MiniOrbit {
  root: HTMLElement;
  set(view: OrbitView, caption?: string): void;
}

/** A small live diagram: a conic with the ship at its true anomaly, a transfer
 *  progress arc, an interstellar progress line, or a landed marker. The conic
 *  geometry is recomputed only when its shape changes; the ship dot moves every
 *  frame (cheap). */
export function miniOrbit(opts: { width?: number; height?: number } = {}): MiniOrbit {
  const W = opts.width ?? 240;
  const H = opts.height ?? 150;
  const cx = W / 2;
  const cy = H / 2;
  const root = el("div", "ins-orbit");
  const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", preserveAspectRatio: "xMidYMid meet" });

  // Layers (built once; shown/hidden per kind).
  const gOrbit = svg("g", { class: "ins-orbit-conic" });
  const ellipse = svg("path", { class: "ins-orbit-path", d: "" });
  const escapeRay = svg("path", { class: "ins-orbit-escape", d: "" });
  const peri = svg("circle", { class: "ins-orbit-peri", r: 2.4 });
  const apo = svg("circle", { class: "ins-orbit-apo", r: 2.4 });
  gOrbit.append(ellipse, escapeRay, peri, apo);

  const gTransfer = svg("g", { class: "ins-orbit-transfer" });
  const tFrom = svg("circle", { class: "ins-orbit-body", r: 5, cx: 26, cy: H - 26 });
  const tTo = svg("circle", { class: "ins-orbit-target", r: 6, cx: W - 26, cy: 26 });
  const tArc = svg("path", { class: "ins-orbit-arc", d: `M26 ${H - 26} Q ${W / 2} ${H / 2 - 40} ${W - 26} 26` });
  gTransfer.append(tArc, tFrom, tTo);

  const gInter = svg("g", { class: "ins-orbit-interstellar" });
  const iLine = svg("line", { class: "ins-orbit-line", x1: 24, y1: cy, x2: W - 24, y2: cy });
  const iSol = svg("circle", { class: "ins-orbit-body", r: 5, cx: 24, cy });
  const iStar = svg("circle", { class: "ins-orbit-target", r: 5, cx: W - 24, cy });
  gInter.append(iLine, iSol, iStar);

  const gLanded = svg("g", { class: "ins-orbit-landed" });
  const lBody = svg("circle", { class: "ins-orbit-primary", r: 34, cx, cy: cy + 18 });
  const lShip = svg("circle", { class: "ins-orbit-ship", r: 3.4, cx, cy: cy + 18 - 34 });
  gLanded.append(lBody, lShip);

  // Shared elements drawn above the per-kind layers.
  const primary = svg("circle", { class: "ins-orbit-primary", r: 6, cx, cy });
  const ship = svg("circle", { class: "ins-orbit-ship", r: 3.6 });
  const caption = svg("text", { class: "ins-orbit-caption", x: cx, y: H - 6, "text-anchor": "middle" });

  s.append(gTransfer, gInter, gLanded, gOrbit, primary, ship, caption);
  root.appendChild(s);

  // Cache the conic geometry so we only rebuild the path when the shape changes.
  let lastSig = "";

  function showOnly(kind: OrbitView["kind"]): void {
    gOrbit.style.display = kind === "orbit" ? "" : "none";
    gTransfer.style.display = kind === "transfer" ? "" : "none";
    gInter.style.display = kind === "interstellar" ? "" : "none";
    gLanded.style.display = kind === "landed" ? "" : "none";
    primary.style.display = kind === "orbit" ? "" : "none";
    ship.style.display = kind === "orbit" ? "" : "none";
  }

  /** Polar radius (normalised, a=1) at true anomaly nu for eccentricity e. */
  function rNorm(e: number, nu: number): number {
    return (1 - e * e) / (1 + e * Math.cos(nu));
  }

  function setOrbit(e: number, nu: number, bound: boolean): void {
    const sig = `${bound ? "b" : "u"}:${e.toFixed(3)}`;
    if (sig !== lastSig) {
      lastSig = sig;
      if (bound) {
        // Fit the ellipse: span 2a wide, 2b tall, with a margin.
        const pad = 16;
        const b = Math.sqrt(Math.max(1e-6, 1 - e * e));
        const scale = Math.min((W - 2 * pad) / 2, (H - 2 * pad) / (2 * b));
        const aPx = scale;
        const bPx = b * scale;
        const cPx = e * scale; // focus offset from ellipse centre
        // Centre the ellipse in the box; the focus (primary) sits cPx right of centre.
        const fx = cx + cPx;
        // Ellipse path centred at (cx,cy); periapsis on the right.
        ellipse.setAttribute("d", ellipsePath(cx, cy, aPx, bPx));
        ellipse.style.display = "";
        escapeRay.style.display = "none";
        primary.setAttribute("cx", String(fx));
        primary.setAttribute("cy", String(cy));
        peri.setAttribute("cx", String(cx + aPx));
        peri.setAttribute("cy", String(cy));
        apo.setAttribute("cx", String(cx - aPx));
        apo.setAttribute("cy", String(cy));
        peri.style.display = "";
        apo.style.display = "";
        (gOrbit as unknown as { dataset: DOMStringMap }).dataset.fx = String(fx);
        (gOrbit as unknown as { dataset: DOMStringMap }).dataset.scale = String(scale);
      } else {
        // Unbound: body at centre, a dashed escape ray; ship rides along nu.
        ellipse.style.display = "none";
        escapeRay.style.display = "";
        peri.style.display = "none";
        apo.style.display = "none";
        primary.setAttribute("cx", String(cx));
        primary.setAttribute("cy", String(cy));
        (gOrbit as unknown as { dataset: DOMStringMap }).dataset.fx = String(cx);
        (gOrbit as unknown as { dataset: DOMStringMap }).dataset.scale = String((Math.min(W, H) / 2 - 16) / 1.6);
      }
    }
    // Move the ship dot along the conic (every frame).
    const ds = (gOrbit as unknown as { dataset: DOMStringMap }).dataset;
    const fx = Number(ds.fx ?? cx);
    const scale = Number(ds.scale ?? 40);
    if (bound) {
      const r = rNorm(e, nu) * scale;
      ship.setAttribute("cx", (fx + r * Math.cos(nu)).toFixed(1));
      ship.setAttribute("cy", (cy - r * Math.sin(nu)).toFixed(1));
    } else {
      const r = Math.min(rNorm(Math.max(e, 1.0001), nu), 2.2) * scale;
      const sx = cx + r * Math.cos(nu);
      const sy = cy - r * Math.sin(nu);
      ship.setAttribute("cx", sx.toFixed(1));
      ship.setAttribute("cy", sy.toFixed(1));
      escapeRay.setAttribute("d", `M ${cx} ${cy} L ${sx.toFixed(1)} ${sy.toFixed(1)}`);
    }
  }

  return {
    root,
    set(view, cap = "") {
      showOnly(view.kind);
      if (view.kind === "orbit") {
        setOrbit(view.e, view.nu, view.bound);
      } else if (view.kind === "transfer") {
        lastSig = "";
        const f = Math.max(0, Math.min(1, view.frac));
        const p = quadPoint(26, H - 26, W / 2, H / 2 - 40, W - 26, 26, f);
        moveOptional("ins-orbit-progress", p.x, p.y);
      } else if (view.kind === "interstellar") {
        lastSig = "";
        const f = Math.max(0, Math.min(1, view.frac));
        const x = 24 + (W - 48) * f;
        moveOptional("ins-orbit-progress", x, cy);
      } else {
        lastSig = "";
      }
      if (caption.textContent !== cap) caption.textContent = cap;
    },
  };

  /** Lazily create/move the shared progress marker used by transfer/interstellar. */
  function moveOptional(cls: string, x: number, y: number): void {
    let dot = s.querySelector(`.${cls}`) as SVGCircleElement | null;
    if (!dot) {
      dot = svg("circle", { class: `ins-orbit-ship ${cls}`, r: 3.6 });
      s.insertBefore(dot, caption);
    }
    dot.style.display = "";
    dot.setAttribute("cx", x.toFixed(1));
    dot.setAttribute("cy", y.toFixed(1));
  }
}

/** An SVG path for an axis-aligned ellipse centred at (cx,cy) with radii (rx,ry). */
function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  return `M ${cx - rx} ${cy} a ${rx} ${ry} 0 1 0 ${2 * rx} 0 a ${rx} ${ry} 0 1 0 ${-2 * rx} 0`;
}

/** Point at parameter t∈[0,1] along a quadratic Bézier (for the transfer arc). */
function quadPoint(
  x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, t: number,
): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * x0 + 2 * u * t * cx + t * t * x1,
    y: u * u * y0 + 2 * u * t * cy + t * t * y1,
  };
}
