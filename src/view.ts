import { ItemView, Platform, WorkspaceLeaf, setIcon } from "obsidian";
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

  async onOpen(): Promise<void> {
    this.registerEvent(this.plugin.events.on("wayfinder:updated", () => this.render()));
    this.registerInterval(
      window.setInterval(
        () => void this.plugin.sync(false),
        Math.max(0.5, this.plugin.settings.pollIntervalMinutes) * 60_000,
      ),
    );
    this.render();
    void this.plugin.sync(false);
  }

  async onClose(): Promise<void> {
    this.hoverCard?.remove();
    this.resizeObserver?.disconnect();
  }

  private render(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("wayfinder-view");
    this.hoverCard?.remove();
    this.hoverCard = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.drawAllEdges());

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
    if (model.orphans.length > 0) this.renderOrphans(root, model.orphans);
    for (const map of model.maps) this.renderMap(root, map);

    // Edges need final geometry — draw after layout settles.
    requestAnimationFrame(() => this.drawAllEdges());
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

    const right = bar.createDiv({ cls: "wf-tally-right" });
    const syncedAgo = this.plugin.syncing
      ? "syncing…"
      : `synced ${relativeTime(model.fetchedAt)}`;
    right.createSpan({
      text: `${model.totalIssues} issues · ${model.totalOpen} open · ${syncedAgo}`,
    });
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
      row.addEventListener("click", () => this.plugin.copyCommand(t.issue.html_url));
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

    this.addIconActions(head, map.issue.html_url);
    head.addEventListener("click", () => new TicketModal(this.app, this.plugin, null, map).open());
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
          (t) => t.issue.state === "open" && !t.frontier && t.openBlockers.length === 0,
        ),
      },
      {
        label: "Blocked",
        tickets: map.tickets.filter(
          (t) => t.issue.state === "open" && t.openBlockers.length > 0,
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

  /** Small always-available actions on a card: ⧉ copy and ↗ open on GitHub. */
  private addIconActions(card: HTMLElement, url: string): void {
    const actions = card.createDiv({ cls: "wf-actions" });
    const copy = actions.createEl("button", {
      cls: "wf-iconbtn",
      attr: { "aria-label": "Copy /wayfinder command" },
    });
    setIcon(copy, "copy");
    copy.addEventListener("click", (e) => {
      e.stopPropagation();
      this.plugin.copyCommand(url);
    });
    const open = actions.createEl("a", {
      cls: "wf-iconbtn",
      href: url,
      attr: { "aria-label": "Open on GitHub" },
    });
    setIcon(open, "external-link");
    open.addEventListener("click", (e) => e.stopPropagation());
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
    } else if (blocked) {
      meta.setText(`🔒 blocked by ${t.openBlockers.map((n) => `#${n}`).join(" ")}`);
    } else if (t.issue.assignees.length > 0) {
      meta.setText(`● claimed by ${t.issue.assignees.join(", ")}`);
    } else {
      meta.setText("● open · takeable now");
    }

    this.addIconActions(card, t.issue.html_url);
    card.addEventListener("click", () => new TicketModal(this.app, this.plugin, t, map).open());
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
        text: "Click for details + comments · ⧉ copies /wayfinder · ↗ opens GitHub",
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
