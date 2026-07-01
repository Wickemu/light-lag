/**
 * Visual representation of stations — persistent propellant depots. A constant-size
 * amber marker plus a name label, positioned via the engine's `stationWorldState`
 * (the station's fixed conic about its primary, propagated along its orbit). Stations
 * are created at runtime (deployed depots), so visuals are synced to the world each
 * frame rather than built once — the same pattern as ShipViews. Depots read distinctly
 * from ship cyan and satellite steel so the player can tell infrastructure apart.
 *
 * Presentation only: nothing here touches `WorldState`, so it is hash-neutral.
 */

import * as THREE from "three";
import { type WorldState } from "@lightlag/engine/world";
import { stationWorldState } from "@lightlag/engine/depot";
import { type SceneManager } from "./SceneManager.ts";

const DEPOT_COLOR = 0xe0b060; // warm amber — a fuel depot, distinct from ship cyan / sat steel

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

interface StationVisual {
  marker: THREE.Sprite;
  label: HTMLElement;
}

export class StationViews {
  private dot = makeDotTexture();
  private visuals = new Map<string, StationVisual>();
  private labelLayer: HTMLElement;

  constructor(private sm: SceneManager, uiRoot: HTMLElement) {
    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "ship-label-layer";
    uiRoot.appendChild(this.labelLayer);
  }

  private build(id: string): StationVisual {
    const markerMat = new THREE.SpriteMaterial({
      map: this.dot,
      color: DEPOT_COLOR,
      sizeAttenuation: false,
      depthWrite: false,
      transparent: true,
    });
    const marker = new THREE.Sprite(markerMat);
    marker.scale.setScalar(0.015);
    this.sm.scene.add(marker);

    const label = document.createElement("div");
    label.className = "ship-label";
    this.labelLayer.appendChild(label);

    const visual: StationVisual = { marker, label };
    this.visuals.set(id, visual);
    return visual;
  }

  private dispose(id: string, vis: StationVisual): void {
    this.sm.scene.remove(vis.marker);
    vis.label.remove();
    this.visuals.delete(id);
  }

  update(world: WorldState, t: number): void {
    // Drop visuals for stations that no longer exist.
    for (const [id, vis] of this.visuals) {
      if (!world.stations.has(id)) this.dispose(id, vis);
    }

    // The interstellar view runs at its own scale and the orrery is hidden there;
    // park every marker and skip the work outside the system view.
    if (this.sm.viewMode !== "system") {
      for (const vis of this.visuals.values()) {
        vis.marker.visible = false;
        vis.label.style.display = "none";
      }
      return;
    }

    const tmp = new THREE.Vector3();
    const w = window.innerWidth;
    const h = window.innerHeight;

    for (const station of world.stations.values()) {
      const vis = this.visuals.get(station.id) ?? this.build(station.id);
      vis.marker.visible = true;
      vis.marker.scale.setScalar(this.sm.focusId === station.id ? 0.024 : 0.015);

      const ws = stationWorldState(station, t);
      this.sm.toRender(ws.r, tmp);
      vis.marker.position.copy(tmp);

      const ndc = vis.marker.position.clone().project(this.sm.camera);
      const visible = ndc.z < 1 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
      if (visible) {
        vis.label.style.display = "block";
        vis.label.textContent = station.name + (station.depot ? " ⛽" : "");
        vis.label.classList.toggle("focused", this.sm.focusId === station.id);
        const x = (ndc.x * 0.5 + 0.5) * w;
        const y = (-ndc.y * 0.5 + 0.5) * h;
        vis.label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      } else {
        vis.label.style.display = "none";
      }
    }
  }
}
