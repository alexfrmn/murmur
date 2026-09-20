#!/bin/bash
set -euo pipefail
SOURCE="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
REPO="$(cd -- "$SOURCE/../.." && pwd -P)"
OUTPUT="${1:?Usage: build-dmg.sh ABSOLUTE_NEW_OUTPUT PREBUILT_RUNTIME}"
RUNTIME="${2:?A verified prebuilt runtime is required}"
BUILD_ROOT="${MURMUR_SWIFT_BUILD_ROOT:-$OUTPUT}"
case "$OUTPUT" in /*) ;; *) printf '%s\n' 'Output must be absolute.' >&2; exit 1 ;; esac
case "$BUILD_ROOT" in /*) ;; *) printf '%s\n' 'Swift build root must be absolute.' >&2; exit 1 ;; esac
[ ! -e "$OUTPUT" ] || { printf '%s\n' 'Output already exists; choose a new directory.' >&2; exit 1; }
RUNTIME="$(cd -- "$RUNTIME" && pwd -P)"
# Verify every runtime byte before building. No dependency resolution or build in the user's app.
python3 "$SOURCE/packaging/manifest-checks.py"
python3 "$SOURCE/packaging/version-checks.py"
python3 "$SOURCE/packaging/verify-runtime.py" "$RUNTIME"
mkdir -p "$OUTPUT"
cd "$SOURCE"
for arch in arm64 x86_64; do
  swift build -c release --triple "$arch-apple-macosx13.0" --scratch-path "$BUILD_ROOT/swift-$arch"
done
ARM="$(swift build -c release --triple arm64-apple-macosx13.0 --scratch-path "$BUILD_ROOT/swift-arm64" --show-bin-path)"
INTEL="$(swift build -c release --triple x86_64-apple-macosx13.0 --scratch-path "$BUILD_ROOT/swift-x86_64" --show-bin-path)"
case "$(uname -m)" in
  arm64) "$ARM/MurmurProbeChecks" "$REPO/contracts/setup/v1/fixtures" ;;
  x86_64) "$INTEL/MurmurProbeChecks" "$REPO/contracts/setup/v1/fixtures" ;;
  *) printf '%s\n' 'Unsupported Mac build host architecture.' >&2; exit 1 ;;
esac
STAGE="$OUTPUT/image"
APP="$STAGE/Murmur.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
/usr/bin/ditto "$ARM/MurmurMenuBarSpike_MurmurTrayCore.bundle" "$APP/Contents/Resources/MurmurMenuBarSpike_MurmurTrayCore.bundle"
cp "$SOURCE/Resources/Info.plist" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName Murmur' "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier org.murmur.mac' "$APP/Contents/Info.plist"
# The engine's declared version is preserved; a prerelease filename is not a version bump.
VERSION="$(python3 "$SOURCE/packaging/stamp-version.py" "$APP/Contents/Info.plist" "$RUNTIME/runtime-manifest.json")"
for binary in MurmurMenuBar MurmurRuntimeLauncher; do
  name="$binary"
  if [ "$binary" = MurmurRuntimeLauncher ]; then name=murmur; fi
  /usr/bin/lipo -create "$ARM/$binary" "$INTEL/$binary" -output "$APP/Contents/MacOS/$name"
  ARCHES="$(/usr/bin/lipo -archs "$APP/Contents/MacOS/$name")"
  case "$ARCHES" in
    'arm64 x86_64'|'x86_64 arm64') ;;
    *) printf 'Unexpected architectures: %s\n' "$ARCHES" >&2; exit 1 ;;
  esac
  /usr/bin/codesign --force --sign - "$APP/Contents/MacOS/$name"
done
/usr/bin/ditto "$RUNTIME" "$APP/Contents/Resources/runtime"
python3 "$SOURCE/packaging/verify-runtime.py" "$APP/Contents/Resources/runtime"
python3 "$SOURCE/packaging/stamp-version.py" "$APP/Contents/Info.plist" "$RUNTIME/runtime-manifest.json" --check >/dev/null
/usr/bin/codesign --force --sign - "$APP"
/usr/bin/codesign --verify --deep --strict "$APP"
python3 "$SOURCE/packaging/localization-checks.py" "$APP"
python3 "$SOURCE/packaging/native-bridge-check.py" "$APP"
ln -s /Applications "$STAGE/Applications"
cp "$SOURCE/packaging/Read Me First.txt" "$STAGE/Read Me First.txt"
cp "$SOURCE/packaging/Read Me First (Русский).txt" "$STAGE/Read Me First (Русский).txt"
DMG="$OUTPUT/Murmur-Mac-$VERSION-universal.dmg"
/usr/bin/hdiutil create -volname Murmur -srcfolder "$STAGE" -format UDZO "$DMG"
/usr/bin/hdiutil verify "$DMG"
/usr/bin/shasum -a 256 "$DMG"
printf '%s\n' "$DMG"
