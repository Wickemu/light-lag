/**
 * A small anchored flyout — a trigger button that opens a floating panel just
 * below itself, closing on outside-click or Escape. Used for the Layers menu,
 * which pulls a wall of scene toggles out of the body list and into a control
 * the user opens only when they want it.
 *
 * The flyout is appended to #ui-root (the overlay layer) and positioned each
 * time it opens, so it tracks the trigger across responsive reflows.
 */

import { el } from "./dom.ts";

export interface Popover {
  /** The trigger button — place this in your toolbar. */
  trigger: HTMLButtonElement;
  /** The flyout content container — append menu items here. */
  content: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
}

export function popover(
  root: HTMLElement,
  triggerLabel: string,
  opts: { title?: string; className?: string } = {},
): Popover {
  const trigger = el("button", "popover-trigger") as HTMLButtonElement;
  trigger.textContent = triggerLabel;
  if (opts.title) trigger.title = opts.title;

  const flyout = el("div", `panel popover-flyout ${opts.className ?? ""}`.trim());
  flyout.style.display = "none";
  const content = el("div", "popover-content");
  flyout.appendChild(content);
  root.appendChild(flyout);

  let open = false;

  function position(): void {
    const r = trigger.getBoundingClientRect();
    // Right-align the flyout to the trigger so it never spills off the edge a
    // top-right toolbar lives against.
    flyout.style.top = `${r.bottom + 6}px`;
    flyout.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  }

  function onDocClick(e: MouseEvent): void {
    if (!open) return;
    const t = e.target as Node;
    if (!flyout.contains(t) && !trigger.contains(t)) api.close();
  }
  function onKey(e: KeyboardEvent): void {
    if (open && e.key === "Escape") { e.stopPropagation(); api.close(); }
  }

  const api: Popover = {
    trigger,
    content,
    isOpen: () => open,
    open() {
      if (open) return;
      open = true;
      flyout.style.display = "block";
      position();
      trigger.classList.add("active");
      // Defer listener attach so the opening click doesn't immediately close it.
      setTimeout(() => {
        document.addEventListener("mousedown", onDocClick);
        window.addEventListener("keydown", onKey, true);
      }, 0);
    },
    close() {
      if (!open) return;
      open = false;
      flyout.style.display = "none";
      trigger.classList.remove("active");
      document.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("keydown", onKey, true);
    },
  };

  trigger.onclick = () => (open ? api.close() : api.open());
  window.addEventListener("resize", () => { if (open) position(); });

  return api;
}
