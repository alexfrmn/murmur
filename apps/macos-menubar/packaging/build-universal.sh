#!/bin/bash
set -eu
SOURCE="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
REPO="$(cd -- "$SOURCE/../.." && pwd -P)"
OUTPUT="${1:?Usage: build-universal.sh ABSOLUTE_OUTPUT [PREBUILT_RUNTIME]}"
case "$OUTPUT" in /*) ;; *) printf '%s\n' 'Output must be absolute.' >&2; exit 1 ;; esac
STAGE="$OUTPUT/Murmur-Mac"
[ ! -e "$STAGE" ] || { printf '%s\n' 'Output already contains Murmur-Mac; choose a new output directory.' >&2; exit 1; }
mkdir -p "$OUTPUT"
cd "$SOURCE"
for arch in arm64 x86_64; do
  swift build -c release --triple "$arch-apple-macosx13.0" --scratch-path "$OUTPUT/swift-$arch"
done
ARM="$(swift build -c release --triple arm64-apple-macosx13.0 --scratch-path "$OUTPUT/swift-arm64" --show-bin-path)"
INTEL="$(swift build -c release --triple x86_64-apple-macosx13.0 --scratch-path "$OUTPUT/swift-x86_64" --show-bin-path)"
[ "$(/usr/bin/lipo -archs "$ARM/MurmurMenuBar")" = arm64 ]
[ "$(/usr/bin/lipo -archs "$INTEL/MurmurMenuBar")" = x86_64 ]
"$ARM/MurmurProbeChecks" "$REPO/contracts/setup/v1/fixtures"
APP="$STAGE/Murmur Spike.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
/usr/bin/ditto "$ARM/MurmurMenuBarSpike_MurmurTrayCore.bundle" "$APP/Contents/Resources/MurmurMenuBarSpike_MurmurTrayCore.bundle"
/bin/cp "$SOURCE/Resources/Info.plist" "$APP/Contents/Info.plist"
VERSION_SOURCE="$REPO/package.json"
if [ -n "${2-}" ]; then
  RUNTIME="$(cd -- "$2" && pwd -P)"
  VERSION_SOURCE="$RUNTIME/runtime-manifest.json"
fi
python3 "$SOURCE/packaging/stamp-version.py" "$APP/Contents/Info.plist" "$VERSION_SOURCE" >/dev/null
/usr/bin/lipo -create "$ARM/MurmurMenuBar" "$INTEL/MurmurMenuBar" -output "$APP/Contents/MacOS/MurmurMenuBar"
ARCHES="$(/usr/bin/lipo -archs "$APP/Contents/MacOS/MurmurMenuBar")"
case "$ARCHES" in
  'arm64 x86_64'|'x86_64 arm64') ;;
  *) printf 'Unexpected archive architectures: %s\n' "$ARCHES" >&2; exit 1 ;;
esac
python3 "$SOURCE/packaging/stamp-version.py" "$APP/Contents/Info.plist" "$VERSION_SOURCE" --check >/dev/null
/usr/bin/codesign --force --sign - "$APP"
/usr/bin/codesign --verify --strict "$APP"
python3 "$SOURCE/packaging/localization-checks.py" "$APP"
/bin/cp "$SOURCE/packaging/Open Murmur.command" "$SOURCE/packaging/murmur" "$SOURCE/packaging/README-Mac.md" "$STAGE/"
/bin/chmod 755 "$STAGE/Open Murmur.command" "$STAGE/murmur"
if [ -n "${2-}" ]; then
  RUNTIME="$(cd -- "$2" && pwd -P)"
  for file in packages/setup/bin/murmur.mjs packages/setup/dist/src/cli.js packages/mcp-server/dist/src/index.js scripts/murmur-daemon.mjs; do
    [ -f "$RUNTIME/$file" ] || { printf 'Runtime missing: %s\n' "$file" >&2; exit 1; }
  done
  /usr/bin/ditto "$RUNTIME" "$STAGE/runtime"
else
  printf '%s\n' 'App built; prebuilt runtime is absent. This folder is not ready for distribution.' >&2
fi
printf '%s\n' "$STAGE"
