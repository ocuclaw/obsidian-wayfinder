import { setIcon, type App } from "obsidian";
import type WayfinderPlugin from "./main";
import { TicketModal } from "./modal";
import type { MapTree, RawIssue, Ticket } from "./model";

export interface TicketCardOptions {
  app: App;
  plugin: WayfinderPlugin;
  asRow?: boolean;
  selectionMode: boolean;
  selected(ticket: Ticket): boolean;
  changed(issue: RawIssue): boolean;
  makeInteractive(el: HTMLElement, activate: () => void): void;
  attachHover(el: HTMLElement, ticket: Ticket, map: MapTree): void;
  select(ticket: Ticket): void;
}

/** Shared ticket card used by both tree layers and list groups. */
export function renderTicketCard(
  root: HTMLElement,
  ticket: Ticket,
  map: MapTree,
  options: TicketCardOptions,
): void {
  const card = root.createDiv({
    cls: `wf-ticket wf-t-${ticket.type}${options.asRow ? " wf-ticket-row" : ""}`,
  });
  card.dataset.issue = String(ticket.issue.number);
  const closed = ticket.issue.state === "closed";
  const blocked = !closed && ticket.openBlockers.length > 0;
  if (closed) card.addClass("wf-closed");
  if (blocked) card.addClass("wf-blocked");
  if (ticket.frontier) {
    card.addClass("wf-frontier");
    card.createSpan({ cls: "wf-frontier-flag", text: "FRONTIER" });
  }
  if (options.selectionMode && ticket.frontier) {
    const selected = options.selected(ticket);
    card.setAttr("aria-pressed", String(selected));
    if (selected) card.addClass("wf-selected");
  }

  const row1 = card.createDiv({ cls: "wf-row1" });
  row1.createSpan({ cls: "wf-num", text: `#${ticket.issue.number}` });
  row1.createSpan({ cls: "wf-type", text: ticket.type });
  row1.createSpan({
    cls: `wf-mode wf-mode-${ticket.mode.toLowerCase()}`,
    text: ticket.mode,
  });

  card.createDiv({ cls: "wf-ticket-title", text: ticket.issue.title });

  let metaText: string;
  if (closed) {
    metaText = "✓ resolved";
  } else if (ticket.unverified) {
    metaText = "⚠ blockers unverified";
  } else if (blocked) {
    metaText = `🔒 blocked by ${ticket.openBlockers.map((number) => `#${number}`).join(" ")}`;
  } else if (ticket.issue.assignees.length > 0) {
    const idle = claimedIdleAge(ticket.issue.updated_at);
    metaText = `● claimed by ${ticket.issue.assignees.join(", ")}${idle ? ` · idle ${idle}` : ""}`;
  } else {
    metaText = "● open · takeable now";
  }
  if (!closed && ticket.downstreamImpact > 0) {
    metaText += ` · unblocks ${ticket.downstreamImpact}`;
  }
  card.createDiv({ cls: "wf-meta", text: metaText });

  if (options.changed(ticket.issue)) card.addClass("wf-changed");
  addIconActions(card, ticket.issue, options.plugin, undefined, ticket.frontier);
  options.makeInteractive(card, () => {
    if (options.selectionMode && ticket.frontier) {
      options.select(ticket);
      return;
    }
    new TicketModal(options.app, options.plugin, ticket, map).open();
  });
  options.attachHover(card, ticket, map);
}

/**
 * Small always-available actions on a card: optional ⓘ details, ⧉ copy,
 * ↗ GitHub. Frontier ticket actions use the plugin's live claim guard.
 */
export function addIconActions(
  card: HTMLElement,
  issue: RawIssue,
  plugin: WayfinderPlugin,
  onInfo?: () => void,
  claimCheck = false,
): void {
  const actions = card.createDiv({ cls: "wf-actions" });
  if (onInfo) {
    const info = actions.createEl("button", {
      cls: "wf-iconbtn",
      attr: { "aria-label": "Show details" },
    });
    setIcon(info, "info");
    info.addEventListener("click", (event) => {
      event.stopPropagation();
      onInfo();
    });
  }

  const guarded = async (action: () => void): Promise<void> => {
    if (claimCheck) {
      await plugin.guardedAction(issue.number, action);
      return;
    }
    action();
  };

  const copy = actions.createEl("button", {
    cls: "wf-iconbtn",
    attr: { "aria-label": "Copy /wayfinder command" },
  });
  setIcon(copy, "copy");
  copy.addEventListener("click", (event) => {
    event.stopPropagation();
    void guarded(() => plugin.copyCommand(issue.html_url));
  });

  const open = actions.createEl("a", {
    cls: "wf-iconbtn",
    href: issue.html_url,
    attr: { "aria-label": "Open on GitHub" },
  });
  setIcon(open, "external-link");
  open.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!claimCheck) return;
    event.preventDefault();
    void guarded(() => window.open(issue.html_url, "_blank"));
  });
}

function claimedIdleAge(updatedAt: string): string | null {
  const elapsed = Date.now() - Date.parse(updatedAt);
  if (!Number.isFinite(elapsed) || elapsed <= 24 * 60 * 60 * 1000) return null;
  const hours = Math.round(elapsed / (60 * 60 * 1000));
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}
