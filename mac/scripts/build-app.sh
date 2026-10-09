#!/usr/bin/env bash
# Build Sidequest.app from the Swift package, for this Mac or for release.
#
#   mac/scripts/build-app.sh                 # a local build in mac/build/
#   VERSION=0.1.57 BUILD=57 mac/scripts/build-app.sh
#
# Environment:
#   VERSION              CFBundleShortVersionString (default 0.0.0)
#   BUILD                CFBundleVersion (default 0)
#   COMMIT               the commit the app is built from (default: HEAD)
#   REPOSITORY           owner/name releases come from (default michellemayes/Sidequest)
#   SPARKLE_PUBLIC_KEY   EdDSA key updates are verified with; empty leaves in-app installs off
#   SIGN_IDENTITY        codesign identity (default "-", ad hoc)
#   UNIVERSAL            1 to build for both Apple silicon and Intel (default 1)
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"

VERSION="${VERSION:-0.0.0}"
BUILD="${BUILD:-0}"
COMMIT="${COMMIT:-$(git rev-parse HEAD 2>/dev/null || echo "")}"
REPOSITORY="${REPOSITORY:-michellemayes/Sidequest}"
SPARKLE_PUBLIC_KEY="${SPARKLE_PUBLIC_KEY:-}"
SIGN_IDENTITY="${SIGN_IDENTITY:--}"
UNIVERSAL="${UNIVERSAL:-1}"

arch_flags=()
if [ "$UNIVERSAL" = "1" ]; then arch_flags=(--arch arm64 --arch x86_64); fi

echo "==> swift build (${VERSION} build ${BUILD})"
swift build -c release ${arch_flags[@]+"${arch_flags[@]}"} --product Sidequest
bin="$(swift build -c release ${arch_flags[@]+"${arch_flags[@]}"} --show-bin-path)"

app="build/Sidequest.app"
rm -rf build
mkdir -p "$app/Contents/MacOS" "$app/Contents/Frameworks" "$app/Contents/Resources"

cp "$bin/Sidequest" "$app/Contents/MacOS/Sidequest"

sparkle="$bin/Sparkle.framework"
if [ ! -d "$sparkle" ]; then
  sparkle="$(find .build -type d -name Sparkle.framework -path '*macos*' -prune 2>/dev/null | head -n 1)"
fi
if [ -z "$sparkle" ] || [ ! -d "$sparkle" ]; then
  echo "Sparkle.framework was not found in the build products" >&2
  exit 1
fi
cp -R "$sparkle" "$app/Contents/Frameworks/"

sed -e "s|__VERSION__|${VERSION}|g" \
    -e "s|__BUILD__|${BUILD}|g" \
    -e "s|__COMMIT__|${COMMIT}|g" \
    -e "s|__REPOSITORY__|${REPOSITORY}|g" \
    -e "s|__SPARKLE_PUBLIC_KEY__|${SPARKLE_PUBLIC_KEY}|g" \
    Resources/Info.plist > "$app/Contents/Info.plist"
plutil -lint "$app/Contents/Info.plist" >/dev/null

echo "==> icon"
iconset="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" Resources/AppIcon.png --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" Resources/AppIcon.png --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"

echo "==> codesign (${SIGN_IDENTITY})"
# Inside out: Sparkle's helpers, then the framework, then the app.
options=(--force --timestamp=none --sign "$SIGN_IDENTITY")
if [ "$SIGN_IDENTITY" != "-" ]; then options=(--force --timestamp --options runtime --sign "$SIGN_IDENTITY"); fi
fw="$app/Contents/Frameworks/Sparkle.framework"
for helper in "$fw"/Versions/B/XPCServices/*.xpc "$fw"/Versions/B/Autoupdate "$fw"/Versions/B/Updater.app; do
  [ -e "$helper" ] && codesign "${options[@]}" "$helper"
done
codesign "${options[@]}" "$fw"
codesign "${options[@]}" "$app"
codesign --verify --deep --strict "$app"

echo "Built $here/$app"
