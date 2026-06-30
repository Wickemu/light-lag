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
import { type WorldState } from "@lightlag/engine/world";
import { type Simulation } from "@lightlag/engine/sim";
import { shipForecastPath, perturbedForecast, type SampledPath } from "@lightlag/engine/trajectory";
import { planRoute, type PlannedRoute, type RouteArgs } from "@lightlag/engine/route";
import { bodyState } from "@lightlag/engine/ephemeris";
import { BODY_BY_ID, DEFAULT_CAPTURE_ALT } from "@lightlag/engine/constants";
import { type SceneManager } from "./SceneManager.ts";
import { type Visibility } from "./visibility.ts";
import { RenderPolyline, fillPolylineLocal, fillPolylineWorld, overlayPalette } from "./overlayUtil.ts";

const SEGMENTS = 256;
const PERTURBED_CAPACITY = 512; // perturbedForecast emits ~TARGET_SAMPLES points
const COAST_COLOR = 0x6fe0ff;
const THRUST_COLOR = 0xff8a30;
const PERTURBED_COLOR = 0xff5fd0; // magenta — the higher-fidelity arc, distinct from the cyan coast
const FORWARD_FLOOR = 0.5; // brightness at the forward horizon (the nucleus is 1)
const MAX_ROUTE_LEGS = 4; // park-from, two helio legs (assist), park-to

// Linear-space base colours (Color() applies the sRGB→working conversion once),
// so the per-vertex ramp matches what material.color would render.
const _coast = new THREE.Color(COAST_COLOR);
const _thrust = new THREE.Color(THRUST_COLOR);

interface ShipTraj {
  forecast: RenderPolyline;
  perturbed: RenderPolyline;
}

export class TrajectoryViews {
  private visuals = new Map<string, ShipTraj>();
  private nextEvent = new Map<string, number>();
  /** Committed-transfer route lines, one polyline pool per ship. */
  private routes = new Map<string, RenderPolyline[]>();
  /** The transfer planner's live preview route (independent of the Route layer). */
  private preview: RenderPolyline[] = [];
  private previewRoute: PlannedRoute | null = null;

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
    const perturbed = new RenderPolyline({
      capacity: PERTURBED_CAPACITY,
      color: PERTURBED_COLOR,
      opacity: 0.9,
    });
    this.sm.scene.add(perturbed.object);
    const v: ShipTraj = { forecast, perturbed };
    this.visuals.set(id, v);
    return v;
  }

  private dispose(id: string, v: ShipTraj): void {
    this.sm.scene.remove(v.forecast.object);
    v.forecast.dispose();
    this.sm.scene.remove(v.perturbed.object);
    v.perturbed.dispose();
    this.visuals.delete(id);
    const pool = this.routes.get(id);
    if (pool) {
      for (const pl of pool) {
        this.sm.scene.remove(pl.object);
        pl.dispose();
      }
      this.routes.delete(id);
    }
  }

  /** Grow a polyline pool to at least `n` lines (lazily, reusing the rest). */
  private ensurePool(pool: RenderPolyline[], n: number): void {
    while (pool.length < n) {
      const pl = new RenderPolyline({ capacity: SEGMENTS + 1, color: 0xffffff, opacity: 0.8 });
      this.sm.scene.add(pl.object);
      pool.push(pl);
    }
  }

  /** Draw a route's legs into a pool; hide any leftover lines. */
  private drawRoute(pool: RenderPolyline[], route: PlannedRoute, color: number): void {
    for (let i = 0; i < pool.length; i++) {
      const leg = route.legs[i];
      if (leg) {
        fillPolylineWorld(pool[i]!, leg.points, this.sm);
        pool[i]!.setColor(color);
        pool[i]!.setVisible(true);
      } else {
        pool[i]!.setVisible(false);
      }
    }
  }

  /**
   * Set (or clear) the transfer planner's preview route. Solved once here; the
   * frame loop re-projects it through the floating origin each frame. Shown
   * whenever set, independent of the Route layer toggle (a transient edit aid).
   */
  setPreviewRoute(args: RouteArgs | null): void {
    this.previewRoute = args ? planRoute({ ...args, segments: SEGMENTS }) : null;
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

    // These are in-system overlays; park them in the interstellar view.
    if (this.sm.viewMode !== "system") {
      for (const v of this.visuals.values()) { v.forecast.setVisible(false); v.perturbed.setVisible(false); }
      for (const pool of this.routes.values()) for (const pl of pool) pl.setVisible(false);
      for (const pl of this.preview) pl.setVisible(false);
      return;
    }

    const pal = overlayPalette(this.sm.theme);

    // ── Live forecast arc (rides with the marker: needs Path AND Ships on) ──────
    const showForecast = this.vis.layer("trajectory") && this.vis.layer("ships");
    if (showForecast) this.refreshNextEvents();
    for (const ship of world.ships.values()) {
      const v = this.visuals.get(ship.id) ?? this.build(ship.id);
      if (!showForecast) {
        v.forecast.setVisible(false);
        continue;
      }
      const path = shipForecastPath(ship, t, {
        nextEventT: this.nextEvent.get(ship.id) ?? Infinity,
        segments: SEGMENTS,
      });
      const primary = path ? BODY_BY_ID.get(path.primary) : undefined;
      if (!path || !primary) {
        v.forecast.setVisible(false);
        continue;
      }
      fillPolylineLocal(v.forecast, path.points, bodyState(primary, t).r, this.sm);
      this.writeCometColors(v.forecast, path, ship.mode === "thrust", pal.tailFloor);
      v.forecast.setVisible(true);
    }

    // ── Perturbed (higher-fidelity) forecast overlay (Perturbed layer + planning
    //    fidelity on): the continuous third-body arc drawn against the two-body coast,
    //    so the divergence is visible. Read-only; gated, so it never costs when off. ──
    const showPerturbed = this.vis.layer("perturbed") && this.vis.layer("ships");
    for (const ship of world.ships.values()) {
      const v = this.visuals.get(ship.id);
      if (!v) continue;
      if (!showPerturbed) { v.perturbed.setVisible(false); continue; }
      const fc = perturbedForecast(ship, t);
      const primary = fc ? BODY_BY_ID.get(fc.path.primary) : undefined;
      if (!fc || !primary || fc.path.points.length < 2) { v.perturbed.setVisible(false); continue; }
      fillPolylineLocal(v.perturbed, fc.path.points, bodyState(primary, t).r, this.sm);
      v.perturbed.setVisible(true);
    }

    // ── Committed planned routes (Route layer): the whole path of a transfer that
    //    has been committed but not yet departed (during transit the forecast arc
    //    already shows the swept path). ───────────────────────────────────────────
    const showRoute = this.vis.layer("route");
    for (const ship of world.ships.values()) {
      const tr = ship.transfer;
      const wants = showRoute && !!tr && !tr.departed && !tr.arrived;
      let pool = this.routes.get(ship.id);
      if (!wants) {
        if (pool) for (const pl of pool) pl.setVisible(false);
        continue;
      }
      const from = BODY_BY_ID.get(ship.primary === "sun" ? "earth" : ship.primary);
      const target = BODY_BY_ID.get(tr!.targetId);
      const route = planRoute({
        fromId: from?.id ?? "earth",
        targetId: tr!.targetId,
        tDepart: tr!.tDepart,
        tArrive: tr!.tArrive,
        rParkFrom: from ? from.radius + DEFAULT_CAPTURE_ALT : undefined,
        rParkTo: target ? target.radius + DEFAULT_CAPTURE_ALT : undefined,
        flybys: tr!.flybys ? tr!.flybys.map((f) => ({ bodyId: f.bodyId, tFlyby: f.tFlyby })) : undefined,
        segments: SEGMENTS,
      });
      if (!route.ok) {
        if (pool) for (const pl of pool) pl.setVisible(false);
        continue;
      }
      if (!pool) {
        pool = [];
        this.routes.set(ship.id, pool);
      }
      this.ensurePool(pool, Math.min(MAX_ROUTE_LEGS, route.legs.length));
      this.drawRoute(pool, route, pal.route);
    }

    // ── Transfer-planner preview (independent of the Route toggle) ──────────────
    if (this.previewRoute && this.previewRoute.ok) {
      this.ensurePool(this.preview, Math.min(MAX_ROUTE_LEGS, this.previewRoute.legs.length));
      this.drawRoute(this.preview, this.previewRoute, pal.preview);
    } else {
      for (const pl of this.preview) pl.setVisible(false);
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
