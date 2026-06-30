/**
 * Shared show/hide state for everything the renderer draws.
 *
 * One small observable object, written by the HUD's layer/visibility controls
 * and read every frame by each view (bodies, stars, ships, comms). Keeping it
 * here — not inside any one view — lets a single toggle reach the body marker,
 * its sphere, its orbit line, and its label together, and lets the UI subscribe
 * once to repaint its toggles whenever state changes from anywhere.
 *
 * Bodies have ONE source of truth: a per-body `hidden` set. A body is drawn iff
 * it is not in that set. Group actions (show/hide a whole kind, planetary
 * system or small-body region, or "show only this group") are just bulk writes
 * to that set — so whichever group action you take last simply WINS, overriding
 * any per-body or earlier group rule, with no second masking axis to leak a
 * stale "hidden" through a later "show". This is the supersede contract the FOCUS
 * list relies on.
 *
 * LAYER flags gate the cross-cutting overlays that aren't a body kind: orbit
 * lines, name labels, the nearby-star sky, ships, and in-flight comms packets.
 */

/** Cross-cutting overlay toggles (not tied to a single body kind). */
export type LayerKey =
  | "orbits"
  | "trajectory"
  | "route"
  | "perturbed"
  | "labels"
  | "ships"
  | "comms"
  | "doppler_tint"
  | "stars"
  | "starLabels"
  | "constellations"
  | "forces";

/** All layer keys, for iterating (e.g. hydrating/persisting saved toggles). */
export const LAYER_KEYS: LayerKey[] = [
  "orbits", "trajectory", "route", "perturbed", "labels", "ships",
  "comms", "doppler_tint", "stars", "starLabels", "constellations", "forces",
];

export class Visibility {
  private layers: Record<LayerKey, boolean> = {
    orbits: true, trajectory: true, route: false, perturbed: false, labels: true, ships: true,
    comms: true, doppler_tint: false, stars: true, starLabels: true,
    constellations: false, forces: false,
  };
  private hidden = new Set<string>();
  private listeners = new Set<() => void>();

  /** Subscribe to any change (UI repaint). Returns an unsubscribe fn. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  // ── Cross-cutting layers ───────────────────────────────────────────────────
  layer(k: LayerKey): boolean {
    return this.layers[k];
  }
  setLayer(k: LayerKey, on: boolean): void {
    if (this.layers[k] === on) return;
    this.layers[k] = on;
    this.emit();
  }
  toggleLayer(k: LayerKey): void {
    this.setLayer(k, !this.layers[k]);
  }

  // ── Per-body visibility (the single source of truth) ───────────────────────
  /** Whether a body is drawn: simply that it isn't in the hidden set. */
  bodyVisible(id: string): boolean {
    return !this.hidden.has(id);
  }
  bodyHidden(id: string): boolean {
    return this.hidden.has(id);
  }
  setBodyHidden(id: string, hidden: boolean): void {
    if (hidden === this.hidden.has(id)) return;
    if (hidden) this.hidden.add(id);
    else this.hidden.delete(id);
    this.emit();
  }
  toggleBody(id: string): void {
    this.setBodyHidden(id, !this.hidden.has(id));
  }

  // ── Group actions (the supersede primitives) ───────────────────────────────
  /** Show or hide a whole set of bodies at once. Writing every member's state
   *  directly is what lets the latest group action override any earlier rule:
   *  there is no separate kind flag left to keep a member hidden behind a
   *  group-level "show". */
  setGroupHidden(ids: Iterable<string>, hidden: boolean): void {
    let changed = false;
    for (const id of ids) {
      if (hidden) {
        if (!this.hidden.has(id)) { this.hidden.add(id); changed = true; }
      } else if (this.hidden.delete(id)) {
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** Isolate a group: show exactly `show`, hide every other body in `universe`. */
  showOnly(show: Iterable<string>, universe: Iterable<string>): void {
    const keep = show instanceof Set ? show : new Set(show);
    let changed = false;
    for (const id of universe) {
      const wantHidden = !keep.has(id);
      if (wantHidden) {
        if (!this.hidden.has(id)) { this.hidden.add(id); changed = true; }
      } else if (this.hidden.delete(id)) {
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** A copy of the hidden set — paired with {@link restoreHidden} so the HUD can
   *  snapshot the visibility state before a "show only" and put it back on undo. */
  snapshotHidden(): Set<string> {
    return new Set(this.hidden);
  }

  /** Replace the hidden set wholesale (the "show only" undo). */
  restoreHidden(snapshot: Set<string>): void {
    if (this.hidden.size === snapshot.size && [...this.hidden].every((id) => snapshot.has(id))) return;
    this.hidden = new Set(snapshot);
    this.emit();
  }
}
