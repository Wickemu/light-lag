/**
 * Entry point: wires the deterministic core to the read-only renderer and the
 * HUD, then runs the frame loop.
 *
 * The contract the whole architecture rests on is visible right here: each
 * frame we advance the SIM by real elapsed time × warp, and then the renderer
 * and HUD merely READ the resulting world. State flows one way.
 */

import "../styles.css";
import { createWorld } from "../core/world.ts";
import { Simulation } from "../core/sim.ts";
import { SceneManager } from "../render/SceneManager.ts";
import { Visibility, LAYER_KEYS } from "../render/visibility.ts";
import { BodyViews } from "../render/bodyViews.ts";
import { ShipViews } from "../render/shipViews.ts";
import { TrajectoryViews } from "../render/trajectoryViews.ts";
import { ForceViews } from "../render/forceViews.ts";
import { StarViews } from "../render/starViews.ts";
import { InterstellarView } from "../render/interstellarView.ts";
import { CommsViews } from "../render/commsViews.ts";
import { Hud } from "../ui/hud.ts";
import { ScaleBar } from "../ui/scaleBar.ts";
import { ShipPanel } from "../ui/shipPanel.ts";
import { TransferPanel } from "../ui/transferPanel.ts";
import { InterstellarPanel } from "../ui/interstellarPanel.ts";
import { KeyboardManager } from "../ui/keyboard.ts";
import { getFlag, setFlag } from "../ui/uiState.ts";
import * as commands from "./commands.ts";

const canvas = document.getElementById("scene") as HTMLCanvasElement;
const uiRoot = document.getElementById("ui-root")!;

const world = createWorld();
const sim = new Simulation(world);

const sm = new SceneManager(canvas);
// Match the renderer to the theme the head script restored from localStorage,
// so the scene background agrees with the HUD on the very first frame.
sm.setTheme(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
// Shared show/hide state, written by the HUD's layer controls and read by every view.
const visibility = new Visibility();
// Restore persisted scene-layer toggles before any view reads them, then persist
// on every change so the user's overlay choices survive a reload.
for (const k of LAYER_KEYS) visibility.setLayer(k, getFlag(`layer.${k}`, visibility.layer(k)));
visibility.onChange(() => {
  for (const k of LAYER_KEYS) setFlag(`layer.${k}`, visibility.layer(k));
});
const views = new BodyViews(sm, visibility);
const shipViews = new ShipViews(sm, uiRoot, visibility);
const trajectoryViews = new TrajectoryViews(sm, sim, visibility);
const forceViews = new ForceViews(sm, visibility);
const starViews = new StarViews(sm, uiRoot, visibility);
const interstellarView = new InterstellarView(sm, uiRoot, visibility);
const commsViews = new CommsViews(sm, visibility);
const hud = new Hud(uiRoot, sim, sm, visibility);
const scaleBar = new ScaleBar(uiRoot, sm);
const transferPanel = new TransferPanel(uiRoot, sim, sm, trajectoryViews);
const interstellarPanel = new InterstellarPanel(uiRoot, sim, sm);
const shipPanel = new ShipPanel(
  uiRoot, sim, sm,
  (shipId) => transferPanel.open(shipId),
  (shipId) => interstellarPanel.open(shipId),
);
const km = new KeyboardManager(sim, sm, hud, shipPanel, transferPanel, interstellarPanel);

// Open on a gentle warp so the planets are visibly in motion immediately.
sim.setWarpIndex(6); // 1 day/s

window.addEventListener("resize", () => sm.resize());

let lastReal = performance.now();
let fps = 60;

/** Draw one frame from the current world state (one-way read). */
function renderOnce(): void {
  sm.updateOrigin(world.t);
  // Each view draws only in its own mode and parks in the other, so all are
  // updated every frame; the cheap early-outs keep the idle set free.
  views.update(world.t);
  starViews.update(world.t);
  shipViews.update(world, world.t);
  trajectoryViews.update(world, world.t);
  forceViews.update(world, world.t);
  commsViews.update(world, world.t);
  interstellarView.update(world, world.t);
  sm.render();
  hud.update(fps, views);
  scaleBar.update();
  shipPanel.update(world.t);
}

function frame(now: number): void {
  const dtReal = (now - lastReal) / 1000;
  lastReal = now;
  fps = fps * 0.9 + (1 / Math.max(dtReal, 1e-4)) * 0.1;

  sim.advanceReal(dtReal); // 1) advance the sim
  km.tick(dtReal);          // 2) apply keyboard camera movement before render
  renderOnce(); // 3) render + HUD read the world

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Dev-only hook for inspection/automated verification (stripped from prod build).
if (import.meta.env.DEV) {
  (window as unknown as { __lightlag: unknown }).__lightlag = {
    world,
    sim,
    sm,
    visibility,
    views,
    shipViews,
    trajectoryViews,
    forceViews,
    starViews,
    interstellarView,
    commsViews,
    hud,
    shipPanel,
    transferPanel,
    interstellarPanel,
    km,
    commands,
    renderOnce,
    /** Advance sim by `s` seconds and redraw — lets tools drive frames without rAF. */
    step(s: number): void {
      sim.step(s);
      renderOnce();
    },
  };
}
