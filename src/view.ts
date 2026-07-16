import { ItemView, Platform, WorkspaceLeaf, setIcon } from "obsidian";
import type { RawIssue } from "./model";
import type WayfinderPlugin from "./main";
import { TicketModal } from "./modal";
import {
  buildModel,
  descriptionOf,
  type MapTree,
  type Model,
  type Ticket,
} from "./model";

export const VIEW_TYPE_WAYFINDER = "wayfinder-view";

type ViewMode = "tree" | "list";
const MODE_KEY = "wayfinder-view-mode";
const ZOOM_KEY = "wayfinder-zoom";
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;

export class WayfinderView extends ItemView {
  /** Per-map collapse override; default is expanded for open maps, collapsed for closed. */
  private collapsedOverride = new Map<number, boolean>();

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
  private hoverCard: HTMLElement | null = null;
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
    this.hoverCard?.remove();
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
    this.edgeRaf = requestAnimationFrame(() => this.drawAllEdges());
  }

  /** Make a card keyboard-operable: tabbable, Enter/Space activates. */
  private makeInteractive(el: HTMLElement, activate: () => void): void {
    el.setAttr("tabindex", "0");
    el.setAttr("role", "button");
    el.addEventListener("click", activate);
    el.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
  }

  private render(): void {
    const root = this.contentEl;
    const scrollTop = root.scrollTop;
    this.lastRenderKey = this.snapshotKey();
    root.empty();
    root.addClass("wayfinder-view");
    this.hoverCard?.remove();
    this.hoverCard = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.scheduleEdges());

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
    this.renderTallyBar(root, model);
    if (this.plugin.lastError) {
      root.createDiv({ text: `Last sync failed: ${this.plugin.lastError}`, cls: "wf-error" });
    }
    const zoomWrap = root.createDiv({ cls: "wf-zoom" });
    zoomWrap.style.setProperty("zoom", String(this.zoom));
    if (model.orphans.length > 0) this.renderOrphans(zoomWrap, model.orphans);
    for (const map of model.maps) this.renderMap(zoomWrap, map);

    root.scrollTop = scrollTop;
    this.prevUpdated = new Map(snapshot.issues.map((i) => [i.number, i.updated_at]));
    // Edges need final geometry — draw after layout settles.
    this.scheduleEdges();
  }

  /** True when this issue is new or changed since the previous render. */
  private changedSinceLastRender(issue: RawIssue): boolean {
    if (!this.prevUpdated) return false; // first render — nothing to compare
    return this.prevUpdated.get(issue.number) !== issue.updated_at;
  }

  // ── tally bar ────────────────────────────────────────────────────────────

  private renderTallyBar(root: HTMLElement, model: Model): void {
    const bar = root.createDiv({ cls: "wf-tally" });
    for (const { type, tally } of model.tallies) {
      const stat = bar.createDiv({ cls: `wf-stat wf-t-${type}` });
      stat.createSpan({ cls: "wf-swatch" });
      stat.createSpan({ cls: "wf-stat-num", text: `${tally.open}/${tally.total}` });
      stat.createSpan({ cls: "wf-stat-lbl", text: type === "map" ? "maps" : type });
      stat.setAttr("aria-label", `${type}: ${tally.open} open of ${tally.total} total`);
    }

    const frontier = model.maps.flatMap((m) => m.tickets.filter((t) => t.frontier));
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
    const hitl = frontier.filter((t) => t.mode === "HITL").length;
    const afk = frontier.filter((t) => t.mode === "AFK").length;
    const either = frontier.filter((t) => t.mode === "either").length;
    chip("wf-t-hitl", hitl, "need you", `${hitl} takeable tickets need a human in the loop`);
    chip("wf-t-afk", afk, "agent-ready", `${afk} takeable tickets an agent can run alone`);
    if (either > 0) {
      chip("wf-t-either", either, "either", `${either} takeable task tickets could go either way`);
    }

    const right = bar.createDiv({ cls: "wf-tally-right" });
    right.createSpan({ cls: "wf-sync-status", text: this.syncStatusText() });
    const anyExpanded = model.maps.some(
      (m) => !(this.collapsedOverride.get(m.issue.number) ?? m.issue.state === "closed"),
    );
    const foldBtn = right.createEl("button", {
      cls: "wf-refresh",
      attr: { "aria-label": anyExpanded ? "Collapse all maps" : "Expand all maps" },
    });
    setIcon(foldBtn, anyExpanded ? "chevrons-down-up" : "chevrons-up-down");
    foldBtn.addEventListener("click", () => {
      for (const m of model.maps) this.collapsedOverride.set(m.issue.number, anyExpanded);
      this.render();
    });

    const zoomOut = right.createEl("button", {
      cls: "wf-refresh",
      attr: { "aria-label": "Zoom out" },
    });
    setIcon(zoomOut, "zoom-out");
    zoomOut.addEventListener("click", () => this.setZoom(this.zoom / 1.15));
    const zoomLabel = right.createEl("button", {
      cls: "wf-refresh wf-zoom-label",
      text: `${Math.round(this.zoom * 100)}%`,
      attr: { "aria-label": "Reset zoom" },
    });
    zoomLabel.addEventListener("click", () => this.setZoom(1));
    const zoomIn = right.createEl("button", {
      cls: "wf-refresh",
      attr: { "aria-label": "Zoom in" },
    });
    setIcon(zoomIn, "zoom-in");
    zoomIn.addEventListener("click", () => this.setZoom(this.zoom * 1.15));

    const modeBtn = right.createEl("button", {
      cls: "wf-refresh",
      attr: { "aria-label": this.mode === "tree" ? "Switch to list view" : "Switch to tree view" },
    });
    setIcon(modeBtn, this.mode === "tree" ? "list" : "git-fork");
    modeBtn.addEventListener("click", () => {
      this.mode = this.mode === "tree" ? "list" : "tree";
      this.render();
    });
    const refresh = right.createEl("button", { cls: "wf-refresh", attr: { "aria-label": "Refresh now" } });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => void this.plugin.sync(true));
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
    const chevron = head.createDiv({
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

    if (this.changedSinceLastRender(map.issue)) head.addClass("wf-changed");
    this.addIconActions(head, map.issue, () =>
      new TicketModal(this.app, this.plugin, null, map).open(),
    );
    this.makeInteractive(head, () => {
      this.collapsedOverride.set(map.issue.number, expanded);
      this.render();
    });
    this.attachHover(head, null, map);

    if (!expanded) return;
    if (map.tickets.length === 0) {
      section.createDiv({ cls: "wf-no-tickets", text: "No tickets attached yet." });
      return;
    }

    if (this.mode === "list") {
      this.renderList(section, map);
      return;
    }

    const scroller = section.createDiv({ cls: "wf-tree-scroll" });
    const tree = scroller.createDiv({ cls: "wf-tree" });
    tree.dataset.mapNumber = String(map.issue.number);
    const svg = tree.createSvg("svg", { cls: "wf-edges" });
    svg.setAttr("aria-hidden", "true");

    for (const layer of map.layers) {
      const layerEl = tree.createDiv({ cls: "wf-layer" });
      for (const ticket of layer) this.renderTicket(layerEl, ticket, map);
    }

    this.resizeObserver?.observe(tree);
  }

  /** Compact mode: full-width rows grouped by actionability. */
  private renderList(section: HTMLElement, map: MapTree): void {
    const groups: { label: string; tickets: Ticket[] }[] = [
      { label: "Takeable", tickets: map.tickets.filter((t) => t.frontier) },
      {
        label: "Claimed",
        tickets: map.tickets.filter(
          (t) =>
            t.issue.state === "open" &&
            !t.frontier &&
            !t.unverified &&
            t.openBlockers.length === 0,
        ),
      },
      {
        label: "Blocked",
        tickets: map.tickets.filter(
          (t) => t.issue.state === "open" && (t.openBlockers.length > 0 || t.unverified),
        ),
      },
      { label: "Resolved", tickets: map.tickets.filter((t) => t.issue.state === "closed") },
    ];
    const list = section.createDiv({ cls: "wf-list" });
    for (const g of groups) {
      if (g.tickets.length === 0) continue;
      const h = list.createDiv({ cls: "wf-group-h" });
      h.createSpan({ text: g.label });
      h.createSpan({ cls: "wf-group-count", text: String(g.tickets.length) });
      for (const t of g.tickets) this.renderTicket(list, t, map, true);
    }
  }

  /**
   * Small always-available actions on a card: optional ⓘ details, ⧉ copy,
   * ↗ GitHub. When `claimCheck` is set (takeable tickets), copy/open first
   * verify against GitHub that the ticket wasn't claimed since the last sync;
   * a warning notice replaces the action when the live issue is no longer clear.
   */
  private addIconActions(
    card: HTMLElement,
    issue: RawIssue,
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
      info.addEventListener("click", (e) => {
        e.stopPropagation();
        onInfo();
      });
    }

    const guarded = async (action: () => void): Promise<void> => {
      if (claimCheck) {
        await this.plugin.guardedAction(issue.number, action);
        return;
      }
      action();
    };

    const copy = actions.createEl("button", {
      cls: "wf-iconbtn",
      attr: { "aria-label": "Copy /wayfinder command" },
    });
    setIcon(copy, "copy");
    copy.addEventListener("click", (e) => {
      e.stopPropagation();
      void guarded(() => this.plugin.copyCommand(issue.html_url));
    });

    const open = actions.createEl("a", {
      cls: "wf-iconbtn",
      href: issue.html_url,
      attr: { "aria-label": "Open on GitHub" },
    });
    setIcon(open, "external-link");
    open.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!claimCheck) return; // plain link navigation
      e.preventDefault();
      void guarded(() => window.open(issue.html_url, "_blank"));
    });
  }

  private renderTicket(layerEl: HTMLElement, t: Ticket, map: MapTree, asRow = false): void {
    const card = layerEl.createDiv({ cls: `wf-ticket wf-t-${t.type}${asRow ? " wf-ticket-row" : ""}` });
    card.dataset.issue = String(t.issue.number);
    const closed = t.issue.state === "closed";
    const blocked = !closed && t.openBlockers.length > 0;
    if (closed) card.addClass("wf-closed");
    if (blocked) card.addClass("wf-blocked");
    if (t.frontier) {
      card.addClass("wf-frontier");
      card.createSpan({ cls: "wf-frontier-flag", text: "FRONTIER" });
    }

    const row1 = card.createDiv({ cls: "wf-row1" });
    row1.createSpan({ cls: "wf-num", text: `#${t.issue.number}` });
    row1.createSpan({ cls: "wf-type", text: t.type });
    row1.createSpan({ cls: `wf-mode wf-mode-${t.mode.toLowerCase()}`, text: t.mode });

    card.createDiv({ cls: "wf-ticket-title", text: t.issue.title });

    const meta = card.createDiv({ cls: "wf-meta" });
    if (closed) {
      meta.setText("✓ resolved");
    } else if (t.unverified) {
      meta.setText("⚠ blockers unverified");
    } else if (blocked) {
      meta.setText(`🔒 blocked by ${t.openBlockers.map((n) => `#${n}`).join(" ")}`);
    } else if (t.issue.assignees.length > 0) {
      meta.setText(`● claimed by ${t.issue.assignees.join(", ")}`);
    } else {
      meta.setText("● open · takeable now");
    }

    if (this.changedSinceLastRender(t.issue)) card.addClass("wf-changed");
    this.addIconActions(card, t.issue, undefined, t.frontier);
    this.makeInteractive(card, () => new TicketModal(this.app, this.plugin, t, map).open());
    this.attachHover(card, t, map);
  }

  // ── edges ────────────────────────────────────────────────────────────────

  private drawAllEdges(): void {
    for (const tree of Array.from(this.contentEl.querySelectorAll<HTMLElement>(".wf-tree"))) {
      this.drawEdges(tree);
    }
  }

  private drawEdges(tree: HTMLElement): void {
    const svg = tree.querySelector<SVGSVGElement>("svg.wf-edges");
    const snapshot = this.plugin.snapshot;
    if (!svg || !snapshot) return;
    const treeRect = tree.getBoundingClientRect();
    if (treeRect.width === 0) return;
    svg.setAttr("viewBox", `0 0 ${treeRect.width} ${treeRect.height}`);
    svg.empty();

    const cards = new Map<number, HTMLElement>();
    for (const el of Array.from(tree.querySelectorAll<HTMLElement>(".wf-ticket"))) {
      cards.set(Number(el.dataset.issue), el);
    }

    for (const [num, card] of cards) {
      const dep = snapshot.deps[String(num)];
      if (!dep) continue;
      for (const blocker of dep.blockedBy) {
        const from = cards.get(blocker);
        if (!from) continue; // blocker outside this map
        this.drawEdge(svg, treeRect, from, card);
      }
    }
  }

  private drawEdge(
    svg: SVGSVGElement,
    treeRect: DOMRect,
    from: HTMLElement,
    to: HTMLElement,
  ): void {
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const x1 = a.left + a.width / 2 - treeRect.left;
    const y1 = a.bottom - treeRect.top;
    const x2 = b.left + b.width / 2 - treeRect.left;
    const y2 = b.top - treeRect.top;
    const my = (y2 - y1) / 2;

    const path = svg.createSvg("path");
    path.setAttr("d", `M ${x1} ${y1} C ${x1} ${y1 + my}, ${x2} ${y2 - my}, ${x2} ${y2}`);
    path.setAttr("fill", "none");
    const frontier = to.hasClass("wf-frontier");
    const closed = to.hasClass("wf-closed");
    path.setAttr("class", frontier ? "wf-edge-frontier" : closed ? "wf-edge-closed" : "wf-edge-open");
    if (to.hasClass("wf-blocked")) path.setAttr("stroke-dasharray", "4 3");
  }

  // ── interactions ─────────────────────────────────────────────────────────

  private attachHover(el: HTMLElement, ticket: Ticket | null, map: MapTree): void {
    if (Platform.isMobile) return; // no hover on touch; the modal covers details
    el.addEventListener("mouseenter", () => {
      this.hoverCard?.remove();
      const card = document.body.createDiv({ cls: "wf-hovercard" });
      this.hoverCard = card;

      const issue = ticket ? ticket.issue : map.issue;
      const row = card.createDiv({ cls: "wf-row1" });
      row.createSpan({ cls: "wf-num", text: `#${issue.number}` });
      if (ticket) {
        row.createSpan({ cls: `wf-type wf-hc-${ticket.type}`, text: ticket.type });
        row.createSpan({ cls: `wf-mode wf-mode-${ticket.mode.toLowerCase()}`, text: ticket.mode });
      } else {
        row.createSpan({ cls: "wf-type wf-hc-map", text: "map" });
      }
      card.createDiv({ cls: "wf-hc-title", text: issue.title });

      const desc = descriptionOf(issue.body);
      if (desc) {
        card.createDiv({
          cls: "wf-hc-desc",
          text: desc.length > 420 ? `${desc.slice(0, 420)}…` : desc,
        });
      }

      if (ticket && ticket.blockedBy.length > 0) {
        const kv = card.createDiv({ cls: "wf-hc-kv" });
        kv.createSpan({ text: "Blocked by: " });
        const openSet = new Set(ticket.openBlockers);
        kv.createSpan({
          text: ticket.blockedBy
            .map((n) => (openSet.has(n) ? `#${n}` : `#${n} ✓`))
            .join("  "),
        });
      }
      const kv2 = card.createDiv({ cls: "wf-hc-kv" });
      kv2.createSpan({
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

      const r = el.getBoundingClientRect();
      card.style.left = `${Math.min(r.left, window.innerWidth - 360)}px`;
      card.style.top =
        r.bottom + 12 + card.offsetHeight < window.innerHeight
          ? `${r.bottom + 8}px`
          : `${Math.max(8, r.top - card.offsetHeight - 8)}px`;
    });
    el.addEventListener("mouseleave", () => {
      this.hoverCard?.remove();
      this.hoverCard = null;
    });
  }
}

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
