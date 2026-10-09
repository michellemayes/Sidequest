#!/usr/bin/env bash
# Print the Sparkle appcast for one release: a feed with a single item, published
# as a release asset so .../releases/latest/download/appcast.xml always names
# the newest version.
#
# Environment: VERSION, BUILD, ZIP, REPOSITORY, and optionally SPARKLE_PRIVATE_KEY.
# Without the key the item carries no EdDSA signature, and the app sends you to
# the release page instead of installing in place.
set -euo pipefail

: "${VERSION:?}" "${BUILD:?}" "${ZIP:?}" "${REPOSITORY:?}"
SPARKLE_VERSION="2.6.4"

length="$(stat -f %z "$ZIP")"
signature=""
if [ -n "${SPARKLE_PRIVATE_KEY:-}" ]; then
  tools="$(mktemp -d)"
  curl -fsSL "https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/Sparkle-${SPARKLE_VERSION}.tar.xz" \
    | tar -xJ -C "$tools"
  keyfile="$(mktemp)"
  printf '%s' "$SPARKLE_PRIVATE_KEY" > "$keyfile"
  # Prints: sparkle:edSignature="…" length="…"
  signed="$("$tools/bin/sign_update" --ed-key-file "$keyfile" "$ZIP")"
  rm -f "$keyfile"
  signature="$(printf '%s' "$signed" | sed -n 's/.*sparkle:edSignature="\([^"]*\)".*/\1/p')"
  length="$(printf '%s' "$signed" | sed -n 's/.*length="\([^"]*\)".*/\1/p')"
fi

url="https://github.com/${REPOSITORY}/releases/download/v${VERSION}/${ZIP}"
date="$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')"
edsig=""
if [ -n "$signature" ]; then edsig=" sparkle:edSignature=\"${signature}\""; fi

cat <<XML
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Sidequest</title>
    <link>https://github.com/${REPOSITORY}</link>
    <item>
      <title>Sidequest ${VERSION}</title>
      <pubDate>${date}</pubDate>
      <sparkle:version>${BUILD}</sparkle:version>
      <sparkle:shortVersionString>${VERSION}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      <sparkle:releaseNotesLink>https://github.com/${REPOSITORY}/releases/tag/v${VERSION}</sparkle:releaseNotesLink>
      <enclosure url="${url}" length="${length}" type="application/octet-stream"${edsig} />
    </item>
  </channel>
</rss>
XML
