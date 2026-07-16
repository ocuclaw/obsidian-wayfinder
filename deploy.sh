#!/usr/bin/env bash
# Deploy the built plugin into the Obsidian vault.
# Set VAULT in the environment or in a git-ignored deploy.env next to this script.
set -euo pipefail
cd "$(dirname "$0")"
if [ -z "${VAULT:-}" ] && [ -f deploy.env ]; then source deploy.env; fi
VAULT="${VAULT:?Set VAULT to your vault path (env var or deploy.env)}"
DEST="$VAULT/.obsidian/plugins/wayfinder"
mkdir -p "$DEST"
cp main.js manifest.json styles.css "$DEST/"
touch "$DEST/.hotreload"
echo "Deployed to $DEST"
