/**
 * Shared show/hide state for everything the renderer draws.
 *
 * One small observable object, written by the HUD's layer/visibility controls
 * and read every frame by each view (bodies, stars, ships, comms). Keeping it
 * here — not inside any one view — lets a single toggle reach the body marker,
 * its sphere, its orbit line, and its label together, and lets the UI subscribe
 * once to repaint its toggles whenever state changes from anywhere.
 *
 * Two axes of control:
 *   - KIND flags gate a whole class at once (all moons, all comets, …).
 *   - per-body overrides hide one object while its kind stays visible.
 * A body is drawn iff its kind is on AND it is not individually hidden.
 *
 * LAYER flags gate the cross-cutting overlays that aren't a body kind: orbit
 * lines, name labels, the nearby-star sky, ships, and in-flight comms packets.
 */

import { type BodyKind } from "../core/constants.ts";

/** Cross-cutting overlay toggles (not tied to a single body kind). */
export type LayerKey =
  | "orbits"
  | "trajectory"
  | "route"
  | "labels"
  | "ships"
  | "comms"
  | "stars"
  | "starLabels"
  | "forces";

export class Visibility {
  private kinds: Record<BodyKind, boolean> = {
    star: true, planet: true, dwarf: true, asteroid: true, moon: true, comet: true,
  };
  private layers: Record<LayerKey, boolean> = {
    orbits: true, trajectory: true, route: false, labels: true, ships: true,
    comms: true, stars: true, starLabels: true, forces: false,
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

  // ── Body kinds ─────────────────────────────────────────────────────────────
  kindVisible(k: BodyKind): boolean {
    return this.kinds[k];
  }
  setKind(k: BodyKind, on: boolean): void {
    if (this.kinds[k] === on) return;
    this.kinds[k] = on;
    this.emit();
  }
  toggleKind(k: BodyKind): void {
    this.setKind(k, !this.kinds[k]);
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

  // ── Per-body overrides ─────────────────────────────────────────────────────
  /** Whether a body is drawn: its kind is on AND it isn't individually hidden. */
  bodyVisible(id: string, kind: BodyKind): boolean {
    return this.kinds[kind] && !this.hidden.has(id);
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
}
