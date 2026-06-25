/**
 * Central keyboard input manager. Handles both one-shot key actions (focus,
 * warp, panel toggles, view snaps) and per-frame smooth camera orbit/zoom
 * driven by held keys. Skips all shortcuts when the user is typing in a form
 * field so that Δv inputs and the like are unaffected.
 *
 * Quick reference:
 *   Space        — pause / resume
 *   , / .        — slower / faster time warp
 *   1–8          — focus Sun, Mercury, Venus, Earth, Moon, Mars, Jupiter, Saturn
 *   Tab / Shift+Tab — cycle focus forward / backward
 *   WASD / ↑↓←→  — orbit camera (held; smooth)
 *   + / - (=/_)  — zoom in / out (held; smooth)
 *   R / Home     — reset camera distance for current focus
 *   V            — cycle view presets (isometric → top-down → edge-on)
 *   F            — toggle ship / flight panel
 *   Escape       — close transfer planner (then ship panel if already closed)
 */

import * as THREE from "three";
import type { Simulation } from "../core/sim.ts";
import type { SceneManager } from "../render/SceneManager.ts";
import type { Hud } from "./hud.ts";
import type { ShipPanel } from "./shipPanel.ts";
import type { TransferPanel } from "./transferPanel.ts";
import { BODIES } from "../core/constants.ts";

const ORBIT_SPEED = 1.5; // rad/s while key is held
const ZOOM_SPEED  = 2.0; // distance-multiplier rate per second

const BODY_KEYS: Record<string, string> = {
  "1": "sun",
  "2": "mercury",
  "3": "venus",
  "4": "earth",
  "5": "moon",
  "6": "mars",
  "7": "jupiter",
  "8": "saturn",
};

// View preset directions (unit vectors from target to camera, Z-up ecliptic frame).
const VIEW_DIRS: THREE.Vector3[] = [
  new THREE.Vector3(0, 220, 420).normalize(),        // default isometric
  new THREE.Vector3(0.001, 0, 1).normalize(),        // near-top-down (ecliptic north)
  new THREE.Vector3(1, 0, 0.001).normalize(),        // edge-on (ecliptic side)
];

export class KeyboardManager {
  private held = new Set<string>();
  private viewIndex = 0;

  constructor(
    private sim: Simulation,
    private sm: SceneManager,
    private hud: Hud,
    private shipPanel: ShipPanel,
    private transferPanel: TransferPanel,
  ) {
    window.addEventListener("keydown", (e) => {
      if (this.isTyping(e.target)) return;
      this.held.add(e.key);
      this.onDown(e);
    });
    window.addEventListener("keyup", (e) => {
      this.held.delete(e.key);
    });
    // Prevent stuck-key state when the window loses focus mid-press.
    window.addEventListener("blur", () => this.held.clear());
  }

  private isTyping(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    const tag = (target as HTMLElement).tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      (target as HTMLElement).isContentEditable
    );
  }

  private onDown(e: KeyboardEvent): void {
    const k = e.key;

    // ── Time controls ────────────────────────────────────────────────────────
    if (k === " ") { e.preventDefault(); this.hud.togglePause(); return; }
    if (k === "." || k === ">") { this.sim.cycleWarp(1);  return; }
    if (k === "," || k === "<") { this.sim.cycleWarp(-1); return; }

    // ── Body focus ───────────────────────────────────────────────────────────
    const bodyId = BODY_KEYS[k];
    if (bodyId) { this.hud.focus(bodyId); return; }

    if (k === "Tab") {
      e.preventDefault();
      this.cycleFocus(e.shiftKey ? -1 : 1);
      return;
    }

    // ── Camera controls ──────────────────────────────────────────────────────
    if (k === "v" || k === "V") { this.snapView(); return; }

    if (k === "Home" || k === "r" || k === "R") {
      // Re-snap to a sensible distance for the current focus body.
      this.sm.focusBody(this.sm.focusId);
      return;
    }

    // ── Panel toggles ────────────────────────────────────────────────────────
    if (k === "f" || k === "F") { this.shipPanel.toggle(); return; }

    if (k === "Escape") {
      // Close transfer planner first; if already closed, close ship panel.
      if (this.transferPanel.isOpen()) {
        this.transferPanel.close();
      } else {
        if (this.shipPanel.isOpen()) this.shipPanel.toggle();
      }
      return;
    }
  }

  private cycleFocus(dir: 1 | -1): void {
    const idx = BODIES.findIndex((b) => b.id === this.sm.focusId);
    const next = (idx + dir + BODIES.length) % BODIES.length;
    const body = BODIES[next];
    if (body) this.hud.focus(body.id);
  }

  private snapView(): void {
    this.viewIndex = (this.viewIndex + 1) % VIEW_DIRS.length;
    const dir = VIEW_DIRS[this.viewIndex];
    if (!dir) return;
    const dist = this.sm.camera.position.distanceTo(this.sm.controls.target);
    this.sm.camera.position
      .copy(this.sm.controls.target)
      .addScaledVector(dir, dist);
  }

  /**
   * Smooth per-frame camera orbit and zoom. Call this each frame with real
   * elapsed seconds before sm.render() so OrbitControls picks up the new
   * camera position when it runs its own update.
   */
  tick(dt: number): void {
    const h = this.held;
    const orbitLeft  = h.has("ArrowLeft")  || h.has("a") || h.has("A");
    const orbitRight = h.has("ArrowRight") || h.has("d") || h.has("D");
    const orbitUp    = h.has("ArrowUp")    || h.has("w") || h.has("W");
    const orbitDown  = h.has("ArrowDown")  || h.has("s") || h.has("S");
    const zoomIn     = h.has("+") || h.has("=");
    const zoomOut    = h.has("-") || h.has("_");

    if (!orbitLeft && !orbitRight && !orbitUp && !orbitDown && !zoomIn && !zoomOut) return;

    const camera  = this.sm.camera;
    const target  = this.sm.controls.target;
    const dA      = ORBIT_SPEED * dt;
    const offset  = camera.position.clone().sub(target);

    // Horizontal orbit: rotate around the Z (ecliptic north) axis.
    if (orbitLeft || orbitRight) {
      const qz = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(0, 0, 1),
        (orbitLeft ? 1 : -1) * dA,
      );
      offset.applyQuaternion(qz);
    }

    // Vertical orbit: rotate in the meridional plane.
    // Axis = cross(Z_up, offset); rotating by a negative angle moves camera
    // toward the ecliptic north pole (up arrow = more top-down view).
    if (orbitUp || orbitDown) {
      const axis = new THREE.Vector3()
        .crossVectors(new THREE.Vector3(0, 0, 1), offset)
        .normalize();
      if (axis.lengthSq() > 0.5) { // near-zero when offset ∥ Z — skip
        const q = new THREE.Quaternion().setFromAxisAngle(
          axis,
          (orbitUp ? -1 : 1) * dA,
        );
        const rotated = offset.clone().applyQuaternion(q);
        // Clamp: stay at least 5° away from either pole to avoid gimbal flip.
        if (Math.abs(rotated.clone().normalize().z) < 0.996) {
          offset.copy(rotated);
        }
      }
    }

    // Zoom: scale the distance from target.
    if (zoomIn)  offset.multiplyScalar(Math.max(0.1, 1 - ZOOM_SPEED * dt));
    if (zoomOut) offset.multiplyScalar(1 + ZOOM_SPEED * dt);

    // Clamp within OrbitControls distance limits.
    const r = offset.length();
    const rC = Math.max(this.sm.controls.minDistance,
                        Math.min(this.sm.controls.maxDistance, r));
    if (r !== rC) offset.setLength(rC);

    camera.position.copy(target).add(offset);
    // OrbitControls.update() (called by sm.render()) will read the new
    // camera.position and issue the corresponding lookAt — no manual call needed.
  }
}
