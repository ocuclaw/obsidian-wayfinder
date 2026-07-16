import { Events, Notice, Plugin, WorkspaceLeaf, requestUrl } from "obsidian";
import { GitHubClient, fetchSnapshot, type Http, type IssueComment } from "./github";
import { buildModel, type RawIssue, type Snapshot } from "./model";
import { DEFAULT_SETTINGS, WayfinderSettingTab, type WayfinderSettings } from "./settings";
import { VIEW_TYPE_WAYFINDER, WayfinderView } from "./view";

interface PersistedData {
  settings: WayfinderSettings;
  snapshot: Snapshot | null;
}

export type TakeableVerification =
  | { status: "ok" }
  | { status: "unverifiable" }
  | { status: "lost"; warning: string };

const obsidianHttp: Http = async (url, headers) => {
  const res = await requestUrl({ url, headers, throw: false });
  return {
    status: res.status,
    headers: Object.fromEntries(
      Object.entries(res.headers).map(([key, value]) => [key.toLowerCase(), value]),
    ),
    json: res.json,
  };
};

const FULL_SYNC_MAX_AGE = 24 * 60 * 60 * 1000;

function sanitizeSettings(value: unknown): WayfinderSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  let interval = DEFAULT_SETTINGS.pollIntervalMinutes;
  try {
    const coerced = Number(raw.pollIntervalMinutes);
    if (Number.isFinite(coerced)) interval = Math.min(120, Math.max(0.5, coerced));
  } catch {
    // Keep the default for values that cannot be converted to a number.
  }
  return {
    token: typeof raw.token === "string" ? raw.token : DEFAULT_SETTINGS.token,
    repo: typeof raw.repo === "string" ? raw.repo : DEFAULT_SETTINGS.repo,
    pollIntervalMinutes: interval,
    copyTemplate:
      typeof raw.copyTemplate === "string" ? raw.copyTemplate : DEFAULT_SETTINGS.copyTemplate,
  };
}

export default class WayfinderPlugin extends Plugin {
  settings: WayfinderSettings = { ...DEFAULT_SETTINGS };
  snapshot: Snapshot | null = null;
  events = new Events();
  syncing = false;
  lastError: string | null = null;
  private pendingSync: boolean | null = null;
  private github = new GitHubClient(
    () => ({ token: this.settings.token, repo: this.settings.repo }),
    obsidianHttp,
  );

  fetchComments(issueNumber: number): Promise<IssueComment[]> {
    return this.github.comments(issueNumber);
  }

  testConnection(): Promise<string> {
    return this.github.testConnection();
  }

  /** Live-check an open, unclaimed ticket right before acting on it. */
  async verifyTakeable(issueNumber: number): Promise<TakeableVerification> {
    const snap = this.snapshot;
    const cached = snap?.issues.find((i) => i.number === issueNumber);
    if (!snap || !cached || cached.state !== "open" || cached.assignees.length > 0) {
      return { status: "ok" };
    }
    let fresh: RawIssue | null;
    try {
      fresh = await Promise.race([
        this.github.issue(issueNumber),
        new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 2000)),
      ]);
    } catch {
      return { status: "unverifiable" };
    }
    if (!fresh) {
      return { status: "unverifiable" };
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
      return { status: "lost", warning };
    }
    return { status: "ok" };
  }

  async guardedAction(issueNumber: number, action: () => void): Promise<void> {
    const result = await this.verifyTakeable(issueNumber);
    if (result.status === "ok") {
      action();
      return;
    }
    if (result.status === "lost") {
      new Notice(`⚠ ${result.warning}`, 6000);
      return;
    }

    const message = document.createDocumentFragment();
    message.appendText(`Couldn't verify #${issueNumber} is still takeable. `);
    const override = message.createEl("button", { text: "Copy anyway", cls: "wf-notice-btn" });
    let notice: Notice;
    override.addEventListener("click", () => {
      action();
      notice.hide();
    });
    notice = new Notice(message, 8000);
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
    this.settings = sanitizeSettings(data.settings);
    const loadedSnapshot = data.snapshot ?? null;
    this.snapshot =
      loadedSnapshot &&
      loadedSnapshot.schemaVersion === 2 &&
      loadedSnapshot.repo === this.settings.repo
        ? loadedSnapshot
        : null;

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
    if (this.syncing) {
      this.pendingSync = (this.pendingSync ?? false) || full;
      return;
    }
    this.syncing = true;
    this.events.trigger("wayfinder:updated");
    try {
      let requestedFull: boolean | null = full;
      while (requestedFull !== null) {
        this.pendingSync = null;
        await this.runSync(requestedFull);
        requestedFull = this.pendingSync;
      }
    } finally {
      this.syncing = false;
      this.events.trigger("wayfinder:updated");
    }
  }

  private async runSync(requestedFull: boolean): Promise<void> {
    const config = { token: this.settings.token, repo: this.settings.repo };
    if (!config.token || !config.repo.includes("/")) {
      this.lastError = "Set a GitHub token and repo in Settings → Wayfinder.";
      this.events.trigger("wayfinder:updated");
      return;
    }

    const prev = this.snapshot?.repo === config.repo ? this.snapshot : null;
    const full =
      requestedFull ||
      !prev?.lastFullSync ||
      Date.now() - prev.lastFullSync >= FULL_SYNC_MAX_AGE;
    const github = new GitHubClient(() => config, obsidianHttp);
    let warning: string | null = null;
    try {
      this.snapshot = await fetchSnapshot(github, prev, full, (message) => {
        warning = message;
      });
      this.lastError = warning;
      await this.persist();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      new Notice(`Wayfinder sync failed: ${this.lastError}`);
    }
    this.events.trigger("wayfinder:updated");
  }

  private settingsSyncTimer: number | null = null;

  /** Persist settings and, once edits settle, try a sync with the new values. */
  async saveSettings(): Promise<void> {
    const repoChanged = this.snapshot !== null && this.snapshot.repo !== this.settings.repo;
    if (repoChanged) this.snapshot = null;
    await this.persist();
    if (repoChanged) this.events.trigger("wayfinder:updated");
    this.events.trigger("wayfinder:settings");
    if (this.settingsSyncTimer !== null) window.clearTimeout(this.settingsSyncTimer);
    this.settingsSyncTimer = window.setTimeout(() => {
      this.settingsSyncTimer = null;
      if (this.settings.token && this.settings.repo.includes("/")) void this.sync(true);
    }, 800);
  }

  onunload(): void {
    if (this.settingsSyncTimer !== null) {
      window.clearTimeout(this.settingsSyncTimer);
      this.settingsSyncTimer = null;
    }
  }

  private async persist(): Promise<void> {
    const data: PersistedData = { settings: this.settings, snapshot: this.snapshot };
    await this.saveData(data);
  }
}
