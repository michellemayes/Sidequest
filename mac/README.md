# Sidequest for Mac

The Mac app: a window for following sessions, working on headless ones,
editing their replies, and changing every setting. It carries its own copy of
the daemon (`src/`) and of Node, so a download is all it needs; it talks to
the running daemon over `~/.sidequest/control.sock` (see `src/control/`).

## Build

Needs Xcode 16 or later (Swift 5.10+) on macOS 14 or later, and Node 20+.

```bash
cd mac
swift test                         # unit tests
swift run Sidequest                # run from source (no notifications: those need a bundle)
UNIVERSAL=0 scripts/build-app.sh   # mac/build/Sidequest.app for this Mac
```

`build-app.sh` builds the daemon from this checkout, installs its production
dependencies, adds the official Node binary (`NODE_VERSION`, universal unless
`UNIVERSAL=0`), and puts them in `Contents/Resources/engine`, with
`engine/bin/sidequest` as its CLI. `BUNDLE_ENGINE=0` leaves them out; the app
then uses the `sidequest` on your PATH.

The app starts the engine when it opens (Settings › General can turn that
off), through your login shell so the daemon finds git, your agent and your
terminals. Help › Install Command-Line Tool links `engine/bin/sidequest` to
`/usr/local/bin/sidequest`. `sidequest update` leaves the bundled engine
alone: app updates replace it.

## Releases

`.github/workflows/release.yml` runs on every merge to `main`. It builds the app,
zips it, writes a Sparkle appcast, and publishes both as the latest GitHub
release, `v<major>.<minor>.<run number>`. The app checks `/releases/latest` when
it opens and every hour, and posts a notification for a version it hasn't
announced yet. Clicking it, or Sidequest › Check for Updates…, installs the new
version and relaunches.

### Signing updates (Sparkle)

Check for Updates… always installs in the app: it downloads the release's zip,
checks that the app inside is Sidequest, intact, and signed by the same Developer ID
team as the running copy (any valid signature, for an ad hoc build), swaps it in when
the app quits, and reopens on it. With Sparkle's keys set, Sparkle does this instead,
checking each update's EdDSA signature too:

1. Download Sparkle 2.6.4 and run `bin/generate_keys`. It stores the private key in
   your login keychain and prints the public key.
2. Export the private key: `bin/generate_keys -x sparkle_private_key`.
3. In the repository's Settings → Secrets and variables → Actions, add:
   - the secret `SPARKLE_PRIVATE_KEY`: the exported file's contents;
   - the variable `SPARKLE_PUBLIC_KEY`: the printed public key.

### Signing and notarizing the app (Developer ID)

Without these, releases are signed ad hoc and macOS asks before opening a
downloaded copy the first time. With them, the release workflow signs every
binary (the app, Sparkle's helpers and the bundled Node) with your Developer ID
and the hardened runtime, has Apple notarize it (`mac/scripts/notarize.sh`), and
staples the ticket before zipping.

1. Join the Apple Developer Program, then in Xcode → Settings → Accounts →
   Manage Certificates, create a **Developer ID Application** certificate.
2. In Keychain Access, export it with its private key as a `.p12`, with a password.
3. Make an app-specific password for your Apple ID at appleid.apple.com →
   Sign-In and Security → App-Specific Passwords.
4. Add these repository secrets:

   | Secret | Value |
   | --- | --- |
   | `MACOS_CERTIFICATE_P12` | `base64 -i DeveloperID.p12` |
   | `MACOS_CERTIFICATE_PASSWORD` | the `.p12`'s password |
   | `APPLE_ID` | your Apple ID's email |
   | `APPLE_TEAM_ID` | your team ID (Membership details on developer.apple.com) |
   | `APPLE_APP_PASSWORD` | the app-specific password |

The next merge to `main` then publishes a notarized release. To try it locally:

```bash
SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" mac/scripts/build-app.sh
APPLE_ID=… APPLE_TEAM_ID=… APPLE_APP_PASSWORD=… mac/scripts/notarize.sh mac/build/Sidequest.app
```

Entitlements: `Resources/Sidequest.entitlements` (Apple Events, for iTerm2,
Terminal and Slack) and `Resources/node.entitlements` (JIT, which V8 needs under
the hardened runtime). The app is not sandboxed: it runs git, terminals and agents.

### Homebrew

`homebrew/sidequest.rb` is a cask for a tap, ready once releases are notarized
(Homebrew no longer takes unsigned casks). Set its `version` and `sha256` from a
release.
