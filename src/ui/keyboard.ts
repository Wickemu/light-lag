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
 *   Q / E        — roll camera (held; smooth)
 *   + / - (=/_)  — zoom in / out (held; smooth)
 *   R / Home     — reset camera framing for the active view
 *   V            — cycle view presets (isometric → top-down → edge-on)
 *   M            — toggle in-system orrery ⇄ interstellar map
 *   F            — toggle ship / flight panel
 *   L            — toggle the lens dock (focal length, DOF, rack focus)
 *   H            — hide / show all HUD chrome (clean capture)
 *   ?            — toggle the help overlay
 *   Escape       — close planner / help (then ship panel if already closed)
 */

import * as THREE from "three";
import type { Simulation } from "@lightlag/engine/sim";
import type { SceneManager } from "../render/SceneManager.ts";
import type { Hud } from "./hud.ts";
import type { ShipPanel } from "./shipPanel.ts";
import type { Shipyard } from "./shipyard.ts";
import type { TransferPanel } from "./transferPanel.ts";
import type { InterstellarPanel } from "./interstellarPanel.ts";

const ORBIT_SPEED = 1.5; // rad/s while key is held
const ZOOM_SPEED  = 2.0; // distance-multiplier rate per second
const ROLL_SPEED  = 1.1; // rad/s of camera bank while Q/E is held

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
    private interstellarPanel: InterstellarPanel,
    private shipyard: Shipyard,
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
      this.hud.cycleFocus(e.shiftKey ? -1 : 1);
      return;
    }

    // ── View switch ──────────────────────────────────────────────────────────
    if (k === "m" || k === "M") { this.hud.toggleView(); return; }

    // ── Camera controls ──────────────────────────────────────────────────────
    if (k === "v" || k === "V") { this.snapView(); return; }

    if (k === "Home" || k === "r" || k === "R") {
      // Re-snap to a sensible framing for whichever view is active.
      this.sm.resetView();
      return;
    }

    // ── Panel toggles ────────────────────────────────────────────────────────
    if (k === "f" || k === "F") { this.shipPanel.toggle(); return; }

    if (k === "b" || k === "B") { this.shipyard.toggle(); return; }

    if (k === "n" || k === "N") { this.hud.toggleNav(); return; }

    if (k === "l" || k === "L") { this.hud.toggleLens(); return; }

    if (k === "h" || k === "H") { this.hud.toggleUi(); return; }

    if (k === "?") { this.hud.toggleHelp(); return; }

    if (k === "Escape") {
      // Close, in order: the Shipyard (full-viewport), interstellar planner,
      // transfer planner, help overlay, the ship panel, the lens dock, then the
      // Navigation dock.
      if (this.shipyard.isOpen()) {
        this.shipyard.close();
      } else if (this.interstellarPanel.isOpen()) {
        this.interstellarPanel.close();
      } else if (this.transferPanel.isOpen()) {
        this.transferPanel.close();
      } else if (this.hud.isHelpOpen()) {
        this.hud.closeHelp();
      } else if (this.shipPanel.isOpen()) {
        this.shipPanel.toggle();
      } else if (this.hud.isLensOpen()) {
        this.hud.closeLens();
      } else if (this.hud.isNavOpen()) {
        this.hud.toggleNav();
      }
      return;
    }
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

    // Roll (camera bank) is independent of the orbit/zoom offset math below and is
    // applied straight to the SceneManager, so handle it first and separately.
    // Both keys down cancels out (no roll), like opposing orbit keys.
    const rollCCW = h.has("q") || h.has("Q");
    const rollCW  = h.has("e") || h.has("E");
    if (rollCCW !== rollCW) this.sm.rollBy((rollCCW ? 1 : -1) * ROLL_SPEED * dt);

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
