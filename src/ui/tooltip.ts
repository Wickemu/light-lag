/**
 * Hover/focus definitions for HUD terms.
 *
 * The panels are dense with exact jargon (Δv, periapsis, prograde, aerocapture).
 * Any element tagged with `data-term` gets a floating definition card the moment
 * you hover or keyboard-focus it, read from the {@link glossary}. The shared DOM
 * helpers tag labels they recognise, so coverage spreads without per-call wiring.
 *
 * The card is a single reused element pinned with `position: fixed`, kept out of
 * its own pointer path (`pointer-events: none`) so it never flickers, and clamped
 * to the viewport (flipping above the anchor when there's no room below).
 *
 * The model keys on the term *string*, not a specific element. The live readouts
 * rebuild their `innerHTML` every frame, so the span you hover is destroyed and
 * recreated continuously — tracking element identity would lose the card on every
 * frame. Instead a `pointermove` listener resolves the term under the cursor on
 * each move and only rebuilds the card when that term *changes*; a stationary
 * cursor over a churning row needs no event at all (the static card just stays).
 */

import { defineTerm, escapeTermAttr } from "./glossary.ts";

let tip: HTMLElement | null = null;
let shownTerm: string | null = null;

/** Install the term-tooltip behaviour (idempotent). `root` hosts the card. */
export function installTermTooltips(root: HTMLElement): void {
  if (tip) return;
  tip = document.createElement("div");
  tip.className = "term-tip";
  tip.setAttribute("role", "tooltip");
  tip.style.display = "none";
  root.appendChild(tip);

  // On document so a move onto the bare canvas (a sibling of the overlay) still
  // dismisses the card. The card itself is pointer-events:none, so it's never the
  // resolved target.
  document.addEventListener("pointermove", onMove);
  // Keyboard parity: a tabbed-to term shows its card, blurring hides it.
  document.addEventListener("focusin", onFocus);
  document.addEventListener("focusout", hide);
  // A scroll or layout shift strands the card; hide rather than chase it.
  window.addEventListener("scroll", hide, true);
}

/** Tag a DOM element as a glossary term (no-op when the label isn't defined).
 *  `decorate` adds the dotted-underline/help-cursor hint — on for inline text,
 *  off for buttons and headers that are already obviously interactive. */
export function markTerm(
  elm: HTMLElement,
  label: string = elm.textContent ?? "",
  opts: { decorate?: boolean } = {},
): void {
  if (!defineTerm(label)) return;
  elm.setAttribute("data-term", label.trim());
  if (opts.decorate ?? true) elm.classList.add("term");
}

/** The nearest ancestor (or self) carrying a resolvable `data-term`. */
function termOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const elm = target.closest("[data-term]");
  if (!(elm instanceof HTMLElement)) return null;
  return defineTerm(elm.getAttribute("data-term") ?? "") ? elm : null;
}

function onMove(e: PointerEvent): void {
  syncTo(termOf(e.target));
}

function onFocus(e: FocusEvent): void {
  syncTo(termOf(e.target));
}

/** Reconcile the visible card with the term currently under cursor/focus. */
function syncTo(elm: HTMLElement | null): void {
  if (!elm) { hide(); return; }
  const term = elm.getAttribute("data-term") ?? "";
  if (term === shownTerm) { reposition(elm); return; } // same term — leave the card
  show(elm, term);
}

function show(elm: HTMLElement, term: string): void {
  if (!tip) return;
  const def = defineTerm(term);
  if (!def) { hide(); return; }
  shownTerm = term;
  tip.innerHTML =
    `<div class="term-tip-title">${escapeTermAttr(def.title)}</div>` +
    `<div class="term-tip-def">${escapeTermAttr(def.def)}</div>`;
  tip.style.display = "block";
  reposition(elm);
}

function hide(): void {
  if (!tip || shownTerm === null) return;
  tip.style.display = "none";
  shownTerm = null;
}

/** Anchor the card under the term, clamped to the viewport, flipping above when
 *  it would overflow the bottom. Measured while shown so the sizes are real. */
function reposition(elm: HTMLElement): void {
  if (!tip || tip.style.display === "none") return;
  const margin = 8;
  const gap = 6;
  const r = elm.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = r.left;
  if (left + tw > vw - margin) left = vw - margin - tw;
  if (left < margin) left = margin;

  let top = r.bottom + gap;
  if (top + th > vh - margin) {
    const above = r.top - gap - th;
    top = above >= margin ? above : Math.max(margin, vh - margin - th);
  }

  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}
