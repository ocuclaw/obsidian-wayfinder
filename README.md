# Wayfinder for Obsidian

Visualizes [wayfinder](https://github.com/mattpocock/skills) maps from a GitHub repo's issues inside Obsidian: each `wayfinder:map` issue renders as a head card with its tickets arranged in a **dependency-layered tree** below it, drawn from GitHub's native issue-dependency (blocked-by) edges.

![type colors follow GitHub's label hues]

## What it shows

- **Global tally bar** — open/total counts per `wayfinder:*` type across every issue in the repo, plus last-sync time and a manual refresh button.
- **Maps stacked** — open maps expanded (newest first), completed maps collapsed to their header card with a final progress bar; click the chevron to expand.
- **Layered trees** — tickets sink below whatever blocks them, with SVG edges drawing the actual routes. The **frontier** (open + unblocked + unassigned — what's takeable right now) glows with a FRONTIER flag; blocked tickets are dashed with a 🔒 naming their open blockers; resolved tickets are dimmed with strikethrough.
- **Type + mode badges** — the `wayfinder:*` label colors each card; AFK/HITL is derived per the wayfinder skill (research→AFK, prototype/grilling→HITL, task→`ready-for-agent`/`ready-for-human` labels, else "either").
- **Orphan warnings** — `wayfinder:*` tickets whose "Part of #N" parent is missing or isn't a map get flagged instead of silently vanishing.
- **Hover** a card for the description, blockers, assignee, and last update. **Click** a card to copy `/wayfinder <issue url>` (template configurable). The ↗ icon opens the issue on GitHub.

## Setup

1. Copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/wayfinder/` (or run `npm run deploy`), then enable **Wayfinder** in Settings → Community plugins.
2. Create a **fine-grained personal access token** (github.com → Settings → Developer settings → Fine-grained tokens) scoped to your repo with read-only **Issues** permission.
3. Paste it in Settings → Wayfinder, set the repo (`owner/name`), and open the view via the compass ribbon icon or the "Open Wayfinder view" command.

The view syncs when opened and re-polls every 2 minutes (configurable) while open. The manual refresh button forces a full re-fetch of dependency edges. Note the token is stored in plain text in the vault's plugin `data.json`.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # typecheck + production build
npm run deploy   # build + copy into the vault (VAULT=… to override)
GH_TOKEN=$(gh auth token) npm run smoke   # run the data pipeline against the live repo
```
