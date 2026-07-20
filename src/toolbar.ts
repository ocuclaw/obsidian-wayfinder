import { Menu, Platform, setIcon } from "obsidian";
import type { Model } from "./model";
import type { ViewMode } from "./view-state";

export interface MapChoice {
  key: string;
  label: string;
}

export interface ToolbarControls {
  syncStatusText: string;
  selectionMode: boolean;
  mode: ViewMode;
  zoom: number;
  anyExpanded: boolean;
  mapChoices: MapChoice[];
  selectedMapKey: string | null;
  showCompletedMaps: boolean;
  incompleteTicketsOnly: boolean;
  repos: { repo: string; shown: boolean }[];
  toggleSelectionMode: () => void;
  toggleAllMaps: (anyExpanded: boolean) => void;
  setZoom: (zoom: number) => void;
  adjustZoom: (factor: number) => void;
  setMode: (mode: ViewMode) => void;
  setSelectedMap: (key: string | null) => void;
  setShowCompletedMaps: (show: boolean) => void;
  setIncompleteTicketsOnly: (onlyIncomplete: boolean) => void;
  toggleRepo: (repo: string) => void;
  showAllRepos: () => void;
  refresh: () => void;
}

export function renderToolbar(
  root: HTMLElement,
  model: Model,
  controls: ToolbarControls,
): void {
  const bar = root.createDiv({ cls: "wf-tally" });
  renderMapPicker(bar, controls);
  if (!Platform.isMobile) {
    for (const { type, tally } of model.tallies) {
      const stat = bar.createDiv({ cls: `wf-stat wf-t-${type}` });
      stat.createSpan({ cls: "wf-swatch" });
      stat.createSpan({ cls: "wf-stat-num", text: `${tally.open}/${tally.total}` });
      stat.createSpan({ cls: "wf-stat-lbl", text: type === "map" ? "maps" : type });
      stat.setAttr("aria-label", `${type}: ${tally.open} open of ${tally.total} total`);
    }
  }

  const frontier = model.maps.flatMap((map) => map.tickets.filter((ticket) => ticket.frontier));
  const chip = (cls: string, count: number, label: string, aria: string): void => {
    const stat = bar.createDiv({ cls: `wf-stat ${cls}` });
    stat.createSpan({ cls: "wf-swatch" });
    stat.createSpan({ cls: "wf-stat-num", text: String(count) });
    stat.createSpan({ cls: "wf-stat-lbl", text: label });
    stat.setAttr("aria-label", aria);
  };
  chip(
    "wf-t-frontier",
    frontier.length,
    "takeable",
    `${frontier.length} tickets open, unblocked, and unclaimed`,
  );
  const hitl = frontier.filter((ticket) => ticket.mode === "HITL").length;
  const afk = frontier.filter((ticket) => ticket.mode === "AFK").length;
  const either = frontier.filter((ticket) => ticket.mode === "either").length;
  chip("wf-t-hitl", hitl, "need you", `${hitl} takeable tickets need a human in the loop`);
  chip("wf-t-afk", afk, "agent-ready", `${afk} takeable tickets an agent can run alone`);
  if (either > 0) {
    chip("wf-t-either", either, "either", `${either} takeable task tickets could go either way`);
  }

  const right = bar.createDiv({ cls: "wf-tally-right" });
  right.createSpan({ cls: "wf-sync-status", text: controls.syncStatusText });
  if (controls.repos.length >= 2) renderRepoFilter(right, controls);
  if (!Platform.isMobile) renderDesktopControls(right, controls);

  const refresh = right.createEl("button", {
    cls: "wf-refresh",
    attr: { "aria-label": "Refresh now" },
  });
  setIcon(refresh, "refresh-cw");
  refresh.addEventListener("click", controls.refresh);
  if (Platform.isMobile) {
    const overflow = right.createEl("button", {
      cls: "wf-refresh",
      text: "⋯",
      attr: { "aria-label": "More Wayfinder controls" },
    });
    overflow.addEventListener("click", (event: MouseEvent) =>
      showMobileMenu(event, model, controls),
    );
  }
}

function renderMapPicker(bar: HTMLElement, controls: ToolbarControls): void {
  const select = bar.createEl("select", {
    cls: "wf-map-picker",
    attr: { "aria-label": "Choose a Wayfinder map" },
  });
  select.disabled = controls.mapChoices.length === 0;
  const all = select.createEl("option", { text: "All maps", value: "" });
  all.selected = controls.selectedMapKey === null;
  for (const choice of controls.mapChoices) {
    const option = select.createEl("option", { text: choice.label, value: choice.key });
    option.selected = choice.key === controls.selectedMapKey;
  }
  select.addEventListener("change", () => controls.setSelectedMap(select.value || null));
}

function renderRepoFilter(right: HTMLElement, controls: ToolbarControls): void {
  const shown = controls.repos.filter((config) => config.shown).length;
  const filter = right.createEl("button", {
    cls: "wf-refresh wf-repo-filter",
    attr: { "aria-label": "Filter repos" },
  });
  setIcon(filter, "git-branch");
  if (shown < controls.repos.length) {
    filter.createSpan({ text: `${shown}/${controls.repos.length}` });
  }
  filter.addEventListener("click", (event: MouseEvent) => {
    const menu = new Menu();
    for (const config of controls.repos) {
      menu.addItem((item) =>
        item
          .setTitle(config.repo)
          .setChecked(config.shown)
          .onClick(() => controls.toggleRepo(config.repo)),
      );
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Show all").onClick(controls.showAllRepos));
    menu.showAtMouseEvent(event);
  });
}

function renderDesktopControls(right: HTMLElement, controls: ToolbarControls): void {
  const completedBtn = right.createEl("button", {
    cls: `wf-refresh wf-filter-toggle${controls.showCompletedMaps ? " is-active" : ""}`,
    text: "Completed maps",
    attr: {
      "aria-label": controls.showCompletedMaps ? "Hide completed maps" : "Show completed maps",
      "aria-pressed": String(controls.showCompletedMaps),
    },
  });
  completedBtn.addEventListener("click", () =>
    controls.setShowCompletedMaps(!controls.showCompletedMaps),
  );

  const incompleteBtn = right.createEl("button", {
    cls: `wf-refresh wf-filter-toggle${controls.incompleteTicketsOnly ? " is-active" : ""}`,
    text: "Incomplete tickets",
    attr: {
      "aria-label": controls.incompleteTicketsOnly
        ? "Show all tickets"
        : "Show only incomplete tickets",
      "aria-pressed": String(controls.incompleteTicketsOnly),
    },
  });
  incompleteBtn.addEventListener("click", () =>
    controls.setIncompleteTicketsOnly(!controls.incompleteTicketsOnly),
  );

  const selectBtn = right.createEl("button", {
    cls: `wf-refresh wf-select-toggle${controls.selectionMode ? " is-active" : ""}`,
    attr: {
      "aria-label": controls.selectionMode ? "Leave ticket selection mode" : "Select tickets",
      "aria-pressed": String(controls.selectionMode),
    },
  });
  setIcon(selectBtn, "list-checks");
  selectBtn.createSpan({ text: controls.selectionMode ? "Selecting" : "Select" });
  selectBtn.addEventListener("click", controls.toggleSelectionMode);

  const foldBtn = right.createEl("button", {
    cls: "wf-refresh",
    attr: { "aria-label": controls.anyExpanded ? "Collapse all maps" : "Expand all maps" },
  });
  setIcon(foldBtn, controls.anyExpanded ? "chevrons-down-up" : "chevrons-up-down");
  foldBtn.addEventListener("click", () => controls.toggleAllMaps(controls.anyExpanded));

  const zoomOut = right.createEl("button", {
    cls: "wf-refresh",
    attr: { "aria-label": "Zoom out" },
  });
  setIcon(zoomOut, "zoom-out");
  zoomOut.addEventListener("click", () => controls.adjustZoom(1 / 1.15));
  const zoomLabel = right.createEl("button", {
    cls: "wf-refresh wf-zoom-label",
    text: `${Math.round(controls.zoom * 100)}%`,
    attr: { "aria-label": "Reset zoom" },
  });
  zoomLabel.addEventListener("click", () => controls.setZoom(1));
  const zoomIn = right.createEl("button", {
    cls: "wf-refresh",
    attr: { "aria-label": "Zoom in" },
  });
  setIcon(zoomIn, "zoom-in");
  zoomIn.addEventListener("click", () => controls.adjustZoom(1.15));

  const modeBtn = right.createEl("button", {
    cls: "wf-refresh wf-mode-picker",
    attr: {
      "aria-label": "Choose view mode",
      "aria-haspopup": "menu",
    },
  });
  setIcon(modeBtn, modeIcon(controls.mode));
  modeBtn.createSpan({ text: modeLabel(controls.mode) });
  modeBtn.addEventListener("click", (event: MouseEvent) => showModeMenu(event, controls));
}

function showModeMenu(event: MouseEvent, controls: ToolbarControls): void {
  const menu = new Menu();
  for (const mode of ["tree", "list", "hybrid"] as const) {
    menu.addItem((item) =>
      item
        .setTitle(modeLabel(mode))
        .setIcon(modeIcon(mode))
        .setChecked(controls.mode === mode)
        .onClick(() => controls.setMode(mode)),
    );
  }
  menu.showAtMouseEvent(event);
}

function modeLabel(mode: ViewMode): string {
  if (mode === "tree") return "Dependency tree";
  if (mode === "list") return "Actionability list";
  return "Hybrid";
}

function modeIcon(mode: ViewMode): string {
  if (mode === "tree") return "git-fork";
  if (mode === "list") return "list";
  return "columns-2";
}

function showMobileMenu(event: MouseEvent, model: Model, controls: ToolbarControls): void {
  const menu = new Menu();
  menu.addItem((item) =>
    item
      .setTitle(controls.selectionMode ? "Done selecting tickets" : "Select tickets")
      .setIcon("list-checks")
      .onClick(controls.toggleSelectionMode),
  );
  menu.addSeparator();
  for (const mode of ["tree", "list", "hybrid"] as const) {
    menu.addItem((item) =>
      item
        .setTitle(modeLabel(mode))
        .setIcon(modeIcon(mode))
        .setChecked(controls.mode === mode)
        .onClick(() => controls.setMode(mode)),
    );
  }
  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle("Show completed maps")
      .setChecked(controls.showCompletedMaps)
      .onClick(() => controls.setShowCompletedMaps(!controls.showCompletedMaps)),
  );
  menu.addItem((item) =>
    item
      .setTitle("Show only incomplete tickets")
      .setChecked(controls.incompleteTicketsOnly)
      .onClick(() => controls.setIncompleteTicketsOnly(!controls.incompleteTicketsOnly)),
  );
  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle(controls.anyExpanded ? "Collapse all maps" : "Expand all maps")
      .setIcon(controls.anyExpanded ? "chevrons-down-up" : "chevrons-up-down")
      .onClick(() => controls.toggleAllMaps(controls.anyExpanded)),
  );
  menu.addItem((item) =>
    item
      .setTitle("Zoom in")
      .setIcon("zoom-in")
      .onClick(() => controls.adjustZoom(1.15)),
  );
  menu.addItem((item) =>
    item
      .setTitle("Zoom out")
      .setIcon("zoom-out")
      .onClick(() => controls.adjustZoom(1 / 1.15)),
  );
  menu.addItem((item) =>
    item.setTitle("Reset zoom").setIcon("rotate-ccw").onClick(() => controls.setZoom(1)),
  );
  menu.addSeparator();
  for (const { type, tally } of model.tallies) {
    menu.addItem((item) => item.setTitle(`${type} ${tally.open}/${tally.total}`).setDisabled(true));
  }
  menu.showAtMouseEvent(event);
}
