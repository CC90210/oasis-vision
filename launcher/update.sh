#!/usr/bin/env bash
#
# Update OASIS VISION from GitHub, rebuild it, and reopen it.
#
#   launcher/update.sh
#
# The installed app runs the BUILT copy in .next/standalone, so a `git pull`
# alone changes nothing you can see; this does the whole chain. It refuses to
# run over uncommitted work, untracked files included: an untracked file under
# src/ would be built into the app without ever having been reviewed or
# pushed. Ignored files (.env.local, logs, build output) do not count.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "Uncommitted work in $(pwd). Commit, stash or remove it, then run this again:" >&2
  git status --short >&2
  exit 1
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BEFORE="$(git rev-parse --short HEAD)"
echo "[update] $BRANCH at $BEFORE, pulling from origin..."
git pull --ff-only origin "$BRANCH"
echo "[update] $BRANCH now at $(git rev-parse --short HEAD)"

"$HERE/rebuild.sh"
"$HERE/oasis-vision.sh"
