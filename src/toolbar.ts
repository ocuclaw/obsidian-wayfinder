import { Menu, Platform, setIcon } from "obsidian";
import type { Model } from "./model";

export type ViewMode = "tree" | "list";

export interface ToolbarControls {
  syncStatusText: string;
  selectionMode: boolean;
  mode: ViewMode;
  zoom: number;
  anyExpanded: boolean;
  repos: { repo: string; shown: boolean }[];
  toggleSelectionMode: () => void;
  toggleAllMaps: (anyExpanded: boolean) => void;
  setZoom: (zoom: number) => void;
  adjustZoom: (factor: number) => void;
  toggleMode: () => void;
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
    cls: "wf-refresh",
    attr: {
      "aria-label": controls.mode === "tree" ? "Switch to list view" : "Switch to tree view",
    },
  });
  setIcon(modeBtn, controls.mode === "tree" ? "list" : "git-fork");
  modeBtn.addEventListener("click", controls.toggleMode);
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
  menu.addItem((item) =>
    item
      .setTitle(controls.mode === "tree" ? "Switch to list view" : "Switch to tree view")
      .setIcon(controls.mode === "tree" ? "list" : "git-fork")
      .onClick(controls.toggleMode),
  );
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
