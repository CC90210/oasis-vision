#!/usr/bin/env bash
#
# OASIS VISION launcher for macOS and Linux.
#
# Mirrors launcher/osiris-launch.ps1: starts the standalone Next.js server bound
# to loopback and opens a chromeless application window. Safe to run twice - if
# the server is already up it just re-opens the window.
#
#   ./oasis-vision.sh            start and open the app window
#   ./oasis-vision.sh --no-window  server only
#   ./oasis-vision.sh --lan      expose on the local network (phone access)
#   ./oasis-vision.sh --stop     stop the server
#
set -euo pipefail

PORT="${OASIS_PORT:-3177}"
APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="$APP_ROOT/.next/standalone/server.js"
LOG_DIR="$APP_ROOT/launcher/logs"
PID_FILE="$LOG_DIR/oasis-vision.pid"

OPEN_WINDOW=1
BIND="127.0.0.1"
ACTION="start"

for arg in "$@"; do
  case "$arg" in
    --no-window) OPEN_WINDOW=0 ;;
    # Off by default: this dashboard proxies arbitrary external URLs and runs a
    # recon toolkit. It should not be reachable from the network unless asked.
    --lan)       BIND="0.0.0.0" ;;
    --stop)      ACTION="stop" ;;
    -h|--help)   sed -n '3,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Opened from Launchpad, Spotlight or the Dock there is no terminal attached, so
# a message on stderr goes nowhere at all: the icon bounced once, the app quit,
# and the operator was left with no clue what happened. Anything fatal gets a
# real dialog in that case.
# \n inside a message stays a two-character escape so the same string serves both
# outputs - printf %b renders it in a terminal, and AppleScript understands \n
# inside a string literal.
die() {
  printf '%b\n' "$1" >&2
  if [ ! -t 1 ] && command -v osascript >/dev/null 2>&1; then
    local msg
    # Double quotes are swapped for single ones rather than escaped: this text is
    # interpolated into an AppleScript string literal, where one stray quote turns
    # the explanatory dialog into a syntax error - i.e. back into the silent
    # failure this whole function exists to end.
    msg=$(printf '%s' "$1" | tr '"' "'")
    osascript -e "display dialog \"$msg\" with title \"OASIS VISION\" buttons {\"OK\"} default button \"OK\" with icon stop" >/dev/null 2>&1 || true
  fi
  exit 1
}

NODE_BIN=""
resolve_node() {
  # THE BUG THIS FIXES: macOS hands a .app launched from Launchpad/Spotlight/the
  # Dock the LaunchServices PATH - /usr/bin:/bin:/usr/sbin:/sbin - and runs no
  # login shell, so nothing ever adds Homebrew's /opt/homebrew/bin (Apple
  # silicon) or /usr/local/bin (Intel). A bare `node` was therefore not found and
  # the app died instantly and silently. It worked from Terminal, where the
  # user's profile has already fixed the PATH, which is why the installer's
  # "Installed" line read as success on a machine where the icon did nothing.
  # Every other command here (curl, lsof, nohup, date, seq, awk, open, osascript)
  # does live in that minimal PATH - node was the only casualty.
  PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  local c
  for c in "${OASIS_NODE:-}" "$(command -v node 2>/dev/null || true)" \
           /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node /opt/local/bin/node
  do
    if [ -n "$c" ] && [ -x "$c" ]; then NODE_BIN="$c"; return 0; fi
  done

  # nvm keeps every install under a version directory and is activated by a shell
  # function, so none of it is ever on a GUI-launched PATH. `nvm alias default`
  # records which version a terminal would have picked.
  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  [ -d "$nvm_dir/versions/node" ] || return 1
  local want="" cand=""
  [ -f "$nvm_dir/alias/default" ] && want="$(tr -d ' \t\r\n' < "$nvm_dir/alias/default" 2>/dev/null || true)"
  case "$want" in
    v[0-9]*) cand="$nvm_dir/versions/node/$want/bin/node" ;;
    [0-9]*)  cand="$nvm_dir/versions/node/v$want/bin/node" ;;
    *)       cand="" ;;   # an alias like lts/* needs nvm itself to resolve
  esac
  if [ -n "$cand" ] && [ -x "$cand" ]; then NODE_BIN="$cand"; return 0; fi
  # No usable alias: take the highest installed version. Sorted by zero-padded
  # numeric fields because BSD sort (what macOS ships) has no dependable -V.
  local newest
  newest="$(ls -1 "$nvm_dir/versions/node" 2>/dev/null \
    | sed 's/^v//' \
    | awk -F. 'NF==3{printf "%05d%05d%05d %s\n",$1,$2,$3,$0}' \
    | sort | tail -1 | awk '{print $2}')"
  if [ -n "$newest" ] && [ -x "$nvm_dir/versions/node/v$newest/bin/node" ]; then
    NODE_BIN="$nvm_dir/versions/node/v$newest/bin/node"
    return 0
  fi
  return 1
}

is_up() { curl -fsS -m 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; }

stop_server() {
  # Only ever kill the process actually listening on our port, never a stray node.
  local pid=""
  if command -v lsof >/dev/null 2>&1; then
    pid="$(lsof -ti tcp:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  fi
  if [ -z "$pid" ] && [ -f "$PID_FILE" ]; then pid="$(cat "$PID_FILE")"; fi
  if [ -n "$pid" ]; then
    echo "Stopping OASIS VISION (PID $pid)..."
    kill "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
  else
    echo "OASIS VISION is not running on port $PORT."
  fi
}

if [ "$ACTION" = "stop" ]; then stop_server; exit 0; fi

resolve_node || die "OASIS VISION cannot start: Node.js was not found.\n\nInstall it:  brew install node\n\nIf node is already installed somewhere unusual, point the launcher at it:\n  OASIS_NODE=/full/path/to/node launcher/oasis-vision.sh\n\nLooked in: PATH, /opt/homebrew/bin, /usr/local/bin, /usr/bin, /opt/local/bin, and the nvm default."

if [ ! -f "$SERVER" ]; then
  die "OASIS VISION is not built yet.\n\nRun:  launcher/rebuild.sh"
fi

# server.js on its own is NOT a runnable build. Next's standalone output
# deliberately leaves out public/ and .next/static; launcher/sync-standalone.js
# copies them in. A build where that step never ran still starts, still answers
# /api/health, and so still printed "OASIS VISION is live" - while serving a page
# whose every stylesheet, JS chunk and icon 404s. That reads as a broken app
# rather than an unfinished build, so gate on the assets too.
if [ ! -d "$APP_ROOT/.next/standalone/.next/static" ] || [ ! -d "$APP_ROOT/.next/standalone/public" ]; then
  die "OASIS VISION is built but incomplete: the static assets were never copied into .next/standalone, so the page would load with no styling, no scripts and no icons.\n\nRun:  node launcher/sync-standalone.js\n(or launcher/rebuild.sh to redo the whole build)"
fi

mkdir -p "$LOG_DIR"

if is_up; then
  echo "OASIS VISION already running on http://127.0.0.1:$PORT"
else
  echo "Starting OASIS VISION on port $PORT (bind $BIND)..."
  ( cd "$(dirname "$SERVER")" \
    && PORT="$PORT" HOSTNAME="$BIND" NODE_ENV=production \
       nohup "$NODE_BIN" "$SERVER" >"$LOG_DIR/oasis-vision-$(date +%F).log" 2>&1 &
    echo $! > "$PID_FILE" )

  for _ in $(seq 1 45); do
    sleep 0.7
    if is_up; then break; fi
  done
  if ! is_up; then
    echo "Server did not come up in 30s. Check $LOG_DIR/." >&2
    exit 1
  fi
  echo "OASIS VISION is live."
fi

if [ "$BIND" = "0.0.0.0" ]; then
  # Prefer a real RFC1918 address; en0 on a Mac is usually Wi-Fi.
  LAN_IP="$( (ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}') || true)"
  echo ""
  if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
    # Parsed with node, not sed. `tailscale status --json` is a single line
    # listing every peer, so a greedy regex for "DNSName" returns the LAST
    # peer's hostname rather than this machine's — it printed another device's
    # address and would have sent the phone to the wrong node.
    #
    # "$NODE_BIN", not a bare `node` — same reason resolve_node exists. Launched
    # from the Dock there is no Homebrew on PATH, so a bare `node` here fails,
    # and because the pipeline ends in `|| true` it fails SILENTLY: the Tailscale
    # address is simply never printed and the operator concludes Tailscale is
    # not set up.
    TS_HOST="$(tailscale status --json 2>/dev/null \
      | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(j.BackendState==="Running"&&j.Self&&j.Self.DNSName)process.stdout.write(j.Self.DNSName.replace(/\.$/,""))}catch(e){}})' 2>/dev/null || true)"
    if [ -n "$TS_HOST" ]; then
      echo "  BEST - from anywhere over Tailscale (HTTPS, private to your devices):"
      echo "    https://$TS_HOST     (run once: tailscale serve --bg $PORT)"
      echo ""
    fi
  fi
  [ -n "${LAN_IP:-}" ] && echo "  Same Wi-Fi only (plain HTTP):  http://$LAN_IP:$PORT"
  # Safari withholds geolocation on an insecure origin, so HTTP can never be
  # the phone answer for a mapping tool.
  echo "  Note: on plain HTTP, Safari will not give the page your GPS."
  echo ""
fi

[ "$OPEN_WINDOW" -eq 1 ] || exit 0

URL="http://127.0.0.1:$PORT"
PROFILE="$APP_ROOT/launcher/.appwindow"

# Chromeless app window, so it gets its own Dock icon instead of a browser tab.
for BROWSER in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
do
  if [ -x "$BROWSER" ]; then
    "$BROWSER" --app="$URL" --user-data-dir="$PROFILE" --window-size=1600,950 \
      --disable-features=Translate,AutofillServerCommunication >/dev/null 2>&1 &
    exit 0
  fi
done

# Safari has no app mode; fall back to the default browser.
if command -v open >/dev/null 2>&1; then open "$URL"; else xdg-open "$URL" 2>/dev/null || true; fi
