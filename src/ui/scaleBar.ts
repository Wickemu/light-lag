/**
 * A cartographic scale bar overlaid on the WebGL canvas.
 *
 * The bar always shows a nice round distance that fits within a fixed pixel
 * budget, and auto-selects the most appropriate unit for the current zoom
 * level (from metres up through parsecs). Clicking the label cycles through
 * all available units manually.
 */

import type { SceneManager } from "../render/SceneManager.ts";
import { SCENE_SCALE } from "../render/scale.ts";
import { AU, C } from "../core/constants.ts";

interface Unit {
  key: string;
  label: string;
  fullName: string;
  metres: number;
}

const UNITS: Unit[] = [
  { key: "m",  label: "m",   fullName: "metres",             metres: 1 },
  { key: "km", label: "km",  fullName: "kilometres",         metres: 1e3 },
  { key: "mi", label: "mi",  fullName: "miles",              metres: 1_609.344 },
  { key: "ls", label: "ls",  fullName: "light-seconds",      metres: C },
  { key: "lm", label: "lm",  fullName: "light-minutes",      metres: C * 60 },
  { key: "AU", label: "AU",  fullName: "astronomical units", metres: AU },
  { key: "lh", label: "lh",  fullName: "light-hours",        metres: C * 3_600 },
  { key: "ld", label: "ld",  fullName: "light-days",         metres: C * 86_400 },
  { key: "ly", label: "ly",  fullName: "light-years",        metres: 9.460_730_472_580_8e15 },
  { key: "pc", label: "pc",  fullName: "parsecs",            metres: 3.085_677_581_491e16 },
];

// Auto-selection candidates in descending size order.
// Skips mi/lm/lh/ld — those are available manually but noisy for auto.
const AUTO_UNITS: Unit[] = ["pc", "ly", "AU", "ls", "km", "m"]
  .map(k => UNITS.find(u => u.key === k)!);

// Full cycle: "auto" first, then each manual unit in size order.
const CYCLE: string[] = ["auto", ...UNITS.map(u => u.key)];

/** Max pixel width the bar is allowed to occupy. */
const MAX_BAR_PX = 180;

export class ScaleBar {
  private readonly el: HTMLElement;
  private readonly ruleEl: HTMLElement;
  private readonly labelBtn: HTMLButtonElement;
  private cycleIdx = 0;

  constructor(private root: HTMLElement, private sm: SceneManager) {
    this.el = document.createElement("div");
    this.el.className = "scale-bar";

    const track = document.createElement("div");
    track.className = "scale-track";
    this.ruleEl = document.createElement("div");
    this.ruleEl.className = "scale-rule";
    track.appendChild(this.ruleEl);
    this.el.appendChild(track);

    this.labelBtn = document.createElement("button");
    this.labelBtn.className = "scale-label-btn";
    this.labelBtn.onclick = () => {
      this.cycleIdx = (this.cycleIdx + 1) % CYCLE.length;
    };
    this.el.appendChild(this.labelBtn);

    root.appendChild(this.el);
  }

  update(): void {
    const { camera, controls, renderer } = this.sm;
    const canvas = renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;

    const distRU = camera.position.distanceTo(controls.target);
    if (distRU <= 0) return;

    // Width of the viewport at the focus plane, in metres.
    const fovRad = (camera.fov * Math.PI) / 180;
    const halfWidthRU = distRU * Math.tan(fovRad / 2) * (w / h);
    const metresPerPx = (2 * halfWidthRU * SCENE_SCALE) / w;
    const maxBarM = MAX_BAR_PX * metresPerPx;

    const unit = this.resolveUnit(maxBarM);
    const nice = niceFloor(maxBarM / unit.metres);
    if (nice <= 0) return;

    const barPx = (nice * unit.metres) / metresPerPx;
    this.ruleEl.style.width = `${barPx.toFixed(1)}px`;

    const isAuto = CYCLE[this.cycleIdx] === "auto";
    this.labelBtn.textContent = `${fmtVal(nice)} ${unit.label}`;
    this.labelBtn.title = isAuto
      ? `Auto-selected: ${unit.fullName} · click to fix unit`
      : `${unit.fullName} · click to change`;
  }

  private resolveUnit(maxBarM: number): Unit {
    const key = CYCLE[this.cycleIdx];
    if (key === "auto") {
      return AUTO_UNITS.find(u => maxBarM >= u.metres) ?? UNITS[0]!;
    }
    return UNITS.find(u => u.key === key) ?? UNITS[0]!;
  }
}

/** Round x down to the nearest {1, 2, 5} × 10^n. */
function niceFloor(x: number): number {
  if (!isFinite(x) || x <= 0) return 0;
  const exp = Math.floor(Math.log10(x));
  const f = Math.pow(10, exp);
  const m = x / f;
  return (m < 2 ? 1 : m < 5 ? 2 : 5) * f;
}

function fmtVal(v: number): string {
  if (!isFinite(v) || v <= 0) return "—";
  // niceFloor always gives {1,2,5}×10^n so values ≥ 1 are integers.
  if (v >= 1e9) return `${(v / 1e9).toFixed(0)}G`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  if (v >= 1) return v.toFixed(0);
  // Sub-1 values: 0.5, 0.2, 0.1, etc.
  return v.toFixed(Math.max(1, -Math.floor(Math.log10(v))));
}
