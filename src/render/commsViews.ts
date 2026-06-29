/**
 * Renders signals in flight: a bright packet crawling from sender to receiver at
 * exactly c, with a faint beam trailing back to its origin. Commands (outbound,
 * cyan) and telemetry/acks (inbound, amber) are visually distinct. This is what
 * makes light-lag legible — you watch your order take real time to cross the gap.
 */

import * as THREE from "three";
import { type WorldState } from "@lightlag/engine/world";
import { type SceneManager } from "./SceneManager.ts";
import { type Visibility } from "./visibility.ts";

const CMD_COLOR = 0x6fe0ff;
const TLM_COLOR = 0xffb454;

function makeDotTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.85)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface PacketVisual {
  dot: THREE.Sprite;
  beam: THREE.Line;
  beamArray: Float32Array;
}

export class CommsViews {
  private dot = makeDotTexture();
  private visuals = new Map<string, PacketVisual>();

  constructor(private sm: SceneManager, private vis: Visibility) {}

  private build(color: number): PacketVisual {
    const dot = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.dot, color, sizeAttenuation: false, depthWrite: false, transparent: true }),
    );
    dot.scale.setScalar(0.014);
    this.sm.scene.add(dot);

    const beamArray = new Float32Array(6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(beamArray, 3));
    const beam = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }));
    beam.frustumCulled = false;
    this.sm.scene.add(beam);

    return { dot, beam, beamArray };
  }

  private dispose(id: string, v: PacketVisual): void {
    this.sm.scene.remove(v.dot);
    this.sm.scene.remove(v.beam);
    v.beam.geometry.dispose();
    this.visuals.delete(id);
  }

  update(world: WorldState, t: number): void {
    // Comms layer hidden, or the interstellar view is active (light-cones are an
    // in-system overlay): tear down any in-flight visuals and skip.
    if (this.sm.viewMode !== "system" || !this.vis.layer("comms")) {
      for (const [id, vis] of this.visuals) this.dispose(id, vis);
      return;
    }

    const live = new Set<string>();
    const tmp = new THREE.Vector3();

    for (const m of world.messages) {
      if (t < m.tEmit || t >= m.tArrive) continue; // only while in flight
      live.add(m.id);
      const color = m.kind === "command" ? CMD_COLOR : TLM_COLOR;
      const vis = this.visuals.get(m.id) ?? this.setVisual(m.id, this.build(color));

      const frac = (t - m.tEmit) / (m.tArrive - m.tEmit);
      const px = m.fromPos.x + (m.toPos.x - m.fromPos.x) * frac;
      const py = m.fromPos.y + (m.toPos.y - m.fromPos.y) * frac;
      const pz = m.fromPos.z + (m.toPos.z - m.fromPos.z) * frac;

      this.sm.toRender({ x: px, y: py, z: pz }, tmp);
      vis.dot.position.copy(tmp);

      // Beam from the source to the packet's current position.
      const from = this.sm.toRender(m.fromPos);
      vis.beamArray[0] = from.x; vis.beamArray[1] = from.y; vis.beamArray[2] = from.z;
      vis.beamArray[3] = tmp.x; vis.beamArray[4] = tmp.y; vis.beamArray[5] = tmp.z;
      (vis.beam.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    }

    for (const [id, vis] of this.visuals) if (!live.has(id)) this.dispose(id, vis);
  }

  private setVisual(id: string, v: PacketVisual): PacketVisual {
    this.visuals.set(id, v);
    return v;
  }
}
