import AppKit
import Foundation
import Observation
import Sparkle

/// Keeps the app current. Every merge to main publishes a release; the app
/// looks for a new one when it opens and every hour after, says so in a
/// notification, and installs it with Sparkle when you click.
@MainActor
@Observable
final class Updater {
    private(set) var latest: Release?
    private(set) var lastChecked: Date?
    private(set) var checking = false

    struct Release: Decodable, Equatable {
        var tagName: String
        var htmlURL: String
        var name: String?

        enum CodingKeys: String, CodingKey {
            case tagName = "tag_name"
            case htmlURL = "html_url"
            case name
        }

        /// "v0.1.57" as "0.1.57".
        var version: String { tagName.hasPrefix("v") ? String(tagName.dropFirst()) : tagName }
    }

    @ObservationIgnored private let sparkle: SPUStandardUpdaterController?
    @ObservationIgnored private weak var notifier: Notifier?
    @ObservationIgnored private var timer: Timer?
    private static let notifiedKey = "lastNotifiedVersion"

    init(notifier: Notifier) {
        self.notifier = notifier
        // Sparkle can only install what it can verify, so it is started only in
        // a build that carries the release signing key.
        let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String ?? ""
        sparkle = key.isEmpty ? nil : SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        notifier.onUpdate = { [weak self] in self?.install() }
    }

    var updateAvailable: Bool {
        guard let latest else { return false }
        return Self.isNewer(latest.version, than: BuildInfo.version)
    }

    var installsInApp: Bool { sparkle != nil }

    var installsAutomatically: Bool {
        get { sparkle?.updater.automaticallyDownloadsUpdates ?? false }
        set {
            sparkle?.updater.automaticallyChecksForUpdates = true
            sparkle?.updater.automaticallyDownloadsUpdates = newValue
        }
    }

    func start() {
        Task { await check() }
        timer = Timer.scheduledTimer(withTimeInterval: 60 * 60, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.check() }
        }
    }

    /// Ask GitHub for the newest release, and notify once per new version.
    func check() async {
        checking = true
        defer { checking = false }
        var request = URLRequest(url: URL(string: "https://api.github.com/repos/\(BuildInfo.repository)/releases/latest")!)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let release = try? JSONDecoder().decode(Release.self, from: data) else { return }
        latest = release
        lastChecked = Date()
        guard updateAvailable else { return }
        let defaults = UserDefaults.standard
        if defaults.string(forKey: Self.notifiedKey) != release.version {
            defaults.set(release.version, forKey: Self.notifiedKey)
            notifier?.postUpdate(version: release.version)
        }
    }

    /// Install the new version: with Sparkle where the build can verify it, else from the release page.
    func install() {
        if let sparkle {
            sparkle.checkForUpdates(nil)
        } else if let latest, let url = URL(string: latest.htmlURL) {
            NSWorkspace.shared.open(url)
        }
    }

    /// Whether dotted version `a` is newer than `b`. "dev" (a local build) is older than anything.
    nonisolated static func isNewer(_ a: String, than b: String) -> Bool {
        let parse: (String) -> [Int] = { $0.split(separator: ".").map { Int($0) ?? 0 } }
        let left = parse(a), right = parse(b)
        if right.isEmpty || b == "dev" { return !left.isEmpty }
        for i in 0..<max(left.count, right.count) {
            let l = i < left.count ? left[i] : 0
            let r = i < right.count ? right[i] : 0
            if l != r { return l > r }
        }
        return false
    }
}
