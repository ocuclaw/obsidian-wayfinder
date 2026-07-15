#!/usr/bin/env bash
# Deploy the built plugin into the Obsidian vault.
set -euo pipefail
VAULT="${VAULT:-/home/matty/mattvault}"
DEST="$VAULT/.obsidian/plugins/wayfinder"
mkdir -p "$DEST"
cp main.js manifest.json styles.css "$DEST/"
touch "$DEST/.hotreload"
echo "Deployed to $DEST"
