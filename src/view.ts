import { ItemView, Notice, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import { addIconActions, type TicketCardOptions } from "./cards";
import { HoverCards, relativeTime } from "./hover";
import { renderList } from "./list";
import type { RawIssue } from "./model";
import type WayfinderPlugin from "./main";
import { TicketModal } from "./modal";
import { buildModel, type MapTree, type Model, type Ticket } from "./model";
import { renderToolbar, type ViewMode } from "./toolbar";
import { drawAllEdges, renderTree } from "./tree";

export const VIEW_TYPE_WAYFINDER = "wayfinder-view";

const MODE_KEY = "wayfinder-view-mode";
const ZOOM_KEY = "wayfinder-zoom";
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;

export class WayfinderView extends ItemView {
  /** Per-map collapse override; default is expanded for open maps, collapsed for closed. */
  private collapsedOverride = new Map<number, boolean>();
  /** View-local delegation selection; never persisted. */
  private selectionMode = false;
  private selectedIssues = new Set<number>();

  /** Per-device (localStorage, not synced): phones default to list, desktops to tree. */
  private get mode(): ViewMode {
    const stored = window.localStorage.getItem(MODE_KEY);
    if (stored === "tree" || stored === "list") return stored;
    return Platform.isMobile ? "list" : "tree";
  }

  private set mode(m: ViewMode) {
    window.localStorage.setItem(MODE_KEY, m);
  }

  /** Per-device zoom factor for the map area (CSS zoom, so layout reflows). */
  private get zoom(): number {
    const v = parseFloat(window.localStorage.getItem(ZOOM_KEY) ?? "");
    return Number.isFinite(v) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v)) : 1;
  }

  private setZoom(z: number): void {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
    window.localStorage.setItem(ZOOM_KEY, String(clamped));
    const wrap = this.contentEl.querySelector<HTMLElement>(".wf-zoom");
    if (wrap) wrap.style.setProperty("zoom", String(clamped));
    const label = this.contentEl.querySelector<HTMLElement>(".wf-zoom-label");
    if (label) label.setText(`${Math.round(clamped * 100)}%`);
    this.scheduleEdges();
  }
  private hoverCards = new HoverCards();
  private resizeObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: WayfinderPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_WAYFINDER;
  }

  getDisplayText(): string {
    return "Wayfinder";
  }

  getIcon(): string {
    return "compass";
  }

  private pollTimer: number | null = null;
  private lastRenderKey: string | null = null;
  private edgeRaf = 0;
  /** updated_at per issue as of the previous render — drives change flashes. */
  private prevUpdated: Map<number, string> | null = null;

  async onOpen(): Promise<void> {
    this.registerEvent(this.plugin.events.on("wayfinder:updated", () => this.onDataUpdated()));
    this.registerEvent(this.plugin.events.on("wayfinder:settings", () => this.startPolling()));
    this.startPolling();
    this.registerZoomGestures();
    // Coming back from sleep/background: sync immediately if data is stale.
    this.registerDomEvent(window, "focus", () => {
      const age = Date.now() - (this.plugin.snapshot?.fetchedAt ?? 0);
      if (age > Math.max(0.5, this.plugin.settings.pollIntervalMinutes) * 60_000) {
        void this.plugin.sync(false);
      }
    });
    this.render();
    void this.plugin.sync(false);
  }

  /** Ctrl/Cmd+wheel (also trackpad pinch) on desktop; two-finger pinch on touch. */
  private registerZoomGestures(): void {
    this.registerDomEvent(
      this.contentEl,
      "wheel",
      (e: WheelEvent) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        this.setZoom(this.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
      },
      { passive: false },
    );

    const touches = new Map<number, { x: number; y: number }>();
    let pinchBase: { dist: number; zoom: number } | null = null;
    const dist = (): number => {
      const [a, b] = [...touches.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    this.registerDomEvent(this.contentEl, "pointerdown", (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      pinchBase = touches.size === 2 ? { dist: dist(), zoom: this.zoom } : null;
    });
    this.registerDomEvent(
      this.contentEl,
      "pointermove",
      (e: PointerEvent) => {
        if (e.pointerType !== "touch" || !touches.has(e.pointerId)) return;
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pinchBase && touches.size === 2) {
          e.preventDefault();
          this.setZoom((pinchBase.zoom * dist()) / pinchBase.dist);
        }
      },
      { passive: false },
    );
    const endTouch = (e: PointerEvent): void => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinchBase = null;
    };
    this.registerDomEvent(this.contentEl, "pointerup", endTouch);
    this.registerDomEvent(this.contentEl, "pointercancel", endTouch);
  }

  async onClose(): Promise<void> {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    cancelAnimationFrame(this.edgeRaf);
    this.hoverCards.clear();
    this.resizeObserver?.disconnect();
  }

  private startPolling(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.pollTimer = window.setInterval(
      () => void this.plugin.sync(false),
      Math.max(0.5, this.plugin.settings.pollIntervalMinutes) * 60_000,
    );
    this.registerInterval(this.pollTimer);
  }

  /**
   * Re-render only when the data actually changed; otherwise just refresh the
   * sync-status text. A full render every poll would reset scroll and hover.
   */
  private onDataUpdated(): void {
    const key = this.snapshotKey();
    if (key === this.lastRenderKey) {
      this.updateSyncStatus();
      return;
    }
    this.render();
  }

  private snapshotKey(): string {
    const s = this.plugin.snapshot;
    const err = this.plugin.lastError ?? "";
    if (!s) return `none|${err}|${this.plugin.syncing}`;
    const issues = s.issues
      .map((i) => `${i.number}:${i.updated_at}:${i.state}:${i.assignees.join(",")}`)
      .join("|");
    return `${err}|${issues}|${JSON.stringify(s.parents)}|${JSON.stringify(s.deps)}`;
  }

  private syncStatusText(): string {
    const s = this.plugin.snapshot;
    if (!s) return "";
    const open = s.issues.filter((i) => i.state === "open").length;
    const age = Date.now() - s.fetchedAt;
    const staleAfter = Math.max(0.5, this.plugin.settings.pollIntervalMinutes) * 3 * 60_000;
    const when = this.plugin.syncing
      ? "syncing…"
      : `synced ${relativeTime(s.fetchedAt)}${age > staleAfter ? " (stale)" : ""}`;
    return `${s.issues.length} issues · ${open} open · ${when}`;
  }

  private updateSyncStatus(): void {
    const el = this.contentEl.querySelector(".wf-sync-status");
    if (el instanceof HTMLElement) el.setText(this.syncStatusText());
  }

  private scheduleEdges(): void {
    cancelAnimationFrame(this.edgeRaf);
    this.edgeRaf = requestAnimationFrame(() =>
      drawAllEdges(this.contentEl, this.plugin.snapshot),
    );
  }

  /** Make a card keyboard-operable: tabbable, Enter/Space activates. */
  private makeInteractive(el: HTMLElement, activate: () => void): void {
    el.setAttr("tabindex", "0");
    el.setAttr("role", "button");
    el.addEventListener("click", (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest(".wf-actions")) return;
      activate();
    });
    el.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.target !== el) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
  }

  private render(): void {
    const root = this.contentEl;
    const scrollTop = root.scrollTop;
    const mapScrollLeft = new Map<number, number>();
    for (const scroller of Array.from(root.querySelectorAll<HTMLElement>(".wf-tree-scroll"))) {
      const mapNumber = Number(scroller.dataset.mapNumber);
      if (Number.isFinite(mapNumber)) mapScrollLeft.set(mapNumber, scroller.scrollLeft);
    }
    this.lastRenderKey = this.snapshotKey();
    root.empty();
    root.addClass("wayfinder-view");
    root.classList.toggle("wf-selecting", this.selectionMode);
    this.hoverCards.clear();
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      this.scheduleEdges();
      this.positionSelectBar();
    });
    this.resizeObserver.observe(root);

    const snapshot = this.plugin.snapshot;
    if (!snapshot) {
      const empty = root.createDiv({ cls: "wf-empty" });
      if (this.plugin.syncing) {
        empty.setText("Syncing…");
        return;
      }
      if (this.plugin.lastError) {
        empty.createDiv({ text: this.plugin.lastError, cls: "wf-error" });
      } else {
        empty.createDiv({ text: "No data yet. Configure Settings → Wayfinder, then sync." });
      }
      const btn = empty.createEl("button", { text: "Sync now", cls: "wf-sync-now" });
      btn.addEventListener("click", () => void this.plugin.sync(true));
      return;
    }

    const model = buildModel(snapshot);
    this.pruneSelection(model);
    const anyExpanded = model.maps.some(
      (map) =>
        !(this.collapsedOverride.get(map.issue.number) ?? map.issue.state === "closed"),
    );
    renderToolbar(root, model, {
      syncStatusText: this.syncStatusText(),
      selectionMode: this.selectionMode,
      mode: this.mode,
      zoom: this.zoom,
      anyExpanded,
      toggleSelectionMode: () => this.toggleSelectionMode(),
      toggleAllMaps: (expanded) => this.toggleAllMaps(model, expanded),
      setZoom: (zoom) => this.setZoom(zoom),
      adjustZoom: (factor) => this.setZoom(this.zoom * factor),
      toggleMode: () => this.toggleMode(),
      refresh: () => void this.plugin.sync(true),
    });
    if (this.plugin.lastError) {
      root.createDiv({ text: `Last sync failed: ${this.plugin.lastError}`, cls: "wf-error" });
    }
    const zoomWrap = root.createDiv({ cls: "wf-zoom" });
    zoomWrap.style.setProperty("zoom", String(this.zoom));
    if (model.orphans.length > 0) this.renderOrphans(zoomWrap, model.orphans);
    for (const map of model.maps) this.renderMap(zoomWrap, map);
    if (this.selectionMode) this.renderSelectBar(root, model);

    root.scrollTop = scrollTop;
    for (const scroller of Array.from(root.querySelectorAll<HTMLElement>(".wf-tree-scroll"))) {
      const scrollLeft = mapScrollLeft.get(Number(scroller.dataset.mapNumber));
      if (scrollLeft !== undefined) scroller.scrollLeft = scrollLeft;
    }
    this.prevUpdated = new Map(snapshot.issues.map((i) => [i.number, i.updated_at]));
    // Edges need final geometry — draw after layout settles.
    this.scheduleEdges();
  }

  /** True when this issue is new or changed since the previous render. */
  private changedSinceLastRender(issue: RawIssue): boolean {
    if (!this.prevUpdated) return false; // first render — nothing to compare
    return this.prevUpdated.get(issue.number) !== issue.updated_at;
  }

  private toggleAllMaps(model: Model, anyExpanded: boolean): void {
    for (const map of model.maps) this.collapsedOverride.set(map.issue.number, anyExpanded);
    this.render();
  }

  private toggleMode(): void {
    this.mode = this.mode === "tree" ? "list" : "tree";
    this.render();
  }

  private toggleSelectionMode(): void {
    this.selectionMode = !this.selectionMode;
    this.render();
  }

  private pruneSelection(model: Model): void {
    const frontier = new Set(
      model.maps.flatMap((map) =>
        map.tickets.filter((ticket) => ticket.frontier).map((ticket) => ticket.issue.number),
      ),
    );
    for (const number of this.selectedIssues) {
      if (!frontier.has(number)) this.selectedIssues.delete(number);
    }
  }

  private selectedTickets(model: Model): Ticket[] {
    return model.maps.flatMap((map) =>
      map.tickets.filter(
        (ticket) => ticket.frontier && this.selectedIssues.has(ticket.issue.number),
      ),
    );
  }

  private toggleTicketSelection(ticket: Ticket): void {
    if (this.selectedIssues.has(ticket.issue.number)) {
      this.selectedIssues.delete(ticket.issue.number);
    } else {
      this.selectedIssues.add(ticket.issue.number);
    }
    this.render();
  }

  private renderSelectBar(root: HTMLElement, model: Model): void {
    const selected = this.selectedTickets(model);
    const bar = root.createDiv({ cls: "wf-selectbar" });
    bar.createSpan({ cls: "wf-select-count", text: `${selected.length} selected` });

    const commands = bar.createEl("button", { text: "Copy commands", cls: "mod-cta" });
    commands.disabled = selected.length === 0;
    commands.addEventListener("click", () => {
      const text = selected
        .map((ticket) => this.plugin.settings.copyTemplate.replace("{url}", ticket.issue.html_url))
        .join("\n");
      void navigator.clipboard.writeText(text).then(
        () => new Notice(`Copied ${selected.length} commands`),
        () => new Notice("Copy failed — clipboard unavailable"),
      );
    });

    const checklist = bar.createEl("button", { text: "Copy checklist" });
    checklist.disabled = selected.length === 0;
    checklist.addEventListener("click", () => {
      const text = selected
        .map(
          (ticket) =>
            `- [ ] /wayfinder ${ticket.issue.html_url} — #${ticket.issue.number} ${ticket.issue.title} (${ticket.type}, ${ticket.mode})`,
        )
        .join("\n");
      void navigator.clipboard.writeText(text).then(
        () => new Notice(`Copied checklist (${selected.length} tickets)`),
        () => new Notice("Copy failed — clipboard unavailable"),
      );
    });

    const clear = bar.createEl("button", { text: "Clear" });
    clear.disabled = selected.length === 0;
    clear.addEventListener("click", () => {
      this.selectedIssues.clear();
      this.render();
    });

    const done = bar.createEl("button", { text: "Done" });
    done.addEventListener("click", () => this.toggleSelectionMode());
    this.positionSelectBar();
  }

  private positionSelectBar(): void {
    const bar = this.contentEl.querySelector<HTMLElement>(".wf-selectbar");
    if (!bar) return;
    const rect = this.contentEl.getBoundingClientRect();
    bar.style.left = `${rect.left + rect.width / 2}px`;
    bar.style.bottom = `${Math.max(8, window.innerHeight - rect.bottom + 12)}px`;
    bar.style.maxWidth = `${Math.max(0, rect.width - 32)}px`;
  }

  // ── orphans ──────────────────────────────────────────────────────────────

  private renderOrphans(root: HTMLElement, orphans: Ticket[]): void {
    const box = root.createDiv({ cls: "wf-orphans" });
    box.createDiv({
      cls: "wf-orphans-title",
      text: `⚠ ${orphans.length} wayfinder ticket(s) not attached to any map`,
    });
    for (const t of orphans) {
      const row = box.createDiv({ cls: "wf-orphan-row" });
      row.createSpan({ cls: "wf-num", text: `#${t.issue.number}` });
      row.createSpan({ text: t.issue.title });
      row.createSpan({
        cls: "wf-orphan-why",
        text: t.parent === null ? "no “Part of #N” line" : `parent #${t.parent} is not a map`,
      });
      this.makeInteractive(row, () => new TicketModal(this.app, this.plugin, t, null).open());
    }
  }

  // ── map + tree ───────────────────────────────────────────────────────────

  private renderMap(root: HTMLElement, map: MapTree): void {
    const isClosed = map.issue.state === "closed";
    const collapsed = this.collapsedOverride.get(map.issue.number) ?? isClosed;
    const expanded = !collapsed;
    const section = root.createDiv({ cls: "wf-map-section" });

    const head = section.createDiv({ cls: "wf-mapcard" });
    const chevron = head.createEl("button", {
      cls: "wf-chevron",
      attr: { "aria-label": expanded ? "Collapse map" : "Expand map" },
    });
    setIcon(chevron, expanded ? "chevron-down" : "chevron-right");
    chevron.addEventListener("click", (e) => {
      e.stopPropagation();
      this.collapsedOverride.set(map.issue.number, expanded);
      this.render();
    });

    const headMain = head.createDiv({ cls: "wf-mapcard-main" });
    const row1 = headMain.createDiv({ cls: "wf-row1" });
    row1.createSpan({ cls: "wf-num", text: `#${map.issue.number}` });
    row1.createSpan({ cls: "wf-type wf-type-map", text: "map" });
    if (isClosed) row1.createSpan({ cls: "wf-map-done", text: "✓ complete" });
    headMain.createDiv({ cls: "wf-map-title", text: map.issue.title });
    const prog = headMain.createDiv({ cls: "wf-progress" });
    prog.createSpan({ text: `${map.resolved} / ${map.total} resolved` });
    const bar = prog.createDiv({ cls: "wf-bar" });
    bar.createDiv({
      cls: "wf-bar-fill",
      attr: { style: `width:${map.total ? Math.round((map.resolved / map.total) * 100) : 0}%` },
    });
    const openTickets = map.tickets.filter((ticket) => ticket.issue.state === "open");
    if (!isClosed && openTickets.length > 0) {
      const takeable = openTickets.filter((ticket) => ticket.frontier).length;
      const blocked = openTickets.filter(
        (ticket) => ticket.unverified || ticket.openBlockers.length > 0,
      ).length;
      const claimed = openTickets.filter(
        (ticket) =>
          !ticket.unverified &&
          ticket.openBlockers.length === 0 &&
          ticket.issue.assignees.length > 0,
      ).length;
      const stats = [
        takeable > 0 ? `${takeable} takeable` : "",
        blocked > 0 ? `${blocked} blocked` : "",
        claimed > 0 ? `${claimed} claimed` : "",
      ].filter(Boolean);
      if (stats.length > 0) {
        headMain.createDiv({ cls: "wf-map-stats", text: stats.join(" · ") });
      }
    }

    if (this.changedSinceLastRender(map.issue)) head.addClass("wf-changed");
    addIconActions(head, map.issue, this.plugin, () =>
      new TicketModal(this.app, this.plugin, null, map).open(),
    );
    this.makeInteractive(head, () => {
      this.collapsedOverride.set(map.issue.number, expanded);
      this.render();
    });
    this.hoverCards.attach(head, null, map);

    if (!expanded) return;
    if (map.tickets.length === 0) {
      section.createDiv({ cls: "wf-no-tickets", text: "No tickets attached yet." });
      return;
    }

    if (this.mode === "list") {
      renderList(section, map, this.ticketCardOptions());
      return;
    }

    const tree = renderTree(section, map, this.ticketCardOptions());
    this.resizeObserver?.observe(tree);
  }

  private ticketCardOptions(): Omit<TicketCardOptions, "asRow"> {
    return {
      app: this.app,
      plugin: this.plugin,
      selectionMode: this.selectionMode,
      selected: (ticket) => this.selectedIssues.has(ticket.issue.number),
      changed: (issue) => this.changedSinceLastRender(issue),
      makeInteractive: (element, activate) => this.makeInteractive(element, activate),
      attachHover: (element, ticket, map) => this.hoverCards.attach(element, ticket, map),
      select: (ticket) => this.toggleTicketSelection(ticket),
    };
  }

}
