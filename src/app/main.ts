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
import { BodyViews } from "../render/bodyViews.ts";
import { Hud } from "../ui/hud.ts";

const canvas = document.getElementById("scene") as HTMLCanvasElement;

const world = createWorld();
const sim = new Simulation(world);

const sm = new SceneManager(canvas);
const views = new BodyViews(sm);
const hud = new Hud(document.getElementById("ui-root")!, sim, sm);

// Open on a gentle warp so the planets are visibly in motion immediately.
sim.setWarpIndex(6); // 1 day/s

window.addEventListener("resize", () => sm.resize());

let lastReal = performance.now();
let fps = 60;

/** Draw one frame from the current world state (one-way read). */
function renderOnce(): void {
  sm.updateOrigin(world.t);
  views.update(world.t);
  sm.render();
  hud.update(fps, views);
}

function frame(now: number): void {
  const dtReal = (now - lastReal) / 1000;
  lastReal = now;
  fps = fps * 0.9 + (1 / Math.max(dtReal, 1e-4)) * 0.1;

  sim.advanceReal(dtReal); // 1) advance the sim
  renderOnce(); // 2) render + HUD read the world

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Dev-only hook for inspection/automated verification (stripped from prod build).
if (import.meta.env.DEV) {
  (window as unknown as { __lightlag: unknown }).__lightlag = {
    world,
    sim,
    sm,
    views,
    hud,
    renderOnce,
    /** Advance sim by `s` seconds and redraw — lets tools drive frames without rAF. */
    step(s: number): void {
      sim.step(s);
      renderOnce();
    },
  };
}
