import { issueKey, type Model, type Ticket } from "./model";

export type ViewMode = "tree" | "list" | "hybrid";

export interface ViewFilters {
  selectedMapKey: string | null;
  showCompletedMaps: boolean;
  incompleteTicketsOnly: boolean;
}

export interface ViewProjection {
  model: Model;
  selectedMapKey: string | null;
}

export interface ActionabilityGroup {
  label: "Takeable" | "Claimed" | "Blocked" | "Resolved";
  tickets: Ticket[];
}

export function parseViewMode(value: string | null): ViewMode | null {
  return value === "tree" || value === "list" || value === "hybrid" ? value : null;
}

export function projectView(model: Model, filters: ViewFilters): ViewProjection {
  const eligibleMaps = filters.showCompletedMaps
    ? model.maps
    : model.maps.filter((map) => map.issue.state === "open");
  const focusedMap = filters.selectedMapKey
    ? eligibleMaps.find(
        (map) => issueKey(map.repo, map.issue.number) === filters.selectedMapKey,
      )
    : undefined;
  const selectedMapKey = focusedMap
    ? issueKey(focusedMap.repo, focusedMap.issue.number)
    : null;
  const visibleMaps = focusedMap ? [focusedMap] : eligibleMaps;
  const maps = filters.incompleteTicketsOnly
    ? visibleMaps.map((map) => ({
        ...map,
        tickets: map.tickets.filter((ticket) => ticket.issue.state === "open"),
        layers: map.layers
          .map((layer) => layer.filter((ticket) => ticket.issue.state === "open"))
          .filter((layer) => layer.length > 0),
      }))
    : [...visibleMaps];
  const orphans = selectedMapKey
    ? []
    : filters.incompleteTicketsOnly
      ? model.orphans.filter((ticket) => ticket.issue.state === "open")
      : [...model.orphans];

  return {
    selectedMapKey,
    model: { ...model, maps, orphans },
  };
}

export function groupTicketsByActionability(tickets: Ticket[]): ActionabilityGroup[] {
  return [
    { label: "Takeable", tickets: tickets.filter((ticket) => ticket.frontier) },
    {
      label: "Claimed",
      tickets: tickets.filter(
        (ticket) =>
          ticket.issue.state === "open" &&
          !ticket.frontier &&
          !ticket.unverified &&
          ticket.openBlockers.length === 0,
      ),
    },
    {
      label: "Blocked",
      tickets: tickets.filter(
        (ticket) =>
          ticket.issue.state === "open" &&
          (ticket.openBlockers.length > 0 || ticket.unverified),
      ),
    },
    { label: "Resolved", tickets: tickets.filter((ticket) => ticket.issue.state === "closed") },
  ];
}
