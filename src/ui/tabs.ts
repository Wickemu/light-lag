/**
 * A type-led tab strip — a row of labels (the active one underlined in the accent)
 * over a stack of panes, exactly one shown. It replaces a column of disclosure
 * sections with one switchable surface, so a panel reads as a few tabs instead of
 * an endless scroll.
 *
 * Tabs can be shown/hidden every frame: a tab whose pane has no content this frame
 * is pulled from the strip, and if it was the active one the selection falls back
 * to the first still-visible tab — so contextual tabs (a Route only while in
 * transit, an Ops only when an action is available) appear and vanish cleanly. The
 * chosen tab persists across reloads when an `id` is given.
 *
 * Build once, mutate per frame: `add()` in the build phase, `setVisible()` from the
 * per-frame update, then one `refresh()` to repaint the bar.
 */

import { el, button } from "./dom.ts";
import { getFlag, setFlag } from "./uiState.ts";

export interface Tabs {
  /** The whole control (bar + panes) — append once to the panel. */
  root: HTMLElement;
  /** Register a tab; returns the pane element to fill with that tab's content. */
  add(key: string, label: string): HTMLElement;
  /** Show or hide a tab (and its pane) — e.g. drive it from "does this pane have
   *  content this frame". Call `refresh()` afterwards to settle the active tab. */
  setVisible(key: string, visible: boolean): void;
  /** Select a tab (no-op if hidden/unknown). */
  select(key: string): void;
  /** After visibility changes: guarantee the active tab is a visible one (else the
   *  first visible), then repaint the bar's active underline. */
  refresh(): void;
}

interface TabEntry {
  key: string;
  btn: HTMLButtonElement;
  pane: HTMLElement;
  visible: boolean;
}

export function tabs(opts: { id?: string } = {}): Tabs {
  const root = el("div", "tabs");
  const bar = el("div", "tab-bar");
  const panes = el("div", "tab-panes");
  root.append(bar, panes);

  const entries: TabEntry[] = [];
  const byKey = new Map<string, TabEntry>();
  let active = "";
  // Persisted as a 0/1 bit per (id, key): a tiny reuse of the boolean flag store —
  // exactly one key is "1" (the remembered tab). Avoids a separate string store.
  const persist = opts.id ? `tab.${opts.id}` : null;

  function paint(): void {
    for (const e of entries) {
      e.btn.style.display = e.visible ? "" : "none";
      e.btn.classList.toggle("active", e.key === active);
      e.pane.style.display = e.visible && e.key === active ? "" : "none";
    }
  }

  function select(key: string): void {
    const e = byKey.get(key);
    if (!e || !e.visible) return;
    active = key;
    if (persist) for (const x of entries) setFlag(`${persist}.${x.key}`, x.key === key);
    paint();
  }

  return {
    root,
    add(key, label) {
      const btn = button(label, () => select(key));
      btn.className = "tab";
      bar.appendChild(btn);
      const pane = el("div", "tab-pane");
      pane.style.display = "none";
      panes.appendChild(pane);
      const e: TabEntry = { key, btn, pane, visible: true };
      entries.push(e);
      byKey.set(key, e);
      // First tab added becomes the initial active one (a persisted choice wins in
      // refresh()).
      if (!active) active = key;
      return pane;
    },
    setVisible(key, visible) {
      const e = byKey.get(key);
      if (e) e.visible = visible;
    },
    select,
    refresh() {
      // Honour the remembered tab whenever it's currently visible. Clicks persist
      // their choice, so re-applying it each frame just keeps the selection stable
      // (and restores it across reloads).
      if (persist) {
        const saved = entries.find((e) => e.visible && getFlag(`${persist}.${e.key}`, false));
        if (saved) active = saved.key;
      }
      // Fall back to the first visible tab if the active one isn't shown (a
      // contextual tab vanished, or nothing chosen yet).
      if (!byKey.get(active)?.visible) active = entries.find((e) => e.visible)?.key ?? "";
      paint();
    },
  };
}
