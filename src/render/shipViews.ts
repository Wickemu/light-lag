/**
 * Visual representation of ships: a constant-size marker (cyan coasting, hot
 * orange under thrust) plus its name label, and — for an interstellar leg — a
 * streak on the compressed star shell. The trajectory line a ship flies is drawn
 * separately by TrajectoryViews (the live forecast arc), so this view owns only
 * the marker/label/streak.
 *
 * Ships are created/destroyed at runtime, so visuals are synced to the world
 * each frame rather than built once.
 */

import * as THREE from "three";
import { type WorldState } from "../core/world.ts";
import { shipWorldState } from "../core/ships.ts";
import { STAR_BY_ID, starPosition } from "../core/stars.ts";
import { distance } from "../core/math/vec3.ts";
import { starShellRadius, starDirection } from "./starViews.ts";
import { type SceneManager } from "./SceneManager.ts";
import { type Visibility } from "./visibility.ts";

const COAST_COLOR = 0x6fe0ff;
const THRUST_COLOR = 0xff8a30;

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

  constructor(private sm: SceneManager, uiRoot: HTMLElement, private vis: Visibility) {
    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "ship-label-layer";
    uiRoot.appendChild(this.labelLayer);
  }

  private build(id: string): ShipVisual {
    const markerMat = new THREE.SpriteMaterial({
      map: this.dot,
      color: COAST_COLOR,
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

    // Ships layer hidden: park every visual and skip the work.
    if (!this.vis.layer("ships")) {
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
      const color = thrusting ? THRUST_COLOR : COAST_COLOR;
      (vis.marker.material as THREE.SpriteMaterial).color.setHex(color);
      // Enlarge the focused ship's marker so it stands out among the bodies.
      vis.marker.scale.setScalar(this.sm.focusId === ship.id ? 0.018 * 1.6 : 0.018);

      const leg = ship.interstellarLeg;
      const star = leg ? STAR_BY_ID.get(leg.targetStar) : undefined;
      if (leg && star) {
        // Interstellar: the true position is ~1e17 m away — render it on the same
        // compressed star shell, streaking from the Sun out to the star marker by
        // the fraction of the crossing covered.
        const ws = shipWorldState(ship, t);
        // Streak toward the same aim point the engine flies (the star at arrival).
        const aim = starPosition(star, leg.tArrive);
        const D = distance(aim, leg.startPos);
        const f = D > 0 ? Math.min(1, distance(ws.r, leg.startPos) / D) : 0;
        const dir = starDirection(star, leg.tArrive);
        const r = f * starShellRadius(star.distanceLy);
        this.sm.toRender({ x: 0, y: 0, z: 0 }, tmp); // Sun anchor
        vis.marker.position.set(tmp.x + dir.x * r, tmp.y + dir.y * r, tmp.z + dir.z * r);
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
