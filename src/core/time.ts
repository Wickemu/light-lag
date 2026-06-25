/**
 * The clock and the event queue.
 *
 * Sim time `t` is seconds since J2000 (2000-01-01 12:00 TT), an f64. Real
 * transfers take months, so the player must fast-forward up to ~1e6×; because
 * coasting bodies are evaluated analytically (see ephemeris.ts), advancing the
 * clock a million-fold is exact and cheap. The only thing that will force small
 * steps is an active burn; once powered flight lands (Phase 2) the sim will clamp
 * the warp during burns ("time slows near burns") so the integrator never sees a
 * huge dt. In Phase 1 everything coasts, so no clamp is needed yet.
 *
 * The event queue is a binary min-heap keyed by time, so fast-forward can jump
 * straight to the next scheduled thing (burn ignition, SOI crossing, message
 * arrival, window opening) instead of grinding through empty seconds.
 */

import { DAY, J2000_JD } from "./constants.ts";

// ── Time-warp levels: sim-seconds advanced per real second ──────────────────
export interface WarpLevel {
  factor: number;
  label: string;
}

export const WARP_LEVELS: WarpLevel[] = [
  { factor: 1, label: "1× (real time)" },
  { factor: 10, label: "10×" },
  { factor: 60, label: "1 min/s" },
  { factor: 600, label: "10 min/s" },
  { factor: 3_600, label: "1 hr/s" },
  { factor: 21_600, label: "6 hr/s" },
  { factor: 86_400, label: "1 day/s" },
  { factor: 604_800, label: "1 wk/s" },
  { factor: 2_592_000, label: "30 day/s" },
  { factor: 15_768_000, label: "0.5 yr/s" },
  { factor: 31_557_600, label: "1 yr/s" },
];

// ── Event queue (binary min-heap on .t) ─────────────────────────────────────
export type SimEventKind =
  | "burn-ignite"
  | "burn-cutoff"
  | "soi-crossing"
  | "message-arrival"
  | "window-open"
  | "transfer-depart"
  | "transfer-arrive";

export interface SimEvent {
  t: number; // absolute sim time the event fires (s since J2000)
  kind: SimEventKind;
  entityId?: string;
  data?: unknown;
}

export class EventQueue {
  private heap: SimEvent[] = [];

  get size(): number {
    return this.heap.length;
  }

  /** Time of the earliest pending event, or +Infinity if none. */
  nextTime(): number {
    return this.heap.length > 0 ? this.heap[0]!.t : Infinity;
  }

  push(ev: SimEvent): void {
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (h[parent]!.t <= h[i]!.t) break;
      [h[parent], h[i]] = [h[i]!, h[parent]!];
      i = parent;
    }
  }

  /** Pop the earliest event if it is due at or before tMax, else undefined. */
  popDue(tMax: number): SimEvent | undefined {
    const h = this.heap;
    if (h.length === 0 || h[0]!.t > tMax) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftDown(i: number): void {
    const h = this.heap;
    const n = h.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && h[l]!.t < h[smallest]!.t) smallest = l;
      if (r < n && h[r]!.t < h[smallest]!.t) smallest = r;
      if (smallest === i) break;
      [h[smallest], h[i]] = [h[i]!, h[smallest]!];
      i = smallest;
    }
  }

  clear(): void {
    this.heap.length = 0;
  }

  toArray(): SimEvent[] {
    return [...this.heap].sort((a, b) => a.t - b.t);
  }
}

// ── Calendar conversion (for display only — the sim runs on f64 seconds) ─────
export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
}

/** Sim time (s since J2000) -> Julian Date. */
export function tToJulianDate(t: number): number {
  return J2000_JD + t / DAY;
}

/**
 * Julian Date -> Gregorian calendar (Fliegel & Van Flandern). Proleptic
 * Gregorian; good for any date the game will plausibly reach.
 */
export function julianDateToCalendar(jd: number): CalendarDate {
  const z = Math.floor(jd + 0.5);
  const frac = jd + 0.5 - z;

  let a = z;
  if (z >= 2_299_161) {
    const alpha = Math.floor((z - 1_867_216.25) / 36_524.25);
    a = z + 1 + alpha - Math.floor(alpha / 4);
  }
  const b = a + 1524;
  const c = Math.floor((b - 122.1) / 365.25);
  const d = Math.floor(365.25 * c);
  const e = Math.floor((b - d) / 30.6001);

  const day = b - d - Math.floor(30.6001 * e);
  const month = e < 14 ? e - 1 : e - 13;
  const year = month > 2 ? c - 4716 : c - 4715;

  let seconds = frac * DAY;
  const hour = Math.floor(seconds / 3600);
  seconds -= hour * 3600;
  const minute = Math.floor(seconds / 60);
  seconds -= minute * 60;

  return { year, month, day, hour, minute, second: seconds };
}

export function tToCalendar(t: number): CalendarDate {
  return julianDateToCalendar(tToJulianDate(t));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Human-readable Terrestrial Time (TT) date string, e.g. "2031-Mar-14 08:22".
 *  TT leads UTC by ~69 s in this era; immaterial at our arc-minute ephemeris. */
export function formatDate(t: number): string {
  const c = tToCalendar(t);
  const pad = (n: number, w = 2) => String(Math.floor(n)).padStart(w, "0");
  return `${pad(c.year, 4)}-${MONTHS[c.month - 1]}-${pad(c.day)} ${pad(c.hour)}:${pad(c.minute)}`;
}
