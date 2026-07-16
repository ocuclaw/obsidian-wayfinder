import { Events, Notice, Plugin, WorkspaceLeaf, requestUrl } from "obsidian";
import {
  DEFAULT_SETTINGS,
  isValidRepoConfig,
  sanitizeSettings,
  type RepoConfig,
  type WayfinderSettings,
} from "./config";
import { GitHubClient, fetchSnapshot, type Http, type IssueComment } from "./github";
import { buildModel, type RawIssue, type Snapshot } from "./model";
import { WayfinderSettingTab } from "./settings";
import { VIEW_TYPE_WAYFINDER, WayfinderView } from "./view";

interface PersistedData {
  settings: WayfinderSettings;
  snapshots: Record<string, Snapshot>;
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

export default class WayfinderPlugin extends Plugin {
  settings: WayfinderSettings = { ...DEFAULT_SETTINGS, repos: [] };
  snapshots: Record<string, Snapshot> = {};
  events = new Events();
  syncing = false;
  errors: Record<string, string> = {};
  configError: string | null = null;
  private pendingSync: boolean | null = null;

  // Async so a missing repo config rejects instead of throwing into the caller.
  async fetchComments(repo: string, issueNumber: number): Promise<IssueComment[]> {
    return this.clientForRepo(repo).comments(issueNumber);
  }

  testConnection(config: RepoConfig): Promise<string> {
    return this.createClient(config).testConnection();
  }

  /** Live-check an open, unclaimed ticket right before acting on it. */
  async verifyTakeable(repo: string, issueNumber: number): Promise<TakeableVerification> {
    const snap = this.snapshots[repo];
    const cached = snap?.issues.find((i) => i.number === issueNumber);
    if (!snap || !cached || cached.state !== "open" || cached.assignees.length > 0) {
      return { status: "ok" };
    }
    let fresh: RawIssue | null;
    try {
      fresh = await Promise.race([
        this.clientForRepo(repo).issue(issueNumber),
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

  async guardedAction(
    repo: string,
    issueNumber: number,
    action: () => void,
    overrideLabel = "Copy anyway",
  ): Promise<void> {
    const result = await this.verifyTakeable(repo, issueNumber);
    if (result.status === "ok") {
      action();
      return;
    }
    if (result.status === "lost") {
      new Notice(`⚠ ${result.warning}`, 6000);
      return;
    }

    const message = createFragment();
    message.appendText(`Couldn't verify #${issueNumber} is still takeable. `);
    const override = message.createEl("button", { text: overrideLabel, cls: "wf-notice-btn" });
    let notice: Notice;
    override.addEventListener("click", () => {
      action();
      notice.hide();
    });
    notice = new Notice(message, 8000);
  }

  /** Copy the /wayfinder command for the newest frontier ticket. */
  copyNextTakeable(): void {
    if (!this.settings.repos.some((config) => this.snapshots[config.repo])) {
      new Notice("Wayfinder: no data yet — open the view to sync first.");
      return;
    }
    for (const config of this.settings.repos) {
      const snapshot = this.snapshots[config.repo];
      if (!snapshot) continue;
      const frontier = buildModel(snapshot).maps.flatMap((map) =>
        map.tickets.filter((ticket) => ticket.frontier),
      );
      if (frontier.length === 0) continue;
      const pick = frontier.reduce((newest, ticket) =>
        ticket.issue.number > newest.issue.number ? ticket : newest,
      );
      void this.guardedAction(config.repo, pick.issue.number, () => {
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
    const data = ((await this.loadData()) ?? {}) as Partial<PersistedData> & {
      snapshot?: Snapshot | null;
    };
    this.settings = sanitizeSettings(data.settings);
    const configured = new Set(this.settings.repos.map((config) => config.repo));
    const loaded: Record<string, unknown> =
      data.snapshots && typeof data.snapshots === "object" ? { ...data.snapshots } : {};
    if (data.snapshot && !loaded[data.snapshot.repo]) loaded[data.snapshot.repo] = data.snapshot;
    this.snapshots = Object.fromEntries(
      Object.entries(loaded).filter(
        ([repo, snapshot]) =>
          configured.has(repo) &&
          !!snapshot &&
          typeof snapshot === "object" &&
          (snapshot as Snapshot).schemaVersion === 2 &&
          (snapshot as Snapshot).repo === repo,
      ),
    ) as Record<string, Snapshot>;

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
    if (leaf) await this.app.workspace.revealLeaf(leaf);
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
    const configured = new Set(this.settings.repos.map((config) => config.repo));
    for (const repo of Object.keys(this.snapshots)) {
      if (!configured.has(repo)) delete this.snapshots[repo];
    }
    for (const repo of Object.keys(this.errors)) {
      if (!configured.has(repo)) delete this.errors[repo];
    }

    // First entry wins when the same repo is configured twice — one fetch, one token.
    const seen = new Set<string>();
    const configs = this.settings.repos.filter(
      (config) => isValidRepoConfig(config) && !seen.has(config.repo) && seen.add(config.repo),
    );
    if (configs.length === 0) {
      this.configError = "Add a GitHub repo and token in Settings → Wayfinder.";
      await this.persist();
      this.events.trigger("wayfinder:updated");
      return;
    }
    this.configError = null;

    const failures = (
      await Promise.all(
        configs.map(async (config) => {
          const prev = this.snapshots[config.repo]?.repo === config.repo
            ? this.snapshots[config.repo]
            : null;
          const full =
            requestedFull ||
            !prev?.lastFullSync ||
            Date.now() - prev.lastFullSync >= FULL_SYNC_MAX_AGE;
          let warning: string | null = null;
          try {
            this.snapshots[config.repo] = await fetchSnapshot(
              this.createClient(config),
              prev,
              full,
              (message) => {
                warning = message;
              },
            );
            if (warning) this.errors[config.repo] = warning;
            else delete this.errors[config.repo];
            return null;
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            this.errors[config.repo] = message;
            return `${config.repo}: ${message}`;
          }
        }),
      )
    ).filter((failure): failure is string => failure !== null);
    await this.persist();
    if (failures.length > 0) {
      new Notice(`Wayfinder sync failed: ${failures.join(" · ")}`);
    }
    this.events.trigger("wayfinder:updated");
  }

  private settingsSyncTimer: number | null = null;

  /** Persist settings and, once edits settle, try a sync with the new values. */
  async saveSettings(): Promise<void> {
    await this.persist();
    this.events.trigger("wayfinder:settings");
    if (this.settingsSyncTimer !== null) window.clearTimeout(this.settingsSyncTimer);
    this.settingsSyncTimer = window.setTimeout(() => {
      this.settingsSyncTimer = null;
      if (this.settings.repos.some(isValidRepoConfig)) void this.sync(true);
    }, 800);
  }

  onunload(): void {
    if (this.settingsSyncTimer !== null) {
      window.clearTimeout(this.settingsSyncTimer);
      this.settingsSyncTimer = null;
    }
  }

  private createClient(config: RepoConfig): GitHubClient {
    return new GitHubClient(() => config, obsidianHttp);
  }

  private clientForRepo(repo: string): GitHubClient {
    const config = this.settings.repos.find((entry) => entry.repo === repo);
    if (!config) throw new Error(`Repository is no longer configured: ${repo}`);
    return this.createClient(config);
  }

  private async persist(): Promise<void> {
    const data: PersistedData = { settings: this.settings, snapshots: this.snapshots };
    await this.saveData(data);
  }
}
