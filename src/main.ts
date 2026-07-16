import { Events, Notice, Plugin, WorkspaceLeaf, requestUrl } from "obsidian";
import { GitHubClient, fetchSnapshot, type Http, type IssueComment } from "./github";
import { buildModel, type RawIssue, type Snapshot } from "./model";
import { DEFAULT_SETTINGS, WayfinderSettingTab, type WayfinderSettings } from "./settings";
import { VIEW_TYPE_WAYFINDER, WayfinderView } from "./view";

interface PersistedData {
  settings: WayfinderSettings;
  snapshot: Snapshot | null;
}

const obsidianHttp: Http = async (url, headers) => {
  const res = await requestUrl({ url, headers, throw: false });
  return { status: res.status, json: res.json };
};

export default class WayfinderPlugin extends Plugin {
  settings: WayfinderSettings = { ...DEFAULT_SETTINGS };
  snapshot: Snapshot | null = null;
  events = new Events();
  syncing = false;
  lastError: string | null = null;
  private github = new GitHubClient(
    () => ({ token: this.settings.token, repo: this.settings.repo }),
    obsidianHttp,
  );

  fetchComments(issueNumber: number): Promise<IssueComment[]> {
    return this.github.comments(issueNumber);
  }

  /** Live-check an open, unclaimed ticket right before acting on it. */
  async guardedAction(issueNumber: number, action: () => void): Promise<void> {
    const snap = this.snapshot;
    const cached = snap?.issues.find((i) => i.number === issueNumber);
    if (!snap || !cached || cached.state !== "open" || cached.assignees.length > 0) {
      action();
      return;
    }
    let fresh: RawIssue | null;
    try {
      fresh = await Promise.race([
        this.github.issue(issueNumber),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 2000)),
      ]);
    } catch {
      new Notice(`Couldn't verify #${issueNumber} is still takeable — proceeding`);
      action();
      return;
    }
    if (!fresh) {
      new Notice(`Couldn't verify #${issueNumber} is still takeable — proceeding`);
      action();
      return;
    }
    let warning: string | null = null;
    if (fresh.state === "closed") {
      warning = `#${issueNumber} was resolved since the last sync`;
    } else if (fresh.assignees.length > 0) {
      warning = `#${issueNumber} was claimed by ${fresh.assignees.join(", ")} since the last sync`;
    }
    if (warning) {
      snap.issues[snap.issues.indexOf(cached)] = fresh;
      this.events.trigger("wayfinder:updated");
      new Notice(`⚠ ${warning}`, 6000);
      return;
    }
    action();
  }

  /** Copy the /wayfinder command for the newest frontier ticket. */
  copyNextTakeable(): void {
    if (!this.snapshot) {
      new Notice("Wayfinder: no data yet — open the view to sync first.");
      return;
    }
    const model = buildModel(this.snapshot);
    const frontier = model.maps.flatMap((map) => map.tickets.filter((ticket) => ticket.frontier));
    if (frontier.length > 0) {
      const pick = frontier.reduce((newest, ticket) =>
        ticket.issue.number > newest.issue.number ? ticket : newest,
      );
      void this.guardedAction(pick.issue.number, () => {
        this.copyCommand(pick.issue.html_url);
        new Notice(`Next takeable: #${pick.issue.number} ${pick.issue.title}`);
      });
      return;
    }
    new Notice("Wayfinder: no takeable tickets right now.");
  }

  copyCommand(url: string): void {
    const text = this.settings.copyTemplate.replace("{url}", url);
    void navigator.clipboard.writeText(text).then(
      () => new Notice(`Copied: ${text}`),
      () => new Notice("Copy failed — clipboard unavailable"),
    );
  }

  async onload(): Promise<void> {
    const data = ((await this.loadData()) ?? {}) as Partial<PersistedData>;
    this.settings = { ...DEFAULT_SETTINGS, ...data.settings };
    this.snapshot = data.snapshot ?? null;

    this.registerView(VIEW_TYPE_WAYFINDER, (leaf) => new WayfinderView(leaf, this));
    this.addRibbonIcon("compass", "Open Wayfinder", () => this.activateView());
    this.addCommand({
      id: "open-view",
      name: "Open Wayfinder view",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "sync",
      name: "Sync now",
      callback: () => this.sync(true),
    });
    this.addCommand({
      id: "copy-next-takeable",
      name: "Copy /wayfinder for the next takeable ticket",
      callback: () => this.copyNextTakeable(),
    });
    this.addSettingTab(new WayfinderSettingTab(this.app, this));
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_WAYFINDER);
    let leaf: WorkspaceLeaf | null;
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = this.app.workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_WAYFINDER, active: true });
    }
    if (leaf) this.app.workspace.revealLeaf(leaf);
  }

  /** Sync from GitHub. `full` re-fetches every dependency edge. */
  async sync(full = false): Promise<void> {
    if (this.syncing) return;
    if (!this.settings.token || !this.settings.repo.includes("/")) {
      this.lastError = "Set a GitHub token and repo in Settings → Wayfinder.";
      this.events.trigger("wayfinder:updated");
      return;
    }
    this.syncing = true;
    this.events.trigger("wayfinder:updated");
    try {
      this.snapshot = await fetchSnapshot(this.github, this.snapshot, full);
      this.lastError = null;
      await this.persist();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      new Notice(`Wayfinder sync failed: ${this.lastError}`);
    } finally {
      this.syncing = false;
      this.events.trigger("wayfinder:updated");
    }
  }

  private settingsSyncTimer: number | null = null;

  /** Persist settings and, once edits settle, try a sync with the new values. */
  async saveSettings(): Promise<void> {
    await this.persist();
    this.events.trigger("wayfinder:settings");
    if (this.settingsSyncTimer !== null) window.clearTimeout(this.settingsSyncTimer);
    this.settingsSyncTimer = window.setTimeout(() => {
      this.settingsSyncTimer = null;
      if (this.settings.token && this.settings.repo.includes("/")) void this.sync(true);
    }, 800);
  }

  private async persist(): Promise<void> {
    const data: PersistedData = { settings: this.settings, snapshot: this.snapshot };
    await this.saveData(data);
  }
}
