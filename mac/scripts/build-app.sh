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
#   SIGN_IDENTITY        codesign identity (default "-", ad hoc). A Developer ID
#                        identity also turns on the hardened runtime, for notarization
#   UNIVERSAL            1 to build for both Apple silicon and Intel (default 1)
#   BUNDLE_ENGINE        1 to carry the daemon and its own Node inside the app (default 1)
#   NODE_VERSION         the Node.js release bundled with it (default 22.14.0)
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
BUNDLE_ENGINE="${BUNDLE_ENGINE:-1}"
NODE_VERSION="${NODE_VERSION:-22.14.0}"
repo_root="$(cd "$here/.." && pwd)"

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

engine="$app/Contents/Resources/engine"
if [ "$BUNDLE_ENGINE" = "1" ]; then
  echo "==> engine (daemon and Node ${NODE_VERSION})"
  # The daemon, built from this checkout, with only what it needs to run.
  (cd "$repo_root" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)
  mkdir -p "$engine/bin"
  cp -R "$repo_root/dist" "$engine/dist"
  mkdir -p "$engine/client"
  cp -R "$repo_root/client/overlay" "$engine/client/overlay"
  cp "$repo_root/package.json" "$repo_root/package-lock.json" "$engine/"
  (cd "$engine" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null)
  rm -f "$engine/package-lock.json"
  printf '%s\n' "$COMMIT" > "$engine/dist/.sidequest-build"
  # Tells `sidequest update` that app updates replace this copy.
  : > "$engine/.sidequest-bundled"

  # Node itself, so the app needs nothing installed to run the daemon.
  cache="${NODE_CACHE:-$here/.build/node-cache}"
  mkdir -p "$cache"
  node_arches=(arm64)
  if [ "$UNIVERSAL" = "1" ]; then node_arches=(arm64 x64); elif [ "$(uname -m)" = "x86_64" ]; then node_arches=(x64); fi
  slices=()
  for arch in "${node_arches[@]}"; do
    name="node-v${NODE_VERSION}-darwin-${arch}"
    if [ ! -x "$cache/$name/bin/node" ]; then
      curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.gz" | tar -xz -C "$cache"
    fi
    slices+=("$cache/$name/bin/node")
  done
  if [ "${#slices[@]}" -gt 1 ]; then lipo -create "${slices[@]}" -output "$engine/bin/node"; else cp "${slices[0]}" "$engine/bin/node"; fi
  chmod 755 "$engine/bin/node"

  # `sidequest` for the bundled engine: what the app runs, and what
  # Help › Install Command-Line Tool links onto your PATH.
  cat > "$engine/bin/sidequest" <<'SH'
#!/bin/bash
# The Sidequest CLI that came with Sidequest.app.
bin="$(cd "$(dirname "$(readlink "${BASH_SOURCE[0]}" || echo "${BASH_SOURCE[0]}")")" && pwd)"
exec "$bin/node" "$bin/../dist/index.js" "$@"
SH
  chmod 755 "$engine/bin/sidequest"
fi

echo "==> codesign (${SIGN_IDENTITY})"
# Inside out: the bundled Node, Sparkle's helpers, the framework, then the app.
# A Developer ID signature gets the hardened runtime and a timestamp, which
# notarization requires; Node also needs JIT under the hardened runtime.
if [ "$SIGN_IDENTITY" = "-" ]; then
  options=(--force --timestamp=none --sign "$SIGN_IDENTITY")
else
  options=(--force --timestamp --options runtime --sign "$SIGN_IDENTITY")
fi
if [ -x "$engine/bin/node" ]; then
  codesign "${options[@]}" --entitlements Resources/node.entitlements "$engine/bin/node"
fi
fw="$app/Contents/Frameworks/Sparkle.framework"
for helper in "$fw"/Versions/B/XPCServices/*.xpc "$fw"/Versions/B/Autoupdate "$fw"/Versions/B/Updater.app; do
  [ -e "$helper" ] && codesign "${options[@]}" "$helper"
done
codesign "${options[@]}" "$fw"
codesign "${options[@]}" --entitlements Resources/Sidequest.entitlements "$app"
codesign --verify --deep --strict "$app"

echo "Built $here/$app"
