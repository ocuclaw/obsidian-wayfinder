import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type WayfinderPlugin from "./main";

export interface WayfinderSettings {
  token: string;
  repo: string;
  pollIntervalMinutes: number;
  copyTemplate: string;
}

export const DEFAULT_SETTINGS: WayfinderSettings = {
  token: "",
  repo: "OcuClawhub/evenclaw",
  pollIntervalMinutes: 2,
  copyTemplate: "/wayfinder {url}",
};

export class WayfinderSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: WayfinderPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("GitHub token")
      .setDesc(
        "Fine-grained personal access token with read-only Issues permission for the repo. " +
          "Create one at github.com → Settings → Developer settings → Fine-grained tokens. " +
          "Stored in plain text in this vault's plugin data.",
      )
      .addText((text) => {
        text
          .setPlaceholder("github_pat_…")
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
        text.inputEl.style.width = "100%";
      });

    new Setting(containerEl)
      .setName("Repository")
      .setDesc("owner/name of the repo holding the wayfinder maps.")
      .addText((text) =>
        text
          .setPlaceholder("owner/name")
          .setValue(this.plugin.settings.repo)
          .onChange(async (value) => {
            this.plugin.settings.repo = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Check that the token can access this repository.")
      .addButton((button) =>
        button.setButtonText("Test connection").onClick(async () => {
          try {
            const fullName = await this.plugin.testConnection();
            new Notice(`Connected: ${fullName} — issues readable`);
          } catch (e) {
            new Notice(e instanceof Error ? e.message : String(e));
          }
        }),
      );

    new Setting(containerEl)
      .setName("Sync interval (minutes)")
      .setDesc("How often the view re-syncs while it is open. Manual refresh is always available.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.pollIntervalMinutes)).onChange(async (value) => {
          const n = Number(value);
          if (Number.isFinite(n)) {
            this.plugin.settings.pollIntervalMinutes = Math.min(120, Math.max(0.5, n));
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Copy template")
      .setDesc("What clicking a ticket copies. {url} is replaced with the issue URL.")
      .addText((text) =>
        text.setValue(this.plugin.settings.copyTemplate).onChange(async (value) => {
          this.plugin.settings.copyTemplate = value || DEFAULT_SETTINGS.copyTemplate;
          await this.plugin.saveSettings();
        }),
      );
  }
}
