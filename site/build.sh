#!/bin/sh
# Assembles the marketing page in _site/: index.html plus the images it shares
# with the README (copied rather than duplicated in git) and the link preview
# image, site/og.png. Vercel runs this and serves _site/ (see vercel.json).
# To preview it locally:
#
#   site/build.sh && python3 -m http.server -d _site 8000
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/_site"
rm -rf "$out"
mkdir -p "$out"
cp "$root/site/index.html" "$out/"
cp "$root/assets/icon.svg" "$out/"
cp "$root/docs/demo/demo.gif" "$out/"
cp "$root/site/og.png" "$out/"
echo "Built $out"
