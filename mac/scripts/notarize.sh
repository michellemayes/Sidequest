#!/usr/bin/env bash
# Notarize a Developer ID–signed Sidequest.app and staple the ticket to it, so
# it opens without a Gatekeeper warning even offline.
#
#   APPLE_ID=… APPLE_TEAM_ID=… APPLE_APP_PASSWORD=… mac/scripts/notarize.sh mac/build/Sidequest.app
#
# APPLE_APP_PASSWORD is an app-specific password for APPLE_ID
# (appleid.apple.com → Sign-In and Security → App-Specific Passwords).
set -euo pipefail

app="${1:?usage: notarize.sh <path to Sidequest.app>}"
: "${APPLE_ID:?}" "${APPLE_TEAM_ID:?}" "${APPLE_APP_PASSWORD:?}"

# Notarization only takes code signed with a Developer ID, the hardened runtime and a timestamp.
codesign --verify --deep --strict --verbose=2 "$app"
if ! codesign -dvv "$app" 2>&1 | grep -q "Authority=Developer ID Application"; then
  echo "$app is not signed with a Developer ID; set SIGN_IDENTITY when building it" >&2
  exit 1
fi

upload="$(mktemp -d)/Sidequest-notarize.zip"
ditto -c -k --keepParent "$app" "$upload"

echo "==> notarytool submit (waits for Apple's verdict)"
set +e
result="$(xcrun notarytool submit "$upload" \
  --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" \
  --wait --output-format json)"
status=$?
set -e
echo "$result"
id="$(printf '%s' "$result" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("id",""))' 2>/dev/null || true)"
verdict="$(printf '%s' "$result" | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null || true)"
if [ "$status" -ne 0 ] || [ "$verdict" != "Accepted" ]; then
  # Apple's log says which file failed and why.
  if [ -n "$id" ]; then
    xcrun notarytool log "$id" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" || true
  fi
  echo "Notarization was not accepted (${verdict:-no verdict})" >&2
  exit 1
fi

echo "==> staple"
xcrun stapler staple "$app"
xcrun stapler validate "$app"
spctl --assess --type execute --verbose=2 "$app"
echo "Notarized $app"
