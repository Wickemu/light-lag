/**
 * The interstellar map — the second of the two views.
 *
 * The in-system orrery and the interstellar neighbourhood can't share one
 * camera: a 1-AU planet and a 4-ly star differ in distance by a factor of ~1e6,
 * so any single frame that frames the planets buries the stars at sub-pixel
 * size (and vice-versa). The in-system view solves its half by painting the
 * stars on an unzoomable sky (see `StarViews`); this view solves the other half.
 *
 * Here the planets are gone (Sol collapses to a single point — at this scale the
 * whole Solar System is far smaller than a pixel) and the ~24 nearby systems are
 * placed at their REAL relative distances, just uniformly scaled down. That is
 * honest precisely because the dynamic range is small: every system is 4–12 ly
 * out, a span of ~3×, nothing like the 1e6× gap that makes the combined view
 * impossible. Stars drift under real proper motion, and any ship (or other
 * object) on an interstellar leg is drawn at its true position along the way.
 */

import * as THREE from "three";
import { STARS, STAR_BY_ID, starPosition, LIGHT_YEAR, type StarDef } from "../core/stars.ts";
import { type WorldState } from "../core/world.ts";
import { shipWorldState, shipTelemetryDoppler } from "../core/ships.ts";
import { spectralColor, makeStarTexture } from "./starViews.ts";
import { makeGlowTexture } from "./bodyTextures.ts";
import { type SceneManager } from "./SceneManager.ts";
import { type Visibility } from "./visibility.ts";
import { overlayPalette, dopplerTint } from "./overlayUtil.ts";

/** Render units per light-year. 1 ly = 40 units puts the farthest system (~12 ly)
 *  at ~480 units — a comfortable framing distance, well inside float32 and the
 *  camera frustum. */
export const UNITS_PER_LY = 40;
/** Metres per render unit at interstellar scale (the bridge, like SCENE_SCALE). */
export const INTERSTELLAR_M_PER_UNIT = LIGHT_YEAR / UNITS_PER_LY;

const COAST_COLOR = 0x6fe0ff;
const THRUST_COLOR = 0xff8a30;

interface StarVisual {
  def: StarDef;
  marker: THREE.Sprite;
  label: HTMLElement;
}

interface ShipVisual {
  marker: THREE.Sprite;
  path: THREE.Line;
  pathArray: Float32Array;
  label: HTMLElement;
}

export class InterstellarView {
  private tex = makeStarTexture();
  private root = new THREE.Group();
  private stars: StarVisual[] = [];
  private sol!: THREE.Sprite;
  private solLabel: HTMLElement;
  private ships = new Map<string, ShipVisual>();
  private tintBase = new THREE.Color(); // reused scratch — no per-frame alloc
  private tintEnd = new THREE.Color();
  private labelLayer: HTMLElement;

  constructor(private sm: SceneManager, uiRoot: HTMLElement, private vis: Visibility) {
    this.sm.scene.add(this.root);
    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "interstellar-label-layer";
    uiRoot.appendChild(this.labelLayer);

    this.buildSol();
    for (const s of STARS) this.buildStar(s);
    this.solLabel = this.makeLabel("Sol", "interstellar-label sol");
    this.root.visible = false;
  }

  /** Sol sits at the origin: a warm point with a soft corona, the one place every
   *  leg departs from and the anchor the camera orbits. */
  private buildSol(): void {
    const mat = new THREE.SpriteMaterial({
      map: this.tex, color: 0xfff2c2,
      sizeAttenuation: false, depthWrite: false, transparent: true,
    });
    this.sol = new THREE.Sprite(mat);
    this.sol.scale.setScalar(0.03);
    this.sol.frustumCulled = false;
    this.root.add(this.sol);

    // Screen-fixed like every other sprite in this view, so it reads as a steady
    // halo rather than ballooning as you dolly toward Sol (minDistance is 5).
    const corona = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(), color: 0xfff0cf,
      sizeAttenuation: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    // Child of the Sol point (scale 0.03), so the on-screen size composes to
    // ~0.03·3 — a halo a few times the point.
    corona.scale.setScalar(3);
    this.sol.add(corona);
  }

  private buildStar(def: StarDef): void {
    const mat = new THREE.SpriteMaterial({
      map: this.tex, color: spectralColor(def.spectralType),
      sizeAttenuation: false, depthWrite: false, transparent: true,
    });
    const marker = new THREE.Sprite(mat);
    marker.scale.setScalar(def.parentId ? 0.014 : 0.024);
    marker.frustumCulled = false;
    this.root.add(marker);
    const label = this.makeLabel(def.name, "interstellar-label");
    this.stars.push({ def, marker, label });
  }

  private makeLabel(text: string, className: string): HTMLElement {
    const el = document.createElement("div");
    el.className = className;
    el.textContent = text;
    this.labelLayer.appendChild(el);
    return el;
  }

  /** Heliocentric metres → interstellar render units (Sol at the origin). */
  private toUnits(m: { x: number; y: number; z: number }, out: THREE.Vector3): THREE.Vector3 {
    return out.set(m.x / INTERSTELLAR_M_PER_UNIT, m.y / INTERSTELLAR_M_PER_UNIT, m.z / INTERSTELLAR_M_PER_UNIT);
  }

  update(world: WorldState, t: number): void {
    const active = this.sm.viewMode === "interstellar";
    this.root.visible = active;
    if (!active) {
      this.hideLabels();
      return;
    }

    const w = window.innerWidth;
    const h = window.innerHeight;
    const labelsOn = this.vis.layer("starLabels");
    const tmp = new THREE.Vector3();

    this.placeLabel(this.solLabel, this.sol.position, w, h, true);

    for (const sv of this.stars) {
      this.toUnits(starPosition(sv.def, t), tmp);
      sv.marker.position.copy(tmp);
      // Components of a multiple sit nearly on top of their primary; show the
      // sprite but suppress the duplicate label.
      this.placeLabel(sv.label, sv.marker.position, w, h, labelsOn && !sv.def.parentId);
    }

    this.updateShips(world, t, w, h);
  }

  /** Draw every ship currently on an interstellar leg at its true position, with a
   *  line tracing Sol → the target system along the leg's aim. */
  private updateShips(world: WorldState, t: number, w: number, h: number): void {
    const shipsOn = this.vis.layer("ships");
    const live = new Set<string>();
    const tmp = new THREE.Vector3();

    if (shipsOn) {
      for (const ship of world.ships.values()) {
        const leg = ship.interstellarLeg;
        const star = leg ? STAR_BY_ID.get(leg.targetStar) : undefined;
        if (!leg || !star) continue;
        live.add(ship.id);
        const vis = this.ships.get(ship.id) ?? this.buildShip(ship.id);

        // A flip-and-burn is under thrust the WHOLE leg — it never coasts (the
        // trajectory is analytic, so ship.mode stays "coast" and can't tell us).
        // Mark it as thrusting throughout; ▲ while accelerating, ▼ after the flip
        // at the leg's midpoint.
        const accelerating = t < (leg.tDepart + leg.tArrive) / 2;
        // Doppler tint (opt-in): a near-c torchship reddens hard on the outbound
        // accelerating half and blue-shifts after the flip — the payoff case.
        let shipColor = THRUST_COLOR;
        if (this.vis.layer("doppler_tint")) {
          const dop = shipTelemetryDoppler(ship, world.controlNode, t);
          if (dop) shipColor = dopplerTint(THRUST_COLOR, dop.z, overlayPalette(this.sm.theme), this.tintBase, this.tintEnd);
        }
        (vis.marker.material as THREE.SpriteMaterial).color.setHex(shipColor);
        (vis.path.material as THREE.LineBasicMaterial).color.setHex(shipColor);

        // Marker at the ship's true heliocentric position, scaled.
        this.toUnits(shipWorldState(ship, t).r, tmp);
        vis.marker.position.copy(tmp);

        // Path: Sol (departure) → the star's arrival-time position (the leg's aim).
        const aim = this.toUnits(starPosition(star, leg.tArrive), new THREE.Vector3());
        vis.pathArray[0] = 0; vis.pathArray[1] = 0; vis.pathArray[2] = 0;
        vis.pathArray[3] = aim.x; vis.pathArray[4] = aim.y; vis.pathArray[5] = aim.z;
        (vis.path.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
        vis.marker.visible = true;
        vis.path.visible = true;

        this.placeLabel(vis.label, vis.marker.position, w, h, true, ship.name + (accelerating ? " ▲" : " ▼"));
      }
    }

    for (const [id, vis] of this.ships) {
      if (!live.has(id)) this.disposeShip(id, vis);
    }
  }

  private buildShip(id: string): ShipVisual {
    const marker = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.tex, color: COAST_COLOR, sizeAttenuation: false, depthWrite: false, transparent: true,
    }));
    marker.scale.setScalar(0.02);
    marker.frustumCulled = false;
    this.root.add(marker);

    const pathArray = new Float32Array(6);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pathArray, 3));
    const path = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: COAST_COLOR, transparent: true, opacity: 0.5 }));
    path.frustumCulled = false;
    this.root.add(path);

    const label = this.makeLabel("", "interstellar-label ship");
    const vis: ShipVisual = { marker, path, pathArray, label };
    this.ships.set(id, vis);
    return vis;
  }

  private disposeShip(id: string, vis: ShipVisual): void {
    this.root.remove(vis.marker);
    this.root.remove(vis.path);
    vis.path.geometry.dispose();
    // Release the per-ship materials (the shared `tex` map is owned for the
    // view's lifetime — don't dispose it).
    (vis.marker.material as THREE.Material).dispose();
    (vis.path.material as THREE.Material).dispose();
    vis.label.remove();
    this.ships.delete(id);
  }

  /** Project a render-space point and position its HTML label, or hide it. */
  private placeLabel(el: HTMLElement, pos: THREE.Vector3, w: number, h: number, show: boolean, text?: string): void {
    if (!show) { el.style.display = "none"; return; }
    const ndc = pos.clone().project(this.sm.camera);
    if (ndc.z >= 1 || Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) { el.style.display = "none"; return; }
    if (text !== undefined) el.textContent = text;
    el.style.display = "block";
    el.style.transform = `translate(${((ndc.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-ndc.y * 0.5 + 0.5) * h).toFixed(1)}px)`;
  }

  private hideLabels(): void {
    this.solLabel.style.display = "none";
    for (const sv of this.stars) sv.label.style.display = "none";
    for (const sv of this.ships.values()) sv.label.style.display = "none";
  }
}
