#!/usr/bin/env bash
#
# Installs OASIS VISION as a real macOS application.
#
# Creates ~/Applications/OASIS VISION.app - a bundle whose executable is the
# launcher script - so it appears in Launchpad and Spotlight, gets its own Dock
# icon, and opens without a terminal. The equivalent of the Windows shortcut.
#
#   ./install-macos.sh
#
# Re-running is safe: it replaces the bundle in place.
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCHER="$APP_ROOT/launcher/oasis-vision.sh"
APP_DIR="$HOME/Applications/OASIS VISION.app"
ICON_SRC="$APP_ROOT/public/oasis-icon.png"

[ "$(uname)" = "Darwin" ] || { echo "This installer is for macOS. On Windows use launcher\\install-shortcuts.ps1." >&2; exit 1; }
[ -f "$LAUNCHER" ] || { echo "Launcher missing: $LAUNCHER" >&2; exit 1; }

chmod +x "$LAUNCHER" "$APP_ROOT/launcher/rebuild.sh" 2>/dev/null || true

if [ ! -f "$APP_ROOT/.next/standalone/server.js" ]; then
  echo "Not built yet - building first (this takes a couple of minutes)..."
  "$APP_ROOT/launcher/rebuild.sh"
fi

echo "Creating $APP_DIR ..."
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>OASIS VISION</string>
  <key>CFBundleDisplayName</key><string>OASIS VISION</string>
  <key>CFBundleIdentifier</key><string>work.oasisai.vision</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>oasis-vision</string>
  <key>CFBundleIconFile</key><string>oasis-vision</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <!-- No Dock tile for the launcher shell itself; the browser window is the UI. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

# The bundle executable is a stub so the .app keeps working after a git pull -
# it defers to the launcher in the repo rather than copying it.
cat > "$APP_DIR/Contents/MacOS/oasis-vision" <<STUB
#!/usr/bin/env bash
exec "$LAUNCHER"
STUB
chmod +x "$APP_DIR/Contents/MacOS/oasis-vision"

# Icon: macOS wants .icns. sips and iconutil ship with the OS.
if [ -f "$ICON_SRC" ] && command -v iconutil >/dev/null 2>&1; then
  ICONSET="$(mktemp -d)/oasis-vision.iconset"
  mkdir -p "$ICONSET"
  for SZ in 16 32 64 128 256 512; do
    sips -z $SZ $SZ "$ICON_SRC" --out "$ICONSET/icon_${SZ}x${SZ}.png" >/dev/null 2>&1 || true
    DBL=$((SZ * 2))
    sips -z $DBL $DBL "$ICON_SRC" --out "$ICONSET/icon_${SZ}x${SZ}@2x.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "$ICONSET" -o "$APP_DIR/Contents/Resources/oasis-vision.icns" 2>/dev/null \
    && echo "Icon built from public/oasis-icon.png" \
    || echo "Icon build skipped (iconutil failed) - the app still works."
  rm -rf "$(dirname "$ICONSET")"
fi

# Ask Finder to notice the new bundle rather than waiting for a rescan.
touch "$APP_DIR"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP_DIR" >/dev/null 2>&1 || true

echo
echo "Installed. Open it from Launchpad or Spotlight: OASIS VISION"
echo "Phone access on the same Wi-Fi:  launcher/oasis-vision.sh --lan"
