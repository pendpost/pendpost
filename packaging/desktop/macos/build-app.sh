#!/bin/bash
# packaging/desktop/macos/build-app.sh - assemble pendpost.app (CERT-FREE).
#
# Takes a runtime bundle (from build-bundle.mjs) and produces an unsigned
# pendpost.app: compiles the launcher as a UNIVERSAL binary (Intel + Apple
# Silicon), drops in the runtime + icon + Info.plist. Signing, notarization, and
# the .dmg happen afterwards in .github/workflows/release-desktop.yml - this script
# needs no certificates, so it runs locally on any Mac for testing.
#
# Usage: build-app.sh <runtime-dir> <out-app-path> [version]
#   runtime-dir : the <out>/runtime dir produced by build-bundle.mjs
#   out-app-path: where to write the .app (e.g. build/pendpost.app)
set -euo pipefail

RUNTIME="${1:?usage: build-app.sh <runtime-dir> <out-app-path> [version]}"
APP="${2:?usage: build-app.sh <runtime-dir> <out-app-path> [version]}"
VERSION="${3:-1.0.0}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"

if [ ! -d "$RUNTIME" ]; then echo "[build-app] runtime dir not found: $RUNTIME" >&2; exit 1; fi

echo "[build-app] assembling $APP (version $VERSION)"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 1. Info.plist (substitute the version).
sed -e "s|__VERSION__|$VERSION|g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"

# 2. Compile the launcher UNIVERSAL (arm64 + x86_64), then lipo into one binary so
#    a single .dmg runs on Apple Silicon and Intel.
TMP="$(mktemp -d)"
swiftc -O -target arm64-apple-macos12.0  -framework Cocoa -framework WebKit -o "$TMP/pendpost-arm64" "$HERE/PendpostApp.swift"
swiftc -O -target x86_64-apple-macos12.0 -framework Cocoa -framework WebKit -o "$TMP/pendpost-x64"   "$HERE/PendpostApp.swift"
lipo -create "$TMP/pendpost-arm64" "$TMP/pendpost-x64" -output "$APP/Contents/MacOS/pendpost"
chmod +x "$APP/Contents/MacOS/pendpost"
rm -rf "$TMP"

# 3. The runtime bundle (pendpost file set + universal node) -> Resources/runtime.
cp -R "$RUNTIME" "$APP/Contents/Resources/runtime"

# 4. App icon from the brand source (the install.sh iconutil recipe).
ICON_SRC="$REPO_ROOT/brand/icons/icon-1024.png"
[ -f "$ICON_SRC" ] || ICON_SRC="$REPO_ROOT/web/public/apple-touch-icon.png"
if [ -f "$ICON_SRC" ] && command -v iconutil >/dev/null 2>&1; then
  ICONSET="$(mktemp -d)/AppIcon.iconset"; mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z "$((s * 2))" "$((s * 2))" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
  rm -rf "$(dirname "$ICONSET")"
else
  echo "[build-app] warning: no icon source or iconutil; app ships without a custom icon." >&2
fi

echo "[build-app] done: $APP"
