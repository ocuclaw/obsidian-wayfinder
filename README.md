# Wayfinder for Obsidian

Visualizes [wayfinder](https://github.com/mattpocock/skills) maps from a GitHub repo's issues inside Obsidian: each `wayfinder:map` issue renders as a head card with its tickets arranged in a **dependency-layered tree** below it, drawn from GitHub's native issue-dependency (blocked-by) edges.

![type colors follow GitHub's label hues]

## What it shows

- **Global tally bar** — open/total chips per `wayfinder:*` type, plus takeable, need-you, agent-ready, and either delegation chips, last-sync time, refresh, view-mode, fold, and zoom controls.
- **Maps stacked** — open maps expanded (newest first), completed maps collapsed with a final progress bar. Click/tap a map header to expand or collapse it; ⓘ opens its details.
- **Tree + list modes** — dependency-layered trees draw the actual blocker routes; compact lists group tickets by actionability. List is the mobile default, and the choice is stored per device.
- **Ticket state** — the **frontier** (open + verified unblocked + unassigned) glows with a FRONTIER flag; blocked tickets are dashed with a 🔒 naming open blockers; resolved tickets are dimmed with strikethrough.
- **Type + mode badges** — the `wayfinder:*` label colors each card; AFK/HITL is derived per the wayfinder skill (research→AFK, prototype/grilling→HITL, task→`ready-for-agent`/`ready-for-human` labels, else "either").
- **Orphan warnings** — `wayfinder:*` tickets whose "Part of #N" parent is missing or isn't a map get flagged instead of silently vanishing.
- **Ticket details + actions** — click/tap a ticket for a modal with its rendered Markdown description, linked blockers, assignee, live-fetched comments, and Copy `/wayfinder` / Open-on-GitHub buttons. The ⧉ on every card copies immediately; on takeable tickets it first checks for a new claim or resolution and replaces the action with a warning when necessary. ↗ opens GitHub.
- **Per-device zoom** — use the toolbar, Ctrl/Cmd+wheel, or pinch; the zoom level is stored locally per device.

## Setup

1. Copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/wayfinder/` (or run `npm run deploy`), then enable **Wayfinder** in Settings → Community plugins.
2. Create a **fine-grained personal access token** (github.com → Settings → Developer settings → Fine-grained tokens) scoped to your repo with read-only **Issues** permission.
3. Paste it in Settings → Wayfinder, set the repo (`owner/name`), and open the view via the compass ribbon icon or the "Open Wayfinder view" command.

The view syncs when opened, re-polls every 2 minutes (configurable) while open, and syncs on window focus when stale. Commands cover **Open Wayfinder view**, **Sync now**, and **Copy /wayfinder for the next takeable ticket**. The manual refresh button forces a full relationship re-fetch. The token is stored in plain text in the vault's plugin `data.json`.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # typecheck + production build
npm run deploy   # build + copy into the vault (VAULT=… to override)
GH_TOKEN=$(gh auth token) npm run smoke   # run the data pipeline against the live repo
```
