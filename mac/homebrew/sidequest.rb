# Homebrew cask for Sidequest.app, for a tap (e.g. michellemayes/homebrew-tap,
# installed with `brew install --cask michellemayes/tap/sidequest`). Homebrew
# only takes notarized apps, so publish it once releases are notarized; then
# set `version` and `sha256` from each release (shasum -a 256 the zip).
cask "sidequest" do
  version "0.1.0"
  sha256 "REPLACE_WITH_THE_RELEASE_ZIP_SHA256"

  url "https://github.com/michellemayes/Sidequest/releases/download/v#{version}/Sidequest-#{version}.zip"
  name "Sidequest"
  desc "Turn any Slack message into a coding-agent session in a fresh git worktree"
  homepage "https://github.com/michellemayes/Sidequest"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The app updates itself.
  auto_updates true
  depends_on macos: ">= :sonoma"

  app "Sidequest.app"
  # The CLI that comes with the app, on your PATH.
  binary "#{appdir}/Sidequest.app/Contents/Resources/engine/bin/sidequest"

  zap trash: [
    "~/Library/Preferences/com.michellemayes.sidequest.plist",
  ]
end
