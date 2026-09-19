#!/bin/bash
set -euo pipefail
APP_ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$APP_ROOT"
# Packaging is gated by the canonical cross-platform fixtures, not private copies.
swift run MurmurProbeChecks "$APP_ROOT/../../contracts/setup/v1/fixtures"
swift build -c release
APP_PATH="$APP_ROOT/dist/Murmur Spike.app"
mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources"
cp .build/release/MurmurMenuBar "$APP_PATH/Contents/MacOS/MurmurMenuBar"
/usr/libexec/PlistBuddy -c 'Print' Resources/Info.plist >/dev/null
cp Resources/Info.plist "$APP_PATH/Contents/Info.plist"
codesign --force --sign - "$APP_PATH"
codesign --verify --strict "$APP_PATH"
printf '%s\n' "$APP_PATH"
