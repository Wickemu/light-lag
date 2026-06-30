/**
 * Shared DOM helpers for the HUD panels.
 *
 * These were copy-pasted into every panel (hud, ship, transfer, interstellar)
 * with slightly different names — `el`/`div`, `button`/`btn`, `kv`/`row`. They
 * are collected here so a panel builds its DOM from one vocabulary, and a fix
 * (a tooltip convention, a focus ring) lands in one place.
 *
 * Because the readouts and labelled fields funnel through `kv`/`numberField`/
 * `compactField`, tagging recognised glossary terms here gives every panel hover
 * definitions for free — see {@link glossary} and {@link tooltip}.
 */

import { defineTerm, escapeTermAttr } from "./glossary.ts";
import { markTerm } from "./tooltip.ts";

/** Create an element with an optional class and text content. */
export function el(tag: string, className = "", text = ""): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

/** Shorthand for a <div> with a class (and optional text). */
export function div(className = "", text = ""): HTMLElement {
  return el("div", className, text);
}

/** A <button> wired to a click handler. */
export function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

/** Alias for {@link button} — some panels read better with the shorter name. */
export const btn = button;

/** A key/value readout row as an HTML string (joined into a readout block).
 *  When the key is a known glossary term, it's tagged so the hover card finds it. */
export function kv(k: string, v: string): string {
  return `<div class="kv">${kvKey(k)}<span class="v">${v}</span></div>`;
}

/** A key/value row that splits the NUMBER from its UNIT so the digits right-align
 *  into a clean column down the readout (the unit sits in its own fixed-width
 *  column, so a wide unit like "km/s" never shoves the number around). Pass an
 *  empty `unit` for a bare number — the unit column still reserves its width, so
 *  the number column stays aligned. */
export function kvNum(k: string, num: string, unit = ""): string {
  const u = unit ? `<span class="v-unit">${unit}</span>` : `<span class="v-unit"></span>`;
  return `<div class="kv">${kvKey(k)}<span class="v"><span class="v-num">${num}</span>${u}</span></div>`;
}

/** Like {@link kv}, but auto-splits a trailing unit onto its own column so the
 *  numbers line up — `"1.000 AU"` becomes number "1.000" + unit "AU". Falls back
 *  to a plain row when the value isn't a "number unit" pair (e.g. "none (airless)",
 *  "— (you are here)", a spectral type). Lets a readout keep passing pre-formatted
 *  strings while gaining a clean aligned number column. */
export function kvAuto(k: string, v: string): string {
  // Split ONLY a clean two-token "<number> <unit>" value: the whole string must
  // be exactly a numeric head (a digit, no letters or parens) and a single-token
  // unit. Dates, compound phrases ("1.2 km/s (all free)"), bare numbers and
  // "3.4°" (no space) all fall back to a plain enclosed cell — so a panel can pass
  // pre-formatted strings freely without a misparse mangling them.
  const m = /^(\S+)\s+(\S+)$/.exec(v);
  if (m && /\d/.test(m[1]!) && !/[a-zA-Z(]/.test(m[1]!)) {
    return kvNum(k, m[1]!, m[2]!);
  }
  return kv(k, v);
}

/** The label cell, glossary-tagged when the key is a defined term. */
function kvKey(k: string): string {
  return defineTerm(k)
    ? `<span class="k term" data-term="${escapeTermAttr(k.trim())}">${k}</span>`
    : `<span class="k">${k}</span>`;
}

/** Toggle a button's disabled state and surface the reason as a native tooltip,
 *  so a greyed-out control explains itself on hover instead of failing silently. */
export function setDisabled(b: HTMLButtonElement, disabled: boolean, reason = ""): void {
  b.disabled = disabled;
  if (disabled && reason) b.title = reason;
  else b.removeAttribute("title");
}

/** A labelled number input stacked in a flexible `.field` column. */
export function numberField(
  parent: HTMLElement,
  label: string,
  value: number,
  onChange: (v: number) => void,
): HTMLInputElement {
  const wrap = el("label", "field");
  const lbl = el("span", "field-label", label);
  markTerm(lbl, label);
  wrap.appendChild(lbl);
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.oninput = () => { const v = parseFloat(input.value); if (isFinite(v)) onChange(v); };
  wrap.appendChild(input);
  parent.appendChild(wrap);
  return input;
}

/** A compact centred number input with its label underneath (stage editor rows). */
export function compactField(
  parent: HTMLElement,
  label: string,
  value: number,
  onChange: (v: number) => void,
): void {
  const wrap = el("label", "cfield");
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.oninput = () => { const v = parseFloat(input.value); if (isFinite(v)) onChange(v); };
  const lbl = el("span", "cfield-label", label);
  markTerm(lbl, label);
  wrap.append(input, lbl);
  parent.appendChild(wrap);
}

/** Duration readout: minutes → hours → days, with an em-dash for non-finite. */
export function formatDur(s: number): string {
  if (!isFinite(s)) return "—";
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(2)} hr`;
  return `${(s / 86400).toFixed(2)} d`;
}
