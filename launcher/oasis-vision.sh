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

if [ ! -f "$SERVER" ]; then
  echo "OASIS VISION is not built yet. Run:  launcher/rebuild.sh" >&2
  exit 1
fi

mkdir -p "$LOG_DIR"

if is_up; then
  echo "OASIS VISION already running on http://127.0.0.1:$PORT"
else
  echo "Starting OASIS VISION on port $PORT (bind $BIND)..."
  ( cd "$(dirname "$SERVER")" \
    && PORT="$PORT" HOSTNAME="$BIND" NODE_ENV=production \
       nohup node "$SERVER" >"$LOG_DIR/oasis-vision-$(date +%F).log" 2>&1 &
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
    TS_HOST="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1 || true)"
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
