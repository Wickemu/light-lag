/**
 * Mission event feed — derives discrete events from the read-only world by diffing
 * a small per-ship snapshot frame to frame: burns start/finish, transfers depart /
 * enter SOI / capture, flybys complete, spirals finish, interstellar departures and
 * arrivals, landings/liftoffs, contact lost, and orders reaching their ship.
 *
 * It owns no DOM. The closed-panel HUD and the console read {@link recent} to show
 * a rolling log / alerts; the feed is stepped once per frame from the render loop.
 */

import { type WorldState, type Ship } from "../core/world.ts";
import { BODY_BY_ID } from "../core/constants.ts";
import { type InstrumentState } from "./instruments.ts";

export interface MissionEvent {
  /** Sim time the event was detected (s since J2000). */
  t: number;
  shipId: string;
  ship: string;
  text: string;
  state: InstrumentState;
}

interface Snap {
  mode: string;
  lost: boolean;
  departed: boolean;
  inSoi: boolean;
  arrived: boolean;
  landed: string | null;
  spiral: boolean;
  legActive: boolean;
  legArrived: boolean;
  flybysDone: number;
}

function snap(ship: Ship, t: number): Snap {
  const tr = ship.transfer;
  const leg = ship.interstellarLeg;
  return {
    mode: ship.mode,
    lost: ship.status === "lost",
    departed: !!tr?.departed,
    inSoi: !!tr?.inSoi,
    arrived: !!tr?.arrived,
    landed: ship.landed?.bodyId ?? null,
    spiral: !!ship.spiral,
    legActive: !!leg,
    legArrived: !!leg && t >= leg.tArrive,
    flybysDone: tr?.flybys ? tr.flybys.filter((f) => f.done).length : 0,
  };
}

export class EventFeed {
  private prev = new Map<string, Snap>();
  private msgIds = new Map<string, string>(); // command msg id → target ship id
  private log: MissionEvent[] = [];
  private readonly cap = 40;
  private listeners: ((e: MissionEvent) => void)[] = [];

  /** Subscribe to new events (e.g. for transient toasts). */
  onEvent(cb: (e: MissionEvent) => void): void { this.listeners.push(cb); }

  /** The most recent `n` events, newest first. */
  recent(n = 8): MissionEvent[] {
    return this.log.slice(-n).reverse();
  }

  /** Step the feed once per frame against the current world. */
  update(world: WorldState, t: number): void {
    const seen = new Set<string>();
    for (const ship of world.ships.values()) {
      seen.add(ship.id);
      const s = snap(ship, t);
      const p = this.prev.get(ship.id);
      this.prev.set(ship.id, s);
      if (!p) continue; // first sighting: seed, don't announce (avoids load/select spam)
      this.diff(ship, t, p, s);
    }
    for (const id of [...this.prev.keys()]) if (!seen.has(id)) this.prev.delete(id);

    // Orders that have arrived: a command message present last frame, gone now.
    const cur = new Map<string, string>();
    for (const m of world.messages) if (m.kind === "command") cur.set(m.id, m.targetId);
    for (const [id, target] of this.msgIds) {
      if (!cur.has(id)) {
        const ship = world.ships.get(target);
        if (ship) this.emit(t, ship.id, ship.name, `Order reached ${ship.name}`, "info");
      }
    }
    this.msgIds = cur;
  }

  private diff(ship: Ship, t: number, p: Snap, s: Snap): void {
    const name = ship.name;
    if (s.lost && !p.lost) { this.emit(t, ship.id, name, `${name} — CONTACT LOST`, "danger"); return; }
    if (s.mode === "thrust" && p.mode !== "thrust") this.emit(t, ship.id, name, `${name} burn started`, "warn");
    if (s.mode !== "thrust" && p.mode === "thrust") this.emit(t, ship.id, name, `${name} burn complete`, "ok");
    if (s.departed && !p.departed) this.emit(t, ship.id, name, `${name} departed on transfer`, "active");
    if (s.inSoi && !p.inSoi) this.emit(t, ship.id, name, `${name} entered target SOI`, "active");
    if (s.arrived && !p.arrived) this.emit(t, ship.id, name, `${name} captured into orbit`, "ok");
    if (s.flybysDone > p.flybysDone) this.emit(t, ship.id, name, `${name} flyby complete`, "ok");
    if (s.landed && !p.landed) this.emit(t, ship.id, name, `${name} landed on ${BODY_BY_ID.get(s.landed)?.name ?? s.landed}`, "ok");
    if (!s.landed && p.landed) this.emit(t, ship.id, name, `${name} lifted off`, "info");
    if (s.spiral && !p.spiral) this.emit(t, ship.id, name, `${name} began spiral`, "active");
    if (!s.spiral && p.spiral) this.emit(t, ship.id, name, `${name} spiral complete`, "ok");
    if (s.legActive && !p.legActive) this.emit(t, ship.id, name, `${name} interstellar departure`, "active");
    if (s.legArrived && !p.legArrived) this.emit(t, ship.id, name, `${name} reached its star`, "ok");
  }

  private emit(t: number, shipId: string, ship: string, text: string, state: InstrumentState): void {
    const e: MissionEvent = { t, shipId, ship, text, state };
    this.log.push(e);
    if (this.log.length > this.cap) this.log.shift();
    for (const cb of this.listeners) cb(e);
  }
}
