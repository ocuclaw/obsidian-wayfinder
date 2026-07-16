import { renderTicketCard, type TicketCardOptions } from "./cards";
import type { MapTree, Ticket } from "./model";

/** Compact mode: full-width rows grouped by actionability. */
export function renderList(
  section: HTMLElement,
  map: MapTree,
  cardOptions: Omit<TicketCardOptions, "asRow">,
): void {
  const groups: { label: string; tickets: Ticket[] }[] = [
    { label: "Takeable", tickets: map.tickets.filter((ticket) => ticket.frontier) },
    {
      label: "Claimed",
      tickets: map.tickets.filter(
        (ticket) =>
          ticket.issue.state === "open" &&
          !ticket.frontier &&
          !ticket.unverified &&
          ticket.openBlockers.length === 0,
      ),
    },
    {
      label: "Blocked",
      tickets: map.tickets.filter(
        (ticket) =>
          ticket.issue.state === "open" &&
          (ticket.openBlockers.length > 0 || ticket.unverified),
      ),
    },
    { label: "Resolved", tickets: map.tickets.filter((ticket) => ticket.issue.state === "closed") },
  ];
  const list = section.createDiv({ cls: "wf-list" });
  for (const group of groups) {
    if (group.tickets.length === 0) continue;
    const heading = list.createDiv({ cls: "wf-group-h" });
    heading.createSpan({ text: group.label });
    heading.createSpan({ cls: "wf-group-count", text: String(group.tickets.length) });
    for (const ticket of group.tickets) {
      renderTicketCard(list, ticket, map, { ...cardOptions, asRow: true });
    }
  }
}
