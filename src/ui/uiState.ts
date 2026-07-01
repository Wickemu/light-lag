/**
 * Persisted UI layout state — a thin, fail-soft localStorage wrapper.
 *
 * The HUD's organisation (which docks are open, which disclosure sections are
 * expanded, which scene layers are on, whether the FPS readout shows) is a user
 * preference that should survive a reload. It lives under one `lightlag.ui`
 * key as a flat bag of booleans, mirroring the try/catch guard the theme has
 * always used so private-mode / disabled-storage degrades to "just don't
 * persist" rather than throwing.
 *
 * Keys are namespaced strings the caller owns (e.g. `dock.mission`,
 * `section.designer`, `layer.orbits`, `showFps`). Unknown keys fall back to the
 * caller-supplied default, so adding a new toggle never needs a migration.
 */

const STORAGE_KEY = "lightlag.ui";

// The bag holds mostly booleans (toggles), plus a few small string preferences
// (e.g. the FOCUS list ordering mode) and numbers (e.g. the lens focal length).
// All share the one namespaced store.
type Bag = Record<string, boolean | string | number>;

let cache: Bag | null = null;

function load(): Bag {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cache = raw ? (JSON.parse(raw) as Bag) : {};
  } catch {
    // Private-mode / storage-disabled / corrupt JSON: start empty, don't persist.
    cache = {};
  }
  return cache;
}

function save(bag: Bag): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bag));
  } catch {
    // Non-fatal: the in-memory cache still reflects the session's choices.
  }
}

/** Read a persisted flag, or `fallback` if it was never set (or holds a non-boolean). */
export function getFlag(key: string, fallback: boolean): boolean {
  const v = load()[key];
  return typeof v === "boolean" ? v : fallback;
}

/** Write a persisted flag. */
export function setFlag(key: string, value: boolean): void {
  const bag = load();
  bag[key] = value;
  save(bag);
}

/** Read a persisted string preference, or `fallback` if unset (or non-string). */
export function getString(key: string, fallback: string): string {
  const v = load()[key];
  return typeof v === "string" ? v : fallback;
}

/** Write a persisted string preference. */
export function setString(key: string, value: string): void {
  const bag = load();
  bag[key] = value;
  save(bag);
}

/** Read a persisted number preference, or `fallback` if unset (or non-finite). */
export function getNumber(key: string, fallback: number): number {
  const v = load()[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Write a persisted number preference. */
export function setNumber(key: string, value: number): void {
  const bag = load();
  bag[key] = value;
  save(bag);
}
