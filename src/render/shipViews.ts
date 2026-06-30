/**
 * Visual representation of ships: a constant-size marker (cyan coasting, hot
 * orange under thrust) plus its name label. A ship on an interstellar leg is
 * light-years out — far beyond the orrery — so it is painted on the same
 * UNZOOMABLE celestial sphere as the stars (camera-anchored at `SKY_RADIUS`, in
 * the true Sun→ship direction) rather than at a wrong finite range that would
 * parallax against the planets; the to-scale interstellar view draws it (and its
 * Sol→target aim) at real distances. The trajectory line a ship flies is drawn
 * separately by TrajectoryViews (the live forecast arc), so this view owns only
 * the marker and label.
 *
 * Ships are created/destroyed at runtime, so visuals are synced to the world
 * each frame rather than built once.
 */

import * as THREE from "three";
import { type WorldState } from "@lightlag/engine/world";
import { shipWorldState, shipTelemetryDoppler } from "@lightlag/engine/ships";
import { STAR_BY_ID } from "@lightlag/engine/stars";
import { length } from "@lightlag/engine/math/vec3";
import { SKY_RADIUS, starDirection } from "./starViews.ts";
import { type SceneManager } from "./SceneManager.ts";
import { type Visibility } from "./visibility.ts";
import { overlayPalette, dopplerTint } from "./overlayUtil.ts";
import { accentHex } from "./accent.ts";

const THRUST_COLOR = 0xff8a30;
const LOST_COLOR = 0x9a6b6b; // a dim, dead red for a destroyed wreck
const SATELLITE_COLOR = 0x9fb4c8; // pale steel — ingested real satellites (read-only infrastructure)

function makeDotTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.9)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface ShipVisual {
  marker: THREE.Sprite;
  label: HTMLElement;
}

export class ShipViews {
  private dot = makeDotTexture();
  private visuals = new Map<string, ShipVisual>();
  private labelLayer: HTMLElement;
  private tintBase = new THREE.Color(); // reused scratch — no per-frame alloc
  private tintEnd = new THREE.Color();

  constructor(private sm: SceneManager, uiRoot: HTMLElement, private vis: Visibility) {
    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "ship-label-layer";
    uiRoot.appendChild(this.labelLayer);
  }

  private build(id: string): ShipVisual {
    const markerMat = new THREE.SpriteMaterial({
      map: this.dot,
      color: accentHex(),
      sizeAttenuation: false,
      depthWrite: false,
      transparent: true,
    });
    const marker = new THREE.Sprite(markerMat);
    marker.scale.setScalar(0.018);
    this.sm.scene.add(marker);

    const label = document.createElement("div");
    label.className = "ship-label";
    this.labelLayer.appendChild(label);

    const visual: ShipVisual = { marker, label };
    this.visuals.set(id, visual);
    return visual;
  }

  private dispose(id: string, vis: ShipVisual): void {
    this.sm.scene.remove(vis.marker);
    vis.label.remove();
    this.visuals.delete(id);
  }

  update(world: WorldState, t: number): void {
    // Remove visuals for ships that no longer exist.
    for (const [id, vis] of this.visuals) {
      if (!world.ships.has(id)) this.dispose(id, vis);
    }

    // Ships layer hidden, or the interstellar view is active (it tracks ships in
    // transit at its own scale): park every visual and skip the work.
    if (this.sm.viewMode !== "system" || !this.vis.layer("ships")) {
      for (const vis of this.visuals.values()) {
        vis.marker.visible = false;
        vis.label.style.display = "none";
      }
      return;
    }

    const tmp = new THREE.Vector3();
    const w = window.innerWidth;
    const h = window.innerHeight;

    for (const ship of world.ships.values()) {
      const vis = this.visuals.get(ship.id) ?? this.build(ship.id);
      vis.marker.visible = true; // may have been parked while the layer was off
      const thrusting = ship.mode === "thrust";
      const lost = ship.status === "lost";
      // Ingested real satellites (sat-<norad>) are passive infrastructure: a
      // smaller, pale-steel marker that reads distinctly from player craft.
      const isSat = ship.id.startsWith("sat-");
      const base = lost ? LOST_COLOR : thrusting ? THRUST_COLOR : isSat ? SATELLITE_COLOR : accentHex();
      // Doppler tint (opt-in layer): red receding / blue approaching, from the
      // control node's vantage. Render-only; invisible at planetary speeds.
      let color = base;
      if (!lost && this.vis.layer("doppler_tint")) {
        const dop = shipTelemetryDoppler(ship, world.controlNode, t);
        if (dop) color = dopplerTint(base, dop.z, overlayPalette(this.sm.theme), this.tintBase, this.tintEnd);
      }
      (vis.marker.material as THREE.SpriteMaterial).color.setHex(color);
      // Enlarge the focused ship's marker so it stands out among the bodies;
      // satellites ride a touch smaller as passive infrastructure.
      const baseScale = isSat ? 0.012 : 0.018;
      vis.marker.scale.setScalar(this.sm.focusId === ship.id ? baseScale * 1.6 : baseScale);

      const leg = ship.interstellarLeg;
      const star = leg ? STAR_BY_ID.get(leg.targetStar) : undefined;
      if (leg && star) {
        // Interstellar: the ship is light-years out — far beyond the orrery. Paint it
        // on the same UNZOOMABLE sky as the stars (anchored to the camera at
        // SKY_RADIUS) in the true Sun→ship direction, so it reads as a point on the
        // celestial sphere departing toward its target star rather than floating at a
        // wrong finite range that parallaxes against the planets.
        const ws = shipWorldState(ship, t);
        const rmag = length(ws.r);
        const dir = rmag > 1
          ? { x: ws.r.x / rmag, y: ws.r.y / rmag, z: ws.r.z / rmag }
          : starDirection(star, leg.tArrive); // degenerate (at the Sun) → aim at the star
        const cam = this.sm.camera.position;
        vis.marker.position.set(cam.x + dir.x * SKY_RADIUS, cam.y + dir.y * SKY_RADIUS, cam.z + dir.z * SKY_RADIUS);
        this.placeLabel(vis, ship.name, thrusting, ship.id, w, h);
        continue;
      }

      // Marker at the ship's world position through the floating origin. The
      // trajectory line is drawn by TrajectoryViews.
      const ws = shipWorldState(ship, t);
      this.sm.toRender(ws.r, tmp);
      vis.marker.position.copy(tmp);

      this.placeLabel(vis, ship.name, thrusting, ship.id, w, h);
    }
  }

  /** Project the marker to screen space and position the HTML label. */
  private placeLabel(vis: ShipVisual, name: string, thrusting: boolean, id: string, w: number, h: number): void {
    const ndc = vis.marker.position.clone().project(this.sm.camera);
    const visible = ndc.z < 1 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
    if (visible) {
      vis.label.style.display = "block";
      vis.label.textContent = name + (thrusting ? " ▲" : "");
      vis.label.classList.toggle("focused", this.sm.focusId === id);
      const x = (ndc.x * 0.5 + 0.5) * w;
      const y = (-ndc.y * 0.5 + 0.5) * h;
      vis.label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    } else {
      vis.label.style.display = "none";
    }
  }
}
