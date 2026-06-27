/**
 * A disclosure section: a clickable header (chevron + label, optional right-hand
 * badge) over a body that shows or hides. The panels accreted into long scrolls
 * with no way to fold the parts you aren't using; this is the one primitive that
 * lets every panel group its content and remember what you left open.
 *
 * Open/closed state persists through {@link uiState} when an `id` is given, so a
 * section you collapse stays collapsed across reloads.
 */

import { el } from "./dom.ts";
import { getFlag, setFlag } from "./uiState.ts";

export interface Collapsible {
  /** The whole section (header + body) — append this to the panel. */
  root: HTMLElement;
  /** The content container — append the section's controls here. */
  body: HTMLElement;
  /** The right-hand badge slot in the header (e.g. a count) — fill as needed. */
  badge: HTMLElement;
  /** Programmatically open/close (does not re-persist unless `persist` is true). */
  setOpen(open: boolean, persist?: boolean): void;
  isOpen(): boolean;
}

export interface CollapsibleOpts {
  /** Persistence key under `section.*`; omit for an ephemeral (unsaved) section. */
  id?: string;
  /** Default open state when nothing is persisted. Defaults to true. */
  open?: boolean;
  /** Called after a user toggle (not on programmatic setOpen). */
  onToggle?: (open: boolean) => void;
}

export function collapsible(label: string, opts: CollapsibleOpts = {}): Collapsible {
  const root = el("div", "section");
  const header = el("button", "section-head") as HTMLButtonElement;
  const chevron = el("span", "section-chevron", "▾");
  const title = el("span", "section-head-label", label);
  const badge = el("span", "section-badge");
  header.append(chevron, title, badge);

  const body = el("div", "section-body");
  root.append(header, body);

  const persistKey = opts.id ? `section.${opts.id}` : null;
  const initial = persistKey ? getFlag(persistKey, opts.open ?? true) : (opts.open ?? true);

  function apply(open: boolean): void {
    root.classList.toggle("collapsed", !open);
    chevron.textContent = open ? "▾" : "▸";
    header.setAttribute("aria-expanded", String(open));
  }
  apply(initial);
  let openState = initial;

  header.onclick = () => {
    openState = !openState;
    apply(openState);
    if (persistKey) setFlag(persistKey, openState);
    opts.onToggle?.(openState);
  };

  return {
    root,
    body,
    badge,
    isOpen: () => openState,
    setOpen(open, persist = false) {
      openState = open;
      apply(open);
      if (persist && persistKey) setFlag(persistKey, open);
    },
  };
}
