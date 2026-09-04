#!/usr/bin/env bash
#
# Rebuild OASIS VISION after a git pull, a source edit, or a dependency change.
#
# The server is stopped first because it runs OUT OF .next/standalone, and a
# build that tries to replace a directory a live process is executing from fails
# (on Windows outright with EBUSY; on macOS it succeeds but leaves the old
# process serving stale code, which is worse because it looks fine).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/.."

echo "[1/4] Stopping any running OASIS VISION server..."
"$HERE/oasis-vision.sh" --stop || true

echo "[2/4] Installing dependencies..."
npm install

echo "[3/4] Building..."
npm run build

echo "[4/4] Syncing standalone assets..."
node launcher/sync-standalone.js

echo
echo "OASIS VISION rebuilt. Start it with:  launcher/oasis-vision.sh"
