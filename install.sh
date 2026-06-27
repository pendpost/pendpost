#!/bin/bash
# install.sh - install + start the pendpost launchd agent (SS-06).
# Idempotent: re-running replaces the agent with the current paths.
set -euo pipefail

# install.sh lives at the repo root here (it sat in a subdir in the original
# layout, hence the old "$PENDPOST_DIR/.." - which pointed one level above the repo).
PENDPOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$PENDPOST_DIR"
NODE_BIN="$(command -v node)"
PLIST_SRC="$PENDPOST_DIR/launchd/pendpost.plist"
PLIST_DST="$HOME/Library/LaunchAgents/pendpost.plist"
LABEL="pendpost"

if [ -z "$NODE_BIN" ]; then
  echo "[install] node not found on PATH" >&2
  exit 1
fi

if [ ! -d "$PENDPOST_DIR/app/dist" ]; then
  echo "[install] app/dist missing - building the dashboard once..."
  (cd "$PENDPOST_DIR/app" && npm run build)
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|__NODE__|$NODE_BIN|g" \
    -e "s|__REPO__|$REPO_ROOT|g" \
    -e "s|__HOME__|$HOME|g" \
    "$PLIST_SRC" > "$PLIST_DST"

launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"

# --- "pendpost.app" in /Applications ---
# Two app shells, both self-healing the agent on launch: (1) a NATIVE Swift
# WKWebView app when swiftc is available - a REAL app with its own Dock icon, menu
# bar, and Cmd-Tab entry that hosts the dashboard window; (2) otherwise the shell
# launcher that opens a Chrome app window (no native Dock presence). The bundle is
# assembled here (not committed prebuilt) so paths + icon stay current.
APP_DST="/Applications/pendpost.app"
# Prefer the full-res app icon when present; fall back to the committed web favicon.
ICON_SRC="$REPO_ROOT/brand/icons/icon-1024.png"
[ -f "$ICON_SRC" ] || ICON_SRC="$REPO_ROOT/web/public/apple-touch-icon.png"
mkdir -p "$APP_DST/Contents/MacOS" "$APP_DST/Contents/Resources"
if command -v swiftc >/dev/null 2>&1; then
  echo "[install] building native pendpost.app (Swift WKWebView)..."
  SWIFT_TMP="$(mktemp -d)"
  sed -e "s|__REPO__|$REPO_ROOT|g" "$PENDPOST_DIR/launcher/PendpostApp.swift" > "$SWIFT_TMP/PendpostApp.swift"
  if swiftc -O -framework Cocoa -framework WebKit -o "$APP_DST/Contents/MacOS/pendpost" "$SWIFT_TMP/PendpostApp.swift" 2>"$SWIFT_TMP/swiftc.log"; then
    cp "$PENDPOST_DIR/launcher/Info.native.plist" "$APP_DST/Contents/Info.plist"
    rm -f "$APP_DST/Contents/MacOS/launcher" # drop the old shell launcher if a prior install left one
    APP_KIND="native app (Dock + menu bar)"
  else
    cp "$SWIFT_TMP/swiftc.log" /tmp/pendpost-swiftc.log 2>/dev/null || true
    echo "[install] swiftc build failed (see /tmp/pendpost-swiftc.log); using the Chrome-app launcher instead." >&2
    sed -e "s|__REPO__|$REPO_ROOT|g" "$PENDPOST_DIR/launcher/launcher.sh" > "$APP_DST/Contents/MacOS/launcher"
    chmod +x "$APP_DST/Contents/MacOS/launcher"
    cp "$PENDPOST_DIR/launcher/Info.plist" "$APP_DST/Contents/Info.plist"
    rm -f "$APP_DST/Contents/MacOS/pendpost"
    APP_KIND="Chrome-app launcher"
  fi
  rm -rf "$SWIFT_TMP"
else
  sed -e "s|__REPO__|$REPO_ROOT|g" "$PENDPOST_DIR/launcher/launcher.sh" > "$APP_DST/Contents/MacOS/launcher"
  chmod +x "$APP_DST/Contents/MacOS/launcher"
  cp "$PENDPOST_DIR/launcher/Info.plist" "$APP_DST/Contents/Info.plist"
  APP_KIND="Chrome-app launcher (swiftc not found)"
fi
if [ -f "$ICON_SRC" ] && command -v iconutil >/dev/null 2>&1; then
  ICONSET="$(mktemp -d)/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1
    sips -z "$((s * 2))" "$((s * 2))" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "$ICONSET" -o "$APP_DST/Contents/Resources/AppIcon.icns" 2>/dev/null || true
fi
codesign --force -s - "$APP_DST" 2>/dev/null || true
touch "$APP_DST"
# Register the freshly-assembled bundle with LaunchServices AND force a Spotlight
# index, so it appears immediately in Spotlight / Launchpad with its icon. A bundle
# built file-by-file in place is not reliably picked up by the automatic fsevents
# path (unlike a finished bundle dragged into /Applications), so we nudge both.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
{ [ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$APP_DST"; } >/dev/null 2>&1 || true
{ command -v mdimport >/dev/null 2>&1 && mdimport "$APP_DST"; } >/dev/null 2>&1 || true
echo "[install] pendpost.app installed: $APP_DST - $APP_KIND (double-click / Spotlight 'pendpost')."

# --- "pendpost-notifier.app" in /Applications (approval-queue notification icon) ---
# macOS attributes a notification to the BUNDLE of the process that posts it, and
# AppleScript's `display notification` always posts as Script Editor (generic
# scroll icon). To make the approval-queue notification (lib/notify.mjs) carry the
# pendpost icon, we ship a pendpost-branded notifier: a re-iconed copy of
# terminal-notifier with our bundle id + AppIcon. notify.mjs prefers this bundle
# and falls back to plain osascript when it is absent, so this step is best-effort.
NOTIFIER_DST="/Applications/pendpost-notifier.app"
NOTIFIER_ICNS="$APP_DST/Contents/Resources/AppIcon.icns"
TN_APP=""
if command -v terminal-notifier >/dev/null 2>&1; then
  TN_BIN="$(command -v terminal-notifier)"
  # The .app sits two levels up from the wrapper bin (…/<ver>/terminal-notifier.app).
  TN_CANDIDATE="$(cd "$(dirname "$TN_BIN")/.." 2>/dev/null && pwd)/terminal-notifier.app"
  [ -d "$TN_CANDIDATE" ] && TN_APP="$TN_CANDIDATE"
  # Fallback: search the Homebrew Cellar if the layout differs.
  if [ -z "$TN_APP" ] && command -v brew >/dev/null 2>&1; then
    TN_APP="$(/usr/bin/find "$(brew --prefix)/Cellar/terminal-notifier" -maxdepth 2 -name terminal-notifier.app -type d 2>/dev/null | head -1)"
  fi
fi
if [ -n "$TN_APP" ] && [ -d "$TN_APP" ] && [ -f "$NOTIFIER_ICNS" ]; then
  rm -rf "$NOTIFIER_DST"
  cp -R "$TN_APP" "$NOTIFIER_DST"
  PB=/usr/libexec/PlistBuddy
  NPLIST="$NOTIFIER_DST/Contents/Info.plist"
  "$PB" -c "Set :CFBundleIdentifier pendpost.notifier" "$NPLIST" 2>/dev/null || true
  "$PB" -c "Set :CFBundleName pendpost" "$NPLIST" 2>/dev/null || true
  "$PB" -c "Set :CFBundleDisplayName pendpost" "$NPLIST" 2>/dev/null \
    || "$PB" -c "Add :CFBundleDisplayName string pendpost" "$NPLIST" 2>/dev/null || true
  NICONKEY="$("$PB" -c "Print :CFBundleIconFile" "$NPLIST" 2>/dev/null)"
  [ -n "$NICONKEY" ] && cp "$NOTIFIER_ICNS" "$NOTIFIER_DST/Contents/Resources/${NICONKEY%.icns}.icns"
  codesign --force --deep -s - "$NOTIFIER_DST" 2>/dev/null || true
  { [ -x "$LSREGISTER" ] && "$LSREGISTER" -f "$NOTIFIER_DST"; } >/dev/null 2>&1 || true
  echo "[install] pendpost-notifier.app installed: notifications will carry the pendpost icon."
else
  echo "[install] note: terminal-notifier not found - approval notifications use the generic macOS icon."
  echo "[install]       install it (brew install terminal-notifier) and re-run for the pendpost icon."
fi

echo "[install] $LABEL installed and started (RunAtLoad; KeepAlive restarts on crash, stops on clean exit)."

# Wait for the agent to bind before announcing the URL (bounded ~6s, the same
# poll pattern launcher/launcher.sh uses to self-heal). Port matches the plist /
# server default (8090); PENDPOST_HOST stays 127.0.0.1 for this local tool.
PENDPOST_PORT="${PENDPOST_PORT:-8090}"
for _ in $(seq 1 24); do
  if curl -s -m 1 "http://127.0.0.1:${PENDPOST_PORT}/api/health" >/dev/null 2>&1; then
    echo "[install] Dashboard ready at http://127.0.0.1:${PENDPOST_PORT}"
    break
  fi
  sleep 0.25
done

echo "[install] health:  curl -s http://127.0.0.1:8090/api/health"
echo "[install] logs:    tail -f \$HOME/Library/Logs/pendpost-out.log"
echo "[install] restart: launchctl kickstart -k gui/\$(id -u)/$LABEL"
echo "[install] remove:  launchctl bootout gui/\$(id -u) $PLIST_DST && rm $PLIST_DST"
