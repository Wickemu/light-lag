/**
 * Dock / transfer — a centred modal for propellant transfer and in-orbit assembly
 * between two docked craft.
 *
 * Shown for the selected ship when another free-coasting ship is at rendezvous in the
 * same SOI. Donor → receiver raises the receiver's m₀ — and so its Δv — by exactly
 * what the donor gives; Assemble stacks the partner's stages and payload into this
 * ship (in-orbit construction) and consumes it. The live readout (distance, relative
 * speed, both tanks) refreshes every frame via {@link DockPanel.update}; the modal
 * auto-closes when the rendezvous ends or the ship is gone.
 */

import { type Simulation } from "../core/sim.ts";
import { type SceneManager } from "../render/SceneManager.ts";
import {
  dockCandidates,
  transferPropellant,
  assembleShips,
  shipPropStatus,
} from "../app/commands.ts";
import { el, button, kv, setDisabled } from "./dom.ts";

export class DockPanel {
  private panelEl!: HTMLElement;
  private titleEl!: HTMLElement;
  private readoutEl!: HTMLElement;
  private selectEl!: HTMLSelectElement;
  private amountInput!: HTMLInputElement;
  private sendBtn!: HTMLButtonElement;
  private receiveBtn!: HTMLButtonElement;
  private assembleBtn!: HTMLButtonElement;

  private shipId: string | null = null;
  /** The currently-chosen dock partner, kept across per-frame refreshes. */
  private partnerId: string | null = null;
  /** Signature of the last candidate set, so the <select> is rebuilt only on change. */
  private lastSig = "";

  constructor(
    private root: HTMLElement,
    private sim: Simulation,
    private sm: SceneManager,
    /** Notified after an assembly so the console can re-frame and refresh its list. */
    private onAssembled?: (shipId: string, wasFocused: boolean) => void,
  ) {
    this.build();
  }

  open(shipId: string): void {
    this.shipId = shipId;
    this.partnerId = null;
    this.lastSig = "";
    this.panelEl.style.display = "flex";
    this.refresh();
  }
  close(): void {
    this.panelEl.style.display = "none";
    this.shipId = null;
    this.partnerId = null;
    this.lastSig = "";
  }
  isOpen(): boolean {
    return this.panelEl.style.display !== "none";
  }

  /** Per-frame refresh while open; auto-closes when the rendezvous ends. */
  update(): void {
    if (this.isOpen()) this.refresh();
  }

  private build(): void {
    const panel = el("div", "panel dock-panel");
    this.panelEl = panel;
    panel.style.display = "none";

    const head = el("div", "panel-head");
    this.titleEl = el("div", "panel-title", "DOCK / TRANSFER");
    head.appendChild(this.titleEl);
    const close = button("✕", () => this.close());
    close.className = "panel-close";
    close.title = "Close (Esc)";
    head.appendChild(close);
    panel.appendChild(head);

    this.readoutEl = el("div", "surface-readout");
    panel.appendChild(this.readoutEl);

    this.selectEl = document.createElement("select");
    this.selectEl.className = "preset-sel";
    this.selectEl.onchange = () => { this.partnerId = this.selectEl.value || null; };
    panel.appendChild(this.selectEl);

    const row = el("div", "dv-row");
    this.amountInput = document.createElement("input");
    this.amountInput.type = "number";
    this.amountInput.placeholder = "max";
    this.amountInput.min = "0";
    this.amountInput.className = "dv-input";
    this.receiveBtn = button("⛽ Receive", () => this.doTransfer("receive"));
    this.sendBtn = button("⛽ Send", () => this.doTransfer("send"));
    row.append(el("span", "dv-label", "prop (t)"), this.amountInput, this.receiveBtn, this.sendBtn);
    panel.appendChild(row);

    this.assembleBtn = button("⊕ Assemble (merge)", () => this.doAssemble());
    this.assembleBtn.className = "wide-btn";
    this.assembleBtn.title = "Dock-merge the selected partner into this ship — its stages and payload join this vehicle and it is consumed. In-orbit construction; cannot be undone.";
    panel.appendChild(this.assembleBtn);

    this.root.appendChild(panel);
  }

  private refresh(): void {
    if (!this.shipId) { this.close(); return; }
    const ship = this.sim.world.ships.get(this.shipId);
    if (!ship) { this.close(); return; }
    const candidates = dockCandidates(this.sim, ship.id);
    // The rendezvous ended (drifted apart, departed, deleted) — nothing to dock with.
    if (candidates.length === 0) { this.close(); return; }

    // Rebuild the partner <select> only when the candidate set actually changes, so a
    // per-frame refresh doesn't fight the user's selection.
    const sig = candidates.map((c) => c.id).join(",");
    if (sig !== this.lastSig) {
      this.lastSig = sig;
      this.selectEl.innerHTML = "";
      for (const c of candidates) {
        const opt = document.createElement("option");
        opt.value = c.id;
        opt.textContent = c.name;
        this.selectEl.appendChild(opt);
      }
    }
    if (!this.partnerId || !candidates.some((c) => c.id === this.partnerId)) {
      this.partnerId = candidates[0]!.id;
    }
    this.selectEl.value = this.partnerId;

    const partner = candidates.find((c) => c.id === this.partnerId)!;
    const me = shipPropStatus(this.sim, ship.id)!;
    const them = shipPropStatus(this.sim, partner.id)!;
    this.titleEl.textContent = `DOCK · ${ship.name}`;
    this.readoutEl.innerHTML =
      kv("Docked with", `${partner.name} · ${partner.distance.toFixed(0)} m, ${partner.relSpeed.toFixed(2)} m/s`) +
      kv("This ship", `prop ${(me.available / 1000).toFixed(1)} t · room ${(me.headroom / 1000).toFixed(1)} t`) +
      kv(partner.name, `prop ${(them.available / 1000).toFixed(1)} t · room ${(them.headroom / 1000).toFixed(1)} t`);

    // Receive needs propellant on the partner and room on this ship; Send is the reverse.
    setDisabled(this.receiveBtn, !(them.available > 1 && me.headroom > 1),
      "Partner has no propellant to give, or this ship's tanks are full.");
    setDisabled(this.sendBtn, !(me.available > 1 && them.headroom > 1),
      "This ship has no propellant to give, or the partner's tanks are full.");
  }

  /** Transfer propellant between the selected ship and its dock partner. The amount
   *  field is tonnes; blank ⇒ fill the receiver as much as the pair allows. */
  private doTransfer(dir: "send" | "receive"): void {
    if (!this.shipId || !this.partnerId) return;
    const raw = this.amountInput.value.trim();
    const amountKg = raw === "" ? undefined : Math.max(0, Number(raw) * 1000) || undefined;
    const [from, to] = dir === "send"
      ? [this.shipId, this.partnerId]
      : [this.partnerId, this.shipId];
    transferPropellant(this.sim, from, to, amountKg);
    this.refresh();
  }

  /** Assemble (dock-merge) the dock partner into the selected ship — the partner is
   *  consumed. In-orbit construction; the merged vehicle keeps this ship's identity. */
  private doAssemble(): void {
    if (!this.shipId || !this.partnerId) return;
    const shipId = this.shipId;
    const partnerId = this.partnerId;
    const wasFocused = this.sm.focusId === partnerId;
    if (assembleShips(this.sim, shipId, partnerId)) {
      this.partnerId = null;
      this.lastSig = "";
      this.onAssembled?.(shipId, wasFocused);
      this.refresh(); // candidates likely empty now → auto-closes
    }
  }
}
