/**
 * Shared DOM helpers for the HUD panels.
 *
 * These were copy-pasted into every panel (hud, ship, transfer, interstellar)
 * with slightly different names — `el`/`div`, `button`/`btn`, `kv`/`row`. They
 * are collected here so a panel builds its DOM from one vocabulary, and a fix
 * (a tooltip convention, a focus ring) lands in one place.
 */

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

/** A key/value readout row as an HTML string (joined into a readout block). */
export function kv(k: string, v: string): string {
  return `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
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
  wrap.appendChild(el("span", "field-label", label));
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
  wrap.append(input, el("span", "cfield-label", label));
  parent.appendChild(wrap);
}

/** Duration readout: minutes → hours → days, with an em-dash for non-finite. */
export function formatDur(s: number): string {
  if (!isFinite(s)) return "—";
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(2)} hr`;
  return `${(s / 86400).toFixed(2)} d`;
}
