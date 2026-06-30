/**
 * Entry point: wires the deterministic core to the read-only renderer and the
 * HUD, then runs the frame loop.
 *
 * The contract the whole architecture rests on is visible right here: each
 * frame we advance the SIM by real elapsed time × warp, and then the renderer
 * and HUD merely READ the resulting world. State flows one way.
 */

import "../styles.css";
// Self-hosted type: Saira (UI/labels/headers) + IBM Plex Mono (live numerics).
// Bundled by Vite — no external network request.
import "@fontsource/saira/400.css";
import "@fontsource/saira/500.css";
import "@fontsource/saira/600.css";
import "@fontsource/saira/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import { createWorld } from "@lightlag/engine/world";
import { Simulation } from "@lightlag/engine/sim";
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
import { Shipyard } from "../ui/shipyard.ts";
import { MissionHud } from "../ui/missionHud.ts";
import { BottomTelemetry } from "../ui/bottomTelemetry.ts";
import { EventFeed } from "../ui/events.ts";
import { TransferPanel } from "../ui/transferPanel.ts";
import { InterstellarPanel } from "../ui/interstellarPanel.ts";
import { KeyboardManager } from "../ui/keyboard.ts";
import { Sandbox } from "../sandbox/sandbox.ts";
import { SandboxPanel } from "../ui/sandboxPanel.ts";
import { installTermTooltips } from "../ui/tooltip.ts";
import { getFlag, setFlag } from "../ui/uiState.ts";
import { initAccent } from "../ui/themes.ts";
import * as commands from "./commands.ts";

const canvas = document.getElementById("scene") as HTMLCanvasElement;
const uiRoot = document.getElementById("ui-root")!;

const world = createWorld();
const sim = new Simulation(world);

const sm = new SceneManager(canvas);
// Match the renderer to the theme the head script restored from localStorage,
// so the scene background agrees with the HUD on the very first frame.
sm.setTheme(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
// Sync the 3D overlay accent to the restored colour palette (data-accent), so the
// canvas agrees with the HUD on the first frame.
initAccent();
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
// The Shipyard (build) and ShipPanel (fly) reference each other: the yard hands a
// launched ship to the console; the console opens the yard. Forward-declare the
// console so the yard's launch callback can reach it.
let shipPanel: ShipPanel;
const shipyard = new Shipyard(uiRoot, sim, (shipId) => {
  shipPanel.selectShip(shipId);
  if (!shipPanel.isOpen()) shipPanel.toggle();
});
shipPanel = new ShipPanel(
  uiRoot, sim, sm,
  (shipId) => transferPanel.open(shipId),
  (shipId) => interstellarPanel.open(shipId),
  () => shipyard.open(),
);
// Mission events drive the closed-panel HUD's alerts and the console's event log.
const eventFeed = new EventFeed();
shipPanel.attachEventFeed(eventFeed);
const missionHud = new MissionHud(uiRoot, sim, shipPanel, eventFeed);
// The bottom-centre telemetry rail: the selected ship's range + one-way light-lag,
// always on above the scale bar (the game's defining fact, kept on screen).
const bottomTelemetry = new BottomTelemetry(uiRoot, sim, shipPanel);
const km = new KeyboardManager(sim, sm, hud, shipPanel, transferPanel, interstellarPanel, shipyard);

// The sandbox layer (orbital playground): light-lag policy, live satellites, and
// the replay transport. Additive — a self-contained panel + dock tab.
const sandbox = new Sandbox(sim, renderOnce);
const sandboxPanel = new SandboxPanel(uiRoot, sandbox, renderOnce);

// Hover/focus glossary: one delegated listener over the whole overlay surfaces a
// definition card for any term-tagged label (kv readouts, fields, headers, …).
installTermTooltips(uiRoot);

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
  eventFeed.update(world, world.t);
  missionHud.update(world.t);
  bottomTelemetry.update(world.t);
  sandboxPanel.update();
}

function frame(now: number): void {
  const dtReal = (now - lastReal) / 1000;
  lastReal = now;
  fps = fps * 0.9 + (1 / Math.max(dtReal, 1e-4)) * 0.1;

  // 1) advance the sim — or, in a replay session, let the transport drive time.
  if (sandbox.replay.active) sandbox.replay.tick(dtReal);
  else sim.advanceReal(dtReal);
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
    shipyard,
    missionHud,
    eventFeed,
    transferPanel,
    interstellarPanel,
    km,
    sandbox,
    sandboxPanel,
    commands,
    renderOnce,
    /** Advance sim by `s` seconds and redraw — lets tools drive frames without rAF. */
    step(s: number): void {
      sim.step(s);
      renderOnce();
    },
  };
}
