/**
 * Gravity / momentum vector overlay for the focused object: a dominant gravity
 * arrow toward its primary, a velocity (inertia) arrow tangent to the orbit, and
 * a faint secondary arrow for the Sun's tidal perturbation. The drawn orbit is
 * the "resultant" the two combine into.
 *
 * Arrow LENGTHS are dimensionless multiples of what a circular orbit at the same
 * semi-major axis would feel/move, mapped through a saturating curve and anchored
 * to a fraction of the camera distance — so they stay legible at any zoom and
 * PULSE along an eccentric orbit (long at periapsis, short at apoapsis) without
 * collapsing or overflowing. Honest about relative change, not absolute newtons.
 */

import * as THREE from "three";
import { type WorldState } from "../core/world.ts";
import { bodyForceBreakdown, shipForceBreakdown, type ForceBreakdown } from "../core/forces.ts";
import { BODY_BY_ID } from "../core/constants.ts";
import { normalize } from "../core/math/vec3.ts";
import { type SceneManager } from "./SceneManager.ts";
import { type Visibility } from "./visibility.ts";
import { RenderArrow, screenLengthUnits, overlayPalette } from "./overlayUtil.ts";

const BASE_FRAC = 0.16; // base arrow length as a fraction of camera distance
const MIN_FRAC = 0.18; // floor: apoapsis / faint secondary stays visible
const MAX_FRAC = 1.7; // cap: periapsis / high-e comets don't overflow

/** Saturating map of a "× circular" ratio to a render length: 0→0, 1→1, ∞→2,
 *  then clamped so the arrow neither vanishes nor runs off the screen. */
function arrowLen(base: number, ratio: number): number {
  const f = (2 * ratio) / (1 + ratio);
  return base * Math.min(MAX_FRAC, Math.max(MIN_FRAC, f));
}

export class ForceViews {
  private grav: RenderArrow;
  private vel: RenderArrow;
  private grav2: RenderArrow;
  private _origin = new THREE.Vector3();
  private _dir = new THREE.Vector3();

  constructor(
    private sm: SceneManager,
    private vis: Visibility,
  ) {
    const pal = overlayPalette(sm.theme);
    this.grav = new RenderArrow(sm.scene, pal.gravity);
    this.vel = new RenderArrow(sm.scene, pal.momentum);
    this.grav2 = new RenderArrow(sm.scene, pal.gravity);
  }

  private hideAll(): void {
    this.grav.setVisible(false);
    this.vel.setVisible(false);
    this.grav2.setVisible(false);
  }

  update(world: WorldState, t: number): void {
    // In-system overlay; park it in the interstellar view (and when toggled off).
    if (this.sm.viewMode !== "system" || !this.vis.layer("forces")) {
      this.hideAll();
      return;
    }
    const id = this.sm.focusId;
    let bd: ForceBreakdown | null = null;
    const body = BODY_BY_ID.get(id);
    if (body) bd = bodyForceBreakdown(body, t);
    else {
      const ship = world.ships.get(id);
      if (ship) bd = shipForceBreakdown(ship, t);
    }
    if (!bd) {
      this.hideAll();
      return;
    }

    const pal = overlayPalette(this.sm.theme);
    const base = screenLengthUnits(this.sm, BASE_FRAC);
    const origin = this.sm.toRender(bd.position, this._origin);

    // Dominant gravity (toward the primary).
    const p0 = bd.pulls[0];
    if (p0 && p0.magnitude > 0) {
      this.setDir(p0.gravAccel);
      this.grav.set(origin, this._dir, arrowLen(base, p0.magnitude / bd.gRefA), pal.gravity);
      this.grav.setOpacity(0.95);
    } else {
      this.grav.setVisible(false);
    }

    // Velocity / inertia (tangential).
    if (bd.speed > 1e-6) {
      this.setDir(bd.velocity);
      this.vel.set(origin, this._dir, arrowLen(base, bd.speed / bd.vRefA), pal.momentum);
      this.vel.setOpacity(0.95);
    } else {
      this.vel.setVisible(false);
    }

    // Secondary (Sun) tidal perturbation — faint and short.
    const p1 = bd.pulls[1];
    if (p1 && p1.magnitude > 0) {
      this.setDir(p1.gravAccel);
      this.grav2.set(origin, this._dir, arrowLen(base, p1.magnitude / bd.gRefA), pal.gravity);
      this.grav2.setOpacity(pal.faintOpacity);
    } else {
      this.grav2.setVisible(false);
    }
  }

  private setDir(v: { x: number; y: number; z: number }): void {
    const d = normalize(v);
    this._dir.set(d.x, d.y, d.z);
  }
}
