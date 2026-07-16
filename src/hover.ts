import { Platform } from "obsidian";
import { blockerLabel, descriptionOf, type MapTree, type Ticket } from "./model";

export class HoverCards {
  private card: HTMLElement | null = null;

  clear(): void {
    this.card?.remove();
    this.card = null;
  }

  attach(el: HTMLElement, ticket: Ticket | null, map: MapTree): void {
    if (Platform.isMobile) return;
    el.addEventListener("mouseenter", () => {
      this.clear();
      const card = document.body.createDiv({ cls: "wf-hovercard" });
      this.card = card;

      const issue = ticket ? ticket.issue : map.issue;
      const row = card.createDiv({ cls: "wf-row1" });
      row.createSpan({ cls: "wf-num", text: `#${issue.number}` });
      if (ticket) {
        row.createSpan({ cls: `wf-type wf-hc-${ticket.type}`, text: ticket.type });
        row.createSpan({
          cls: `wf-mode wf-mode-${ticket.mode.toLowerCase()}`,
          text: ticket.mode,
        });
      } else {
        row.createSpan({ cls: "wf-type wf-hc-map", text: "map" });
      }
      card.createDiv({ cls: "wf-hc-title", text: issue.title });

      const description = descriptionOf(issue.body);
      if (description) {
        card.createDiv({
          cls: "wf-hc-desc",
          text: description.length > 420 ? `${description.slice(0, 420)}…` : description,
        });
      }

      if (ticket && ticket.blockers.length > 0) {
        const kv = card.createDiv({ cls: "wf-hc-kv" });
        kv.createSpan({ text: "Blocked by: " });
        const openSet = new Set(ticket.openBlockers);
        kv.createSpan({
          text: ticket.blockers
            .map((blocker) =>
              openSet.has(blocker) ? blockerLabel(blocker) : `${blockerLabel(blocker)} ✓`,
            )
            .join("  "),
        });
      }
      const details = card.createDiv({ cls: "wf-hc-kv" });
      details.createSpan({
        text: `Assignee: ${issue.assignees.join(", ") || "—"} · Updated ${relativeTime(
          Date.parse(issue.updated_at),
        )}`,
      });
      card.createDiv({
        cls: "wf-hc-cta",
        text: ticket
          ? "Click for details + comments · ⧉ copies /wayfinder · ↗ opens GitHub"
          : "Click to expand/collapse · ⓘ details + comments · ⧉ copies /wayfinder",
      });

      const rect = el.getBoundingClientRect();
      card.style.left = `${Math.min(rect.left, window.innerWidth - 360)}px`;
      card.style.top =
        rect.bottom + 12 + card.offsetHeight < window.innerHeight
          ? `${rect.bottom + 8}px`
          : `${Math.max(8, rect.top - card.offsetHeight - 8)}px`;
    });
    el.addEventListener("mouseleave", () => this.clear());
  }
}

export function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
