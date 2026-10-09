# Sidequest for Mac

The Mac app: a window for following sessions, editing their replies, and
changing every setting, over the daemon in `src/`. It talks to the running
daemon over `~/.sidequest/control.sock` (see `src/control/`).

## Build

Needs Xcode 16 or later (Swift 5.10+) on macOS 14 or later.

```bash
cd mac
swift test                      # unit tests
swift run Sidequest             # run from source (no notifications: those need a bundle)
UNIVERSAL=0 scripts/build-app.sh   # mac/build/Sidequest.app for this Mac
```

## Releases

`.github/workflows/release.yml` runs on every merge to `main`. It builds the app,
zips it, writes a Sparkle appcast, and publishes both as the latest GitHub
release, `v<major>.<minor>.<run number>`. The app checks
`/releases/latest` when it opens and every hour, and posts a notification for a
version it hasn't announced yet.

For the app to install updates itself (rather than open the release page), the
releases have to be signed for Sparkle. Once, on a Mac:

1. Download Sparkle 2.6.4 and run `bin/generate_keys`. It stores the private key in
   your login keychain and prints the public key.
2. Export the private key: `bin/generate_keys -x sparkle_private_key`.
3. In the repository's Settings → Secrets and variables → Actions, add:
   - the secret `SPARKLE_PRIVATE_KEY`: the exported file's contents;
   - the variable `SPARKLE_PUBLIC_KEY`: the printed public key.

Builds from then on carry the public key, and their appcast entries are signed.

Releases are signed ad hoc, so macOS asks before opening a downloaded copy the
first time. Signing with a Developer ID and notarizing removes that; pass
`SIGN_IDENTITY` to `scripts/build-app.sh` once a certificate is in the runner's
keychain.
