/**
 * Ship trajectory overlays:
 *   - the LIVE forecast arc each ship is flying right now (replaces the old
 *     closed osculating ellipse in shipViews — it draws the swept arc, handles
 *     hyperbolic/transfer legs, and never snaps because it is capped at the
 *     ship's next scheduled event);
 *   - (Phase 2) the full PLANNED route of a committed transfer and the transfer
 *     planner's preview ghost.
 *
 * The forecast is drawn in the ship's PRIMARY-relative frame anchored at the
 * primary's current position (the orbit-loop idiom), so a bound ellipse reads as
 * a clean frozen loop rather than smearing as the primary drifts. A per-vertex
 * brightness ramp gives the comet tail: dim behind, bright at the ship, fading
 * gently ahead.
 */

import * as THREE from "three";
import { type WorldState } from "../core/world.ts";
import { type Simulation } from "../core/sim.ts";
import { shipForecastPath, type SampledPath } from "../core/trajectory.ts";
import { bodyState } from "../core/ephemeris.ts";
import { BODY_BY_ID } from "../core/constants.ts";
import { type SceneManager } from "./SceneManager.ts";
import { type Visibility } from "./visibility.ts";
import { RenderPolyline, fillPolylineLocal, overlayPalette } from "./overlayUtil.ts";

const SEGMENTS = 256;
const COAST_COLOR = 0x6fe0ff;
const THRUST_COLOR = 0xff8a30;
const FORWARD_FLOOR = 0.5; // brightness at the forward horizon (the nucleus is 1)

// Linear-space base colours (Color() applies the sRGB→working conversion once),
// so the per-vertex ramp matches what material.color would render.
const _coast = new THREE.Color(COAST_COLOR);
const _thrust = new THREE.Color(THRUST_COLOR);

interface ShipTraj {
  forecast: RenderPolyline;
}

export class TrajectoryViews {
  private visuals = new Map<string, ShipTraj>();
  private nextEvent = new Map<string, number>();

  constructor(
    private sm: SceneManager,
    private sim: Simulation,
    private vis: Visibility,
  ) {}

  private build(id: string): ShipTraj {
    const forecast = new RenderPolyline({
      capacity: SEGMENTS + 1,
      color: COAST_COLOR,
      opacity: 0.85,
      vertexColors: true,
    });
    this.sm.scene.add(forecast.object);
    const v: ShipTraj = { forecast };
    this.visuals.set(id, v);
    return v;
  }

  private dispose(id: string, v: ShipTraj): void {
    this.sm.scene.remove(v.forecast.object);
    v.forecast.dispose();
    this.visuals.delete(id);
  }

  /** Earliest scheduled event per ship — caps each forecast at the moment its
   *  conic changes, so the drawn arc is exactly valid (and never snaps). */
  private refreshNextEvents(): void {
    this.nextEvent.clear();
    for (const ev of this.sim.events.toArray()) {
      const id = ev.entityId;
      if (id === undefined) continue;
      const cur = this.nextEvent.get(id);
      if (cur === undefined || ev.t < cur) this.nextEvent.set(id, ev.t);
    }
  }

  update(world: WorldState, t: number): void {
    // Drop visuals for ships that no longer exist.
    for (const [id, v] of this.visuals) {
      if (!world.ships.has(id)) this.dispose(id, v);
    }

    // The forecast rides with the ship marker: hide it when either the dedicated
    // Path layer or the Ships layer is off.
    const show = this.vis.layer("trajectory") && this.vis.layer("ships");
    if (!show) {
      for (const v of this.visuals.values()) v.forecast.setVisible(false);
      return;
    }

    this.refreshNextEvents();
    const tailFloor = overlayPalette(this.sm.theme).tailFloor;

    for (const ship of world.ships.values()) {
      const v = this.visuals.get(ship.id) ?? this.build(ship.id);
      const path = shipForecastPath(ship, t, {
        nextEventT: this.nextEvent.get(ship.id) ?? Infinity,
        segments: SEGMENTS,
      });
      if (!path) {
        v.forecast.setVisible(false);
        continue;
      }
      const primary = BODY_BY_ID.get(path.primary);
      if (!primary) {
        v.forecast.setVisible(false);
        continue;
      }
      fillPolylineLocal(v.forecast, path.points, bodyState(primary, t).r, this.sm);
      this.writeCometColors(v.forecast, path, ship.mode === "thrust", tailFloor);
      v.forecast.setVisible(true);
    }
  }

  /** Brightness ramp: dim (tailFloor) at the trailing end → full at the ship →
   *  FORWARD_FLOOR at the forward horizon. Encodes the comet tail in RGB because
   *  LineBasicMaterial has no per-vertex alpha. */
  private writeCometColors(pl: RenderPolyline, path: SampledPath, thrusting: boolean, tailFloor: number): void {
    const colors = pl.colors;
    if (!colors) return;
    const base = thrusting ? _thrust : _coast;
    const n = path.points.length;
    const head = path.headIndex;
    const last = n - 1;
    for (let k = 0; k < n; k++) {
      let b: number;
      if (k <= head) {
        b = head > 0 ? tailFloor + (1 - tailFloor) * (k / head) : 1;
      } else {
        b = last > head ? 1 + (FORWARD_FLOOR - 1) * ((k - head) / (last - head)) : 1;
      }
      colors[k * 3] = base.r * b;
      colors[k * 3 + 1] = base.g * b;
      colors[k * 3 + 2] = base.b * b;
    }
    pl.markColorsDirty();
  }
}
