import { App, Component, MarkdownRenderer, Modal, setIcon } from "obsidian";
import type WayfinderPlugin from "./main";
import { blockerLabel, descriptionOf, type MapTree, type Ticket } from "./model";

/** Detail card for a ticket or map: description, blockers, progress, comments. */
export class TicketModal extends Modal {
  private comp = new Component();
  private closed = false;

  constructor(
    app: App,
    private plugin: WayfinderPlugin,
    private ticket: Ticket | null,
    private map: MapTree | null,
  ) {
    super(app);
  }

  onOpen(): void {
    this.closed = false;
    this.comp.load();
    const { contentEl } = this;
    contentEl.addClass("wf-modal");
    const issue = this.ticket ? this.ticket.issue : this.map!.issue;

    const head = contentEl.createDiv({ cls: "wf-modal-head" });
    const row = head.createDiv({ cls: "wf-row1" });
    row.createSpan({ cls: "wf-num", text: `#${issue.number}` });
    if (this.ticket) {
      row.createSpan({ cls: `wf-type wf-hc-${this.ticket.type}`, text: this.ticket.type });
      row.createSpan({
        cls: `wf-mode wf-mode-${this.ticket.mode.toLowerCase()}`,
        text: this.ticket.mode,
      });
    } else {
      row.createSpan({ cls: "wf-type wf-hc-map", text: "map" });
    }
    row.createSpan({ cls: "wf-modal-state", text: this.stateText() });
    head.createDiv({ cls: "wf-modal-title", text: issue.title });

    const actions = contentEl.createDiv({ cls: "wf-modal-actions" });
    const copyBtn = actions.createEl("button", { text: "Copy /wayfinder command", cls: "mod-cta" });
    copyBtn.addEventListener("click", () => {
      const action = (): void => this.plugin.copyCommand(issue.html_url);
      if (this.ticket?.frontier) void this.plugin.guardedAction(issue.number, action);
      else action();
    });
    const ghBtn = actions.createEl("button", { text: "Open on GitHub ↗" });
    ghBtn.addEventListener("click", () => {
      const action = (): void => {
        window.open(issue.html_url, "_blank");
      };
      if (this.ticket?.frontier) void this.plugin.guardedAction(issue.number, action);
      else action();
    });

    const map = this.map;
    if (!this.ticket && map) {
      const prog = contentEl.createDiv({ cls: "wf-progress wf-modal-progress" });
      prog.createSpan({ text: `${map.resolved} / ${map.total} tickets resolved` });
      const bar = prog.createDiv({ cls: "wf-bar" });
      bar.createDiv({
        cls: "wf-bar-fill",
        attr: {
          style: `width:${map.total ? Math.round((map.resolved / map.total) * 100) : 0}%`,
        },
      });
    }

    if (this.ticket && this.ticket.blockers.length > 0) {
      const openSet = new Set(this.ticket.openBlockers);
      const kv = contentEl.createDiv({ cls: "wf-hc-kv" });
      kv.createSpan({ text: "Blocked by: " });
      for (const blocker of this.ticket.blockers) {
        const repo = blocker.repo ?? this.plugin.settings.repo;
        kv.createEl("a", {
          text: openSet.has(blocker)
            ? `${blockerLabel(blocker)} (open)`
            : `${blockerLabel(blocker)} ✓`,
          href: `https://github.com/${repo}/issues/${blocker.number}`,
          cls: "wf-blocker-link",
        });
      }
    }
    contentEl.createDiv({
      cls: "wf-hc-kv",
      text: `Assignee: ${issue.assignees.join(", ") || "—"} · Updated ${new Date(
        issue.updated_at,
      ).toLocaleString()}`,
    });

    const desc = contentEl.createDiv({ cls: "wf-modal-desc markdown-rendered" });
    void MarkdownRenderer.render(
      this.app,
      descriptionOf(issue.body) || "*No description.*",
      desc,
      "",
      this.comp,
    );

    const commentsEl = contentEl.createDiv({ cls: "wf-modal-comments" });
    commentsEl.createDiv({ cls: "wf-comments-h", text: "Comments" });
    const status = commentsEl.createDiv({ cls: "wf-hc-kv", text: "Loading comments…" });
    void this.plugin
      .fetchComments(issue.number)
      .then((comments) => {
        if (this.closed) return;
        status.remove();
        if (comments.length === 0) {
          commentsEl.createDiv({ cls: "wf-hc-kv", text: "No comments." });
          return;
        }
        for (const c of comments) {
          const box = commentsEl.createDiv({ cls: "wf-comment" });
          box.createDiv({
            cls: "wf-comment-meta",
            text: `${c.author} · ${new Date(c.createdAt).toLocaleString()}`,
          });
          const body = box.createDiv({ cls: "markdown-rendered" });
          void MarkdownRenderer.render(this.app, c.body, body, "", this.comp);
        }
      })
      .catch((e) => {
        if (this.closed) return;
        status.setText(`Could not load comments: ${e instanceof Error ? e.message : String(e)}`);
      });
  }

  private stateText(): string {
    const issue = this.ticket ? this.ticket.issue : this.map!.issue;
    if (issue.state === "closed") return "✓ resolved";
    if (this.ticket?.frontier) return "● frontier — takeable now";
    if (this.ticket && this.ticket.openBlockers.length > 0) return "🔒 blocked";
    if (issue.assignees.length > 0) return "● claimed";
    return "● open";
  }

  onClose(): void {
    this.closed = true;
    this.comp.unload();
    this.contentEl.empty();
  }
}
