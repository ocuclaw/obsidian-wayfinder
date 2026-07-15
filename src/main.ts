import { Events, Notice, Plugin, WorkspaceLeaf, requestUrl } from "obsidian";
import { GitHubClient, fetchSnapshot, type Http } from "./github";
import type { Snapshot } from "./model";
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

  async saveSettings(): Promise<void> {
    await this.persist();
  }

  private async persist(): Promise<void> {
    const data: PersistedData = { settings: this.settings, snapshot: this.snapshot };
    await this.saveData(data);
  }
}
