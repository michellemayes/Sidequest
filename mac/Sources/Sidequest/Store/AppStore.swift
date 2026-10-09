import AppKit
import Foundation
import Observation

/// Which sessions the list shows.
enum SessionFilter: Hashable {
    case needsYou, working, done, all
    case repo(String)

    var title: String {
        switch self {
        case .needsYou: return "Needs you"
        case .working: return "Working"
        case .done: return "Done"
        case .all: return "All sessions"
        case .repo(let name): return name
        }
    }
}

/// Something wrong, with the one thing that fixes it.
struct Banner: Identifiable, Hashable {
    enum Fix: Hashable { case startDaemon, restartSlack, updateEngine, showChecks, openSettings }
    var id: String
    var title: String
    var detail: String
    var action: String
    var fix: Fix
}

/// Everything the window shows, kept in step with the daemon.
@MainActor
@Observable
final class AppStore {
    enum Connection: Equatable { case connecting, connected, notRunning }

    private(set) var connection: Connection = .connecting
    private(set) var hello: Hello?
    private(set) var health: Health?
    private(set) var sessions: [AppSession] = []
    private(set) var stats: Stats?
    private(set) var configReply: ConfigReply?
    private(set) var checks: [CheckRow] = []
    var filter: SessionFilter = .needsYou
    var selection: AppSession.ID?
    var search = ""
    /// The last thing that went wrong, shown until dismissed.
    var lastError: DaemonError?
    /// Shown while a slow action (starting, updating, restarting Slack) runs.
    private(set) var working: String?
    var showChecks = false
    /// Asked for from the Session menu; the views confirm or focus.
    var focusReply = false
    var confirmRemove: AppSession?
    var confirmClean = false

    let notifier = Notifier()
    private let client = ControlClient()
    private var reconnectTask: Task<Void, Never>?

    init() {
        client.onEvent = { [weak self] event, line in self?.handle(event: event, line: line) }
        client.onDisconnect = { [weak self] in self?.lost() }
        notifier.onOpen = { [weak self] branch in self?.reveal(branch: branch) }
    }

    // MARK: Connection

    func start() {
        notifier.setUp()
        Task { await connect() }
    }

    private func connect() async {
        do {
            try client.connect()
            hello = try await client.request("hello", as: Hello.self)
            _ = try await client.request("subscribe", ["notices": true])
            connection = .connected
            await refreshAll()
        } catch {
            client.disconnect()
            connection = .notRunning
            scheduleReconnect()
        }
    }

    private func lost() {
        connection = .notRunning
        health = nil
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            await self?.connect()
        }
    }

    func refreshAll() async {
        await refreshSessions()
        await refreshHealth()
        await refreshConfig()
        await runChecks()
    }

    private func handle(event: String, line: Data) {
        switch event {
        case "sessions": Task { await refreshSessions() }
        case "config": Task { await refreshConfig() }
        case "health": Task { await refreshHealth() }
        case "notice":
            if let notice = try? JSONDecoder().decode(Notice.self, from: line) { notifier.post(notice) }
        default: break
        }
    }

    // MARK: Reading

    func refreshSessions() async {
        guard let reply = try? await client.request("sessions", as: SessionsReply.self) else { return }
        sessions = reply.sessions
        stats = reply.stats
        NSApp.dockTile.badgeLabel = needsYouCount > 0 ? String(needsYouCount) : nil
    }

    func refreshHealth() async {
        health = try? await client.request("health", as: Health.self)
    }

    func refreshConfig() async {
        if let reply = try? await client.request("get-config", as: ConfigReply.self) { configReply = reply }
    }

    func runChecks() async {
        if let reply = try? await client.request("doctor", as: ChecksReply.self) { checks = reply.rows }
    }

    var needsYouCount: Int { sessions.filter(\.needsYou).count }
    var repos: [String] { Array(Set(sessions.map(\.repo).filter { !$0.isEmpty })).sorted() }

    func count(_ filter: SessionFilter) -> Int { sessions.filter { matches($0, filter) }.count }

    var visibleSessions: [AppSession] {
        let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
        return sessions.filter { session in
            matches(session, filter) && (needle.isEmpty
                || session.title.lowercased().contains(needle)
                || session.branch.lowercased().contains(needle)
                || session.channel.lowercased().contains(needle))
        }
    }

    var selectedSession: AppSession? { sessions.first { $0.id == selection } }

    private func matches(_ session: AppSession, _ filter: SessionFilter) -> Bool {
        switch filter {
        case .needsYou: return session.needsYou
        case .working: return session.isWorking && !session.needsYou
        case .done: return session.isDone && !session.needsYou
        case .all: return true
        case .repo(let name): return session.repo == name
        }
    }

    /// Open the window on a session, from a notification.
    func reveal(branch: String) {
        guard let session = sessions.first(where: { $0.branch == branch }) else { return }
        filter = session.needsYou ? .needsYou : .all
        selection = session.id
        NSApp.activate()
    }

    /// What is wrong right now, most blocking first.
    var banners: [Banner] {
        var out: [Banner] = []
        if connection == .notRunning {
            out.append(Banner(id: "daemon", title: "Sidequest isn't running", detail: "Start it and it connects to Slack.", action: "Start", fix: .startDaemon))
            return out
        }
        if let health {
            if health.debugPort.open && !health.debugPort.isSlack {
                out.append(Banner(id: "port", title: "Another app is using port \(health.debugPort.port)",
                                  detail: "Pick a free DevTools port in Settings › Advanced.", action: "Open Settings", fix: .openSettings))
            } else if health.slackRunning && !health.debugPort.open {
                out.append(Banner(id: "slack-restart", title: "Slack needs a quick restart",
                                  detail: "It was opened without Sidequest.", action: "Restart Slack", fix: .restartSlack))
            } else if !health.slackRunning {
                out.append(Banner(id: "slack-closed", title: "Slack isn't open",
                                  detail: "Sidequest opens it with the overlay attached.", action: "Open Slack", fix: .restartSlack))
            }
        }
        if let hello, !hello.build.isEmpty, let mine = BuildInfo.commit, !mine.isEmpty, !hello.build.hasPrefix(mine), !mine.hasPrefix(hello.build) {
            out.append(Banner(id: "engine", title: "Sidequest's engine is a different version",
                              detail: "Update it to match this app.", action: "Update", fix: .updateEngine))
        }
        let failed = checks.filter(\.failed)
        if !failed.isEmpty {
            out.append(Banner(id: "checks", title: failed.count == 1 ? failed[0].label : "\(failed.count) setup checks failed",
                              detail: failed.count == 1 ? failed[0].detail : "See what needs fixing.", action: "Show", fix: .showChecks))
        }
        return out
    }

    func perform(_ fix: Banner.Fix) {
        switch fix {
        case .startDaemon: Task { await startDaemon() }
        case .restartSlack: Task { await act("Restarting Slack…") { _ = try await self.client.request("restart-slack") } }
        case .updateEngine: Task { await updateEngine() }
        case .showChecks: showChecks = true
        case .openSettings: SettingsOpener.open()
        }
    }

    // MARK: Actions

    /// Run one request, showing what is happening and any error it ends in.
    private func act(_ label: String? = nil, _ body: @escaping () async throws -> Void) async {
        working = label
        defer { working = nil }
        do {
            try await body()
            lastError = nil
        } catch let error as DaemonError {
            lastError = error
        } catch {
            lastError = DaemonError(message: error.localizedDescription)
        }
    }

    func startDaemon() async {
        await act("Starting Sidequest…") {
            let out = await CommandLineTool.sidequest(["start"])
            if out.status != 0 {
                throw DaemonError(message: "Sidequest didn't start.", hint: out.text.trimmingCharacters(in: .whitespacesAndNewlines))
            }
        }
        await connect()
    }

    func stopDaemon() async {
        await act("Stopping Sidequest…") { _ = await CommandLineTool.sidequest(["stop"]) }
    }

    func updateEngine() async {
        await act("Updating Sidequest's engine…") {
            let out = await CommandLineTool.sidequest(["update"])
            if out.status != 0 {
                throw DaemonError(message: "The update didn't finish.", hint: out.text.trimmingCharacters(in: .whitespacesAndNewlines))
            }
        }
    }

    func installShellHook() async {
        await act("Installing the shell hook…") { _ = await CommandLineTool.sidequest(["install-hook"]) }
        await runChecks()
    }

    func reopen(_ session: AppSession) async {
        await act { _ = try await self.client.request("reopen", ["session": session.id, "branch": session.branch]) }
    }

    func openPullRequest(_ session: AppSession) async {
        await act(session.pr == nil ? "Opening a pull request…" : nil) {
            _ = try await self.client.request("open-pr", ["branch": session.branch])
        }
    }

    func followUp(_ session: AppSession, text: String) async {
        await act { _ = try await self.client.request("follow-up", ["branch": session.branch, "question": text]) }
    }

    func reply(for session: AppSession) async -> ResultReply? {
        try? await client.request("get-result", ["branch": session.branch], as: ResultReply.self)
    }

    func postReply(_ session: AppSession, text: String) async {
        await act("Posting…") { _ = try await self.client.request("post-reply", ["branch": session.branch, "text": text]) }
    }

    func dismissReply(_ session: AppSession) async {
        await act { _ = try await self.client.request("dismiss-reply", ["branch": session.branch]) }
    }

    /// Remove a session. With uncommitted work it is refused unless `force`.
    func remove(_ session: AppSession, force: Bool = false) async {
        await act { _ = try await self.client.request("remove-session", ["session": session.id, "force": force]) }
        if selection == session.id { selection = nil }
    }

    func cleanUp(recent: Bool = false) async -> CleanReply? {
        var reply: CleanReply?
        await act("Cleaning up…") { reply = try await self.client.request("clean", ["recent": recent], as: CleanReply.self) }
        return reply
    }

    func restartSlack() async {
        await act("Restarting Slack…") { _ = try await self.client.request("restart-slack") }
    }

    // MARK: Settings

    /// Change one setting. The window shows the new value at once; the daemon's answer confirms it.
    func set<T: Encodable>(_ key: String, _ value: T) {
        Task {
            await act {
                self.configReply = try await self.client.request("set-config", ["settings": [key: JSONParam.value(value)]], as: ConfigReply.self)
            }
            if lastError != nil { await refreshConfig() }
        }
    }

    /// Set a prompt's override, or nil to go back to the built-in (or delete a prompt of your own).
    func setPrompt(_ key: String, _ override: PromptOverride?) {
        Task {
            let value: Any = override.map { JSONParam.value($0) } ?? NSNull()
            await act {
                self.configReply = try await self.client.request("set-config", ["prompts": [key: value]], as: ConfigReply.self)
            }
        }
    }

    func linkRepo(channel: String, path: String) async {
        await act { _ = try await self.client.request("link-repo", ["channel": channel, "repoPath": path]) }
        await refreshConfig()
    }

    func unlinkRepo(_ link: RepoLink) async {
        await act { _ = try await self.client.request("link-repo", ["channel": link.channel, "repo": link.repoPath]) }
        await refreshConfig()
    }

    func updateLink(_ link: RepoLink, baseBranch: String? = nil, label: String? = nil, makeDefault: Bool = false) async {
        var params: [String: Any] = ["channel": link.channel, "repoPath": link.repoPath, "makeDefault": makeDefault]
        if let baseBranch { params["baseBranch"] = baseBranch }
        if let label { params["label"] = label }
        await act { self.configReply = try await self.client.request("set-link", params, as: ConfigReply.self) }
    }
}
