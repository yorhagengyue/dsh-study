#!/bin/sh
set -eu
APP_SOURCE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ] || [ "$("$NODE_BIN" -p '(()=>{const [a,b]=process.versions.node.split(".").map(Number);return a>22||(a===22&&b>=16)})()')" != true ]; then
  VERSION=v24.15.0
  ARCH=$(uname -m)
  case "$ARCH" in arm64) ARCH=arm64;; x86_64) ARCH=x64;; *) echo 'Unsupported architecture'; exit 1;; esac
  NAME="node-$VERSION-darwin-$ARCH"
  DEST="$HOME/Library/Application Support/DSH-Study/node"
  mkdir -p "$DEST"
  curl -fSL "https://nodejs.org/dist/$VERSION/$NAME.tar.gz" -o "$DEST/$NAME.tar.gz"
  curl -fSL "https://nodejs.org/dist/$VERSION/SHASUMS256.txt" -o "$DEST/SHASUMS256.txt"
  (cd "$DEST" && awk -v f="$NAME.tar.gz" '$2==f' SHASUMS256.txt > selected-sha.txt && test -s selected-sha.txt && shasum -a 256 -c selected-sha.txt)
  tar -xzf "$DEST/$NAME.tar.gz" -C "$DEST"
  NODE_BIN="$DEST/$NAME/bin/node"
fi
"$NODE_BIN" "$APP_SOURCE/app/install.mjs" --framework
CONFIG="$HOME/.codex/skills/dsh-dialogue/connection.local.json"
"$NODE_BIN" "$APP_SOURCE/app/setup-key.mjs" "$CONFIG"
exec "$NODE_BIN" "$APP_SOURCE/app/launch.mjs" --config "$CONFIG" --restart-owned
