/**
 * Colour themes — a switchable accent palette that flips like light/dark.
 *
 * The light/dark THEME (surfaces, text, legibility over the scene) is orthogonal
 * to the ACCENT palette (the one signature hue: selection, active toggles, the
 * primary action, live values). Theme lives on `data-theme`; accent lives on
 * `data-accent`, both on <html>, both restored before first paint by the inline
 * script in index.html and persisted to localStorage.
 *
 * Each accent carries two faces: a HUD `swatch` (for the picker dot — the CSS
 * `--accent` is set per accent×theme in styles.css) and a brighter `scene` hex
 * for the additive 3D overlay lines (see render/accent.ts). Cyan is the default
 * and needs no CSS block — it's baked into the base theme tokens.
 */

import { setSceneAccent } from "../render/accent.ts";

export type AccentName = "cyan" | "amber" | "green" | "violet" | "signal";

export interface AccentDef {
  id: AccentName;
  label: string;
  swatch: string; // picker dot (a representative dark-theme HUD accent)
  scene: number; // brighter 3D-overlay hex
}

/** The shipped palettes, in picker order. Cyan first (the default). */
export const ACCENTS: AccentDef[] = [
  { id: "cyan", label: "Telemetry", swatch: "#4fd1e0", scene: 0x6fe0ff },
  { id: "amber", label: "Amber", swatch: "#ffc14d", scene: 0xffc266 },
  { id: "green", label: "Phosphor", swatch: "#5fe3a0", scene: 0x74f0a8 },
  { id: "violet", label: "Plasma", swatch: "#b39cff", scene: 0xc0a8ff },
  { id: "signal", label: "Signal", swatch: "#9fd4ff", scene: 0xbfe4ff },
];

export const DEFAULT_ACCENT: AccentName = "cyan";
const STORAGE_KEY = "lightlag.accent";

const BY_ID = new Map(ACCENTS.map((a) => [a.id, a]));

function defOf(name: string | null): AccentDef {
  return (name && BY_ID.get(name as AccentName)) || BY_ID.get(DEFAULT_ACCENT)!;
}

/** The persisted accent (or the document's already-restored one, or the default). */
export function currentAccent(): AccentName {
  const attr = document.documentElement.getAttribute("data-accent");
  if (attr && BY_ID.has(attr as AccentName)) return attr as AccentName;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && BY_ID.has(saved as AccentName)) return saved as AccentName;
  } catch {
    // private-mode / disabled storage: fall through to default
  }
  return DEFAULT_ACCENT;
}

/** Apply an accent: set `data-accent` (drives the CSS tokens), retint the 3D
 *  overlays, and persist. Mirrors the light/dark theme toggle. */
export function applyAccent(name: AccentName): void {
  const def = defOf(name);
  document.documentElement.setAttribute("data-accent", def.id);
  setSceneAccent(def.scene);
  try {
    localStorage.setItem(STORAGE_KEY, def.id);
  } catch {
    // non-fatal: the in-session choice still applies, it just won't persist
  }
}

/** Sync the 3D scene accent to whatever the bootstrap restored — call once at
 *  startup so the canvas agrees with the HUD on the first frame. */
export function initAccent(): void {
  const def = defOf(document.documentElement.getAttribute("data-accent"));
  // Ensure the attribute is present (the bootstrap only sets it when a non-default
  // accent was saved), so the picker's active state reads correctly.
  document.documentElement.setAttribute("data-accent", def.id);
  setSceneAccent(def.scene);
}
