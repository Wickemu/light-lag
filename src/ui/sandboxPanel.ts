/**
 * The Sandbox panel — the orbital playground's control surface, opened from a
 * dock tab. Three groups: the light-lag policy toggle (informative ⇄ binding),
 * the live-satellite catalog (load the offline seed or a live Celestrak group),
 * and the replay transport (start/scrub/play a deterministic timeline). Strictly
 * additive: it is a self-contained floating panel + tab, and changes nothing in
 * the existing HUD or panels. The ship designer and transfer planner remain the
 * "test flight plans & ship designs" surface.
 */
import { div, el, btn, setDisabled } from "./dom.ts";
import { collapsible } from "./collapsible.ts";
import { formatDate } from "@lightlag/engine/time";
import { type Sandbox } from "../sandbox/sandbox.ts";

/** "1 satellite" / "N satellites". */
function satCountText(n: number): string {
  return `${n} satellite${n === 1 ? "" : "s"}`;
}

export class SandboxPanel {
  private panel: HTMLElement;
  private tab: HTMLButtonElement;
  private open = false;

  private policyBtn!: HTMLButtonElement;
  private satCount!: HTMLElement;
  private liveBtn!: HTMLButtonElement;
  private startBtn!: HTMLButtonElement;
  private transport!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private scrub!: HTMLInputElement;
  private timeLabel!: HTMLElement;

  constructor(root: HTMLElement, private sandbox: Sandbox, private redraw: () => void) {
    this.panel = div("panel sandbox-panel");
    this.panel.style.display = "none";
    this.build();
    root.appendChild(this.panel);

    // The opener lives in the header bar's control cluster (alongside Layers /
    // theme / help), not as a floating bottom tab that would collide with the
    // edge-anchored Focus dock.
    this.tab = el("button", "sandbox-tab", "◧ Sandbox") as HTMLButtonElement;
    this.tab.title = "Orbital playground: satellites, replay, light-lag mode";
    this.tab.onclick = () => this.toggle();
    (root.querySelector(".topbar-controls") ?? root).appendChild(this.tab);

    this.refresh();
  }

  private build(): void {
    const head = el("div", "panel-head");
    head.appendChild(el("div", "panel-title", "SANDBOX"));
    const close = btn("✕", () => this.setOpen(false));
    close.className = "panel-close";
    close.title = "Close";
    head.appendChild(close);
    this.panel.appendChild(head);

    // ── Light-lag policy ──────────────────────────────────────────────────────
    const policy = collapsible("Light-lag", { id: "sandbox.policy" });
    policy.body.appendChild(
      el("div", "note-line", "Informative: commands apply now, the signal delay is shown. Binding: orders travel at c and resolve on arrival."),
    );
    this.policyBtn = btn("", () => {
      this.sandbox.setPolicy(this.sandbox.policy === "informative" ? "binding" : "informative");
      this.refresh();
    });
    this.policyBtn.className = "sandbox-wide-btn";
    policy.body.appendChild(this.policyBtn);
    this.panel.appendChild(policy.root);

    // ── Satellites ────────────────────────────────────────────────────────────
    const sats = collapsible("Live satellites", { id: "sandbox.sats" });
    this.satCount = el("div", "note-line", "");
    sats.body.appendChild(this.satCount);
    const satBtns = div("sandbox-btn-row");
    satBtns.appendChild(btn("Load examples", () => {
      this.sandbox.loadSeedSatellites();
      this.redraw();
      this.refresh();
    }));
    this.liveBtn = btn("Load live (stations)", () => void this.loadLive());
    satBtns.appendChild(this.liveBtn);
    satBtns.appendChild(btn("Clear", () => {
      this.sandbox.clearSatellites();
      this.redraw();
      this.refresh();
    }));
    sats.body.appendChild(satBtns);
    sats.body.appendChild(el("div", "note-line", `Positions are exact near each TLE epoch, then propagated analytically — expect drift over days. ${this.sandbox.attribution}`));
    this.panel.appendChild(sats.root);

    // ── Replay ────────────────────────────────────────────────────────────────
    const replay = collapsible("Replay", { id: "sandbox.replay" });
    this.startBtn = btn("Start replay here", () => {
      this.sandbox.replay.begin();
      this.refresh();
    });
    this.startBtn.className = "sandbox-wide-btn";
    replay.body.appendChild(this.startBtn);

    this.transport = div("sandbox-transport");
    const row = div("sandbox-btn-row");
    this.playBtn = btn("▶ Play", () => { this.sandbox.replay.togglePlay(); this.refresh(); });
    row.appendChild(this.playBtn);
    row.appendChild(btn("Exit", () => { this.sandbox.replay.exit(); this.refresh(); }));
    this.transport.appendChild(row);

    this.scrub = document.createElement("input");
    this.scrub.type = "range";
    this.scrub.className = "sandbox-scrub";
    this.scrub.oninput = () => {
      this.sandbox.replay.setPlaying(false);
      this.sandbox.replay.scrubTo(parseFloat(this.scrub.value));
      this.refresh();
    };
    this.transport.appendChild(this.scrub);
    this.timeLabel = el("div", "note-line", "");
    this.transport.appendChild(this.timeLabel);
    replay.body.appendChild(this.transport);
    this.panel.appendChild(replay.root);
  }

  private async loadLive(): Promise<void> {
    setDisabled(this.liveBtn, true, "Fetching…");
    this.liveBtn.textContent = "Loading…";
    try {
      const n = await this.sandbox.loadLiveSatellites("stations");
      this.redraw();
      this.satCount.textContent = `${satCountText(this.sandbox.satelliteIds.length)} loaded (+${n} live).`;
    } catch (e) {
      this.satCount.textContent = `Live fetch failed (${e instanceof Error ? e.message : "network"}). The offline seed still works.`;
    } finally {
      setDisabled(this.liveBtn, false);
      this.liveBtn.textContent = "Load live (stations)";
    }
  }

  /** Sync the controls to current state — cheap; called each frame while open. */
  refresh(): void {
    if (!this.open) return;
    this.policyBtn.textContent = this.sandbox.policy === "informative"
      ? "Light-lag: INFORMATIVE → switch to binding"
      : "Light-lag: BINDING → switch to informative";
    this.satCount.textContent = `${satCountText(this.sandbox.satelliteIds.length)} loaded.`;

    const r = this.sandbox.replay;
    this.startBtn.style.display = r.active ? "none" : "block";
    this.transport.style.display = r.active ? "block" : "none";
    if (r.active) {
      this.playBtn.textContent = r.playing ? "⏸ Pause" : "▶ Play";
      this.scrub.min = String(r.startTime);
      this.scrub.max = String(Math.max(r.maxTime, r.startTime + 1));
      this.scrub.step = "any";
      this.scrub.value = String(r.currentTime);
      setDisabled(
        // a range input isn't a button, but setDisabled only sets .disabled/.title
        this.scrub as unknown as HTMLButtonElement,
        r.maxTime <= r.startTime,
        "Play forward to build a timeline to scrub.",
      );
      this.timeLabel.textContent = formatDate(r.currentTime);
    }
  }

  /** Called each frame from the app loop (keeps the scrubber tracking play). */
  update(): void {
    if (this.open && this.sandbox.replay.active) this.refresh();
  }

  toggle(): void { this.setOpen(!this.open); }
  isOpen(): boolean { return this.open; }
  setOpen(open: boolean): void {
    this.open = open;
    this.panel.style.display = open ? "flex" : "none";
    this.tab.classList.toggle("active", open);
    if (open) this.refresh();
  }
}
