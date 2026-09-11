#!/usr/bin/env bash
# Sync adapters/hermes/ into the installed Hermes plugin dir and verify parity.
# Kills stale bytecode on upgrades -- rsync's --exclude protects the old
# __pycache__ from --delete, so it is removed by hand (see README, Hermes
# adapter install).
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
dest="${HERMES_PLUGIN_DIR:-$HOME/.hermes/plugins/deep-horizon}"

mkdir -p "$dest"
rsync -a --delete --exclude __pycache__ "$repo/adapters/hermes/" "$dest/"
rm -rf "$dest/__pycache__"

if diff -r --exclude=__pycache__ "$repo/adapters/hermes" "$dest" >/dev/null; then
  echo "OK: $dest matches adapters/hermes"
else
  echo "SYNC FAILED: $dest differs from adapters/hermes" >&2
  exit 1
fi
