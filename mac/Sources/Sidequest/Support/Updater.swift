import AppKit
import Foundation
import Observation
import Sparkle

/// Keeps the app current. Every merge to main publishes a release; the app
/// looks for a new one when it opens and every hour after, says so in a
/// notification, and installs it itself when you click: with Sparkle in a
/// build that carries the release signing key, else by downloading the
/// release, checking its signature and swapping it in.
@MainActor
@Observable
final class Updater {
    private(set) var latest: Release?
    private(set) var lastChecked: Date?
    private(set) var phase: Phase = .idle

    enum Phase: Equatable {
        case idle
        case checking
        case upToDate
        case available
        /// How much of the new version has arrived, from 0 to 1.
        case downloading(Double)
        case installing
        /// Unpacked and checked; it goes in when the app quits.
        case readyToRelaunch
        case failed(String)
    }

    struct Release: Decodable, Equatable {
        var tagName: String
        var htmlURL: String
        var name: String?
        var assets: [Asset] = []

        struct Asset: Decodable, Equatable {
            var name: String
            var url: String

            enum CodingKeys: String, CodingKey {
                case name
                case url = "browser_download_url"
            }
        }

        enum CodingKeys: String, CodingKey {
            case tagName = "tag_name"
            case htmlURL = "html_url"
            case name, assets
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            tagName = try c.decode(String.self, forKey: .tagName)
            htmlURL = try c.decode(String.self, forKey: .htmlURL)
            name = try c.decodeIfPresent(String.self, forKey: .name)
            assets = try c.decodeIfPresent([Asset].self, forKey: .assets) ?? []
        }

        /// "v0.1.57" as "0.1.57".
        var version: String { tagName.hasPrefix("v") ? String(tagName.dropFirst()) : tagName }

        /// The zipped app the release workflow publishes, Sidequest-<version>.zip.
        var download: URL? {
            assets.first { $0.name.hasPrefix("Sidequest") && $0.name.hasSuffix(".zip") }.flatMap { URL(string: $0.url) }
        }
    }

    @ObservationIgnored private let sparkle: SPUStandardUpdaterController?
    @ObservationIgnored private weak var notifier: Notifier?
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var work: Task<Void, Never>?
    @ObservationIgnored private var staged: AppInstaller.Staged?
    private static let notifiedKey = "lastNotifiedVersion"

    /// Opens the Software Update window from places with no SwiftUI environment, such as a notification.
    @ObservationIgnored var showWindow: (@MainActor () -> Void)?

    init(notifier: Notifier) {
        self.notifier = notifier
        // Sparkle can only install what it can verify, so it is started only in
        // a build that carries the release signing key.
        let key = Bundle.main.object(forInfoDictionaryKey: "SUPublicEDKey") as? String ?? ""
        sparkle = key.isEmpty ? nil : SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
        notifier.onUpdate = { [weak self] in
            guard let self else { return }
            if self.sparkle == nil {
                if let showWindow = self.showWindow { showWindow() } else { SettingsOpener.open() }
            }
            self.install()
        }
        // The new copy goes in once this one has exited, whatever made it quit.
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                if let staged = self?.staged { AppInstaller.swapWhenQuit(staged) }
            }
        }
    }

    var updateAvailable: Bool {
        guard let latest else { return false }
        return Self.isNewer(latest.version, than: BuildInfo.version)
    }

    var checking: Bool { phase == .checking }

    /// Downloading or installing: a check now would only get in the way.
    var busy: Bool {
        switch phase {
        case .downloading, .installing, .readyToRelaunch: true
        default: false
        }
    }

    /// Sparkle checks, downloads and installs with its own window.
    var usesSparkle: Bool { sparkle != nil }

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

    /// Check for Updates…: Sparkle's window where it is set up, else a check whose
    /// progress the Software Update window shows.
    func checkForUpdates() {
        if let sparkle {
            sparkle.checkForUpdates(nil)
        } else if !busy {
            Task { await check(quietly: false) }
        }
    }

    /// One line on where updating has got to, for Settings.
    var summary: String {
        let version = latest?.version ?? ""
        switch phase {
        case .checking: return "Checking…"
        case .downloading(let fraction): return "Downloading \(version) · \(Int(fraction * 100))%"
        case .installing: return "Installing \(version)…"
        case .readyToRelaunch: return "\(version) goes in when Sidequest quits"
        case .failed(let message): return message
        default: return updateAvailable ? "Version \(version) is available" : "Up to date"
        }
    }

    /// Ask GitHub for the newest release. Quietly (on launch and every hour)
    /// a failure is not shown, and a new version gets one notification.
    func check(quietly: Bool = true) async {
        guard !busy else { return }
        let before = phase
        phase = .checking
        var request = URLRequest(url: URL(string: "https://api.github.com/repos/\(BuildInfo.repository)/releases/latest")!)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let release = try? JSONDecoder().decode(Release.self, from: data) else {
            phase = quietly ? (before == .checking ? .idle : before) : .failed("Sidequest couldn't reach GitHub to look for an update. Check your connection and try again.")
            return
        }
        latest = release
        lastChecked = Date()
        phase = updateAvailable ? .available : .upToDate
        guard quietly, updateAvailable else { return }
        let defaults = UserDefaults.standard
        if defaults.string(forKey: Self.notifiedKey) != release.version {
            defaults.set(release.version, forKey: Self.notifiedKey)
            notifier?.postUpdate(version: release.version)
        }
    }

    /// Install the new version in the app: with Sparkle where the build can verify it,
    /// else download it here, check it, and relaunch into it.
    func install() {
        if let sparkle {
            sparkle.checkForUpdates(nil)
            return
        }
        if phase == .readyToRelaunch {
            relaunch()
            return
        }
        guard work == nil else { return }
        work = Task {
            await installInPlace()
            work = nil
        }
    }

    /// Stop a download in progress.
    func cancel() {
        work?.cancel()
    }

    /// Quit, so the new copy goes in, and open it.
    func relaunch() {
        guard staged != nil else { return }
        phase = .readyToRelaunch
        // Returns only if quitting was cancelled (a terminal tab is open and you
        // chose to stay); the update then goes in whenever the app does quit.
        NSApp.terminate(nil)
    }

    /// The release page, for installing by hand when installing here can't work.
    func openReleasePage() {
        let link = latest?.htmlURL ?? "https://github.com/\(BuildInfo.repository)/releases/latest"
        if let url = URL(string: link) { NSWorkspace.shared.open(url) }
    }

    private func installInPlace() async {
        if !updateAvailable { await check(quietly: false) }
        guard let release = latest, updateAvailable else { return }
        guard let url = release.download else {
            phase = .failed("Sidequest \(release.version) has no app to download yet. Try again in a few minutes.")
            return
        }
        phase = .downloading(0)
        do {
            staged = try await AppInstaller.stage(url, version: release.version) { [weak self] fraction in
                Task { @MainActor in
                    guard let self else { return }
                    if fraction >= 1 {
                        if case .downloading = self.phase { self.phase = .installing }
                    } else if case .downloading = self.phase {
                        self.phase = .downloading(fraction)
                    }
                }
            }
            relaunch()
        } catch is CancellationError {
            phase = .available
        } catch {
            phase = .failed(error.localizedDescription)
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
