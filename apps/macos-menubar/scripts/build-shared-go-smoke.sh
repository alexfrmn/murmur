#!/bin/bash
set -euo pipefail
# Reproduce the bounded portability experiment without editing the Windows lane.
APP_ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
REPO_ROOT="$(cd -- "$APP_ROOT/../.." && pwd)"
UPSTREAM=a9dcb7200561bb9c55e2b21a22dedf8266703922
GO_BIN="${MURMUR_GO_BIN:-$(command -v go || true)}"
[[ "$GO_BIN" = /* && -x "$GO_BIN" ]] || { echo 'Set MURMUR_GO_BIN to an absolute Go executable' >&2; exit 1; }
BUILD_DIR="$APP_ROOT/go-shared/build-source"
APP_PATH="$APP_ROOT/go-shared/dist/Murmur Shared Go.app"
mkdir -p "$BUILD_DIR" "$APP_PATH/Contents/MacOS"
for item in go.mod go.sum status.go icons.go; do
  git -C "$REPO_ROOT" show "$UPSTREAM:spikes/windows-tray-go/$item" > "$BUILD_DIR/$item"
done
cp "$APP_ROOT/go-shared/main_darwin.go" "$BUILD_DIR/main_darwin.go"
cd "$BUILD_DIR"
CGO_ENABLED=1 "$GO_BIN" build -trimpath -ldflags='-s -w' -o "$APP_PATH/Contents/MacOS/MurmurSharedGo" .
cat > "$APP_PATH/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>MurmurSharedGo</string>
<key>CFBundleIdentifier</key><string>org.murmur.mac.shared-go-spike</string>
<key>CFBundleName</key><string>Murmur Shared Go</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
/usr/bin/codesign --force --sign - "$APP_PATH"
/usr/bin/codesign --verify --strict "$APP_PATH"
printf '%s\n' "$APP_PATH"
