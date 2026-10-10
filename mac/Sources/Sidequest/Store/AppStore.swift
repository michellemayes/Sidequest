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
    enum Fix: Hashable {
        case startDaemon, startDaemonRestartingSlack, restartSlack, updateEngine, showChecks, openSettings
        case linkRepo, notifications, installHook
    }
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
    /// The engine turned down a request it doesn't know: it started before this app was installed.
    private(set) var engineBehind = false
    private(set) var health: Health?
    private(set) var sessions: [AppSession] = []
    private(set) var stats: Stats?
    private(set) var configReply: ConfigReply?
    private(set) var checks: [CheckRow] = []
    /// Headless agents waiting on your yes or no.
    private(set) var approvals: [Approval] = []
    /// Each headless session's conversation so far, by branch.
    private(set) var transcripts: [String: [TranscriptItem]] = [:]
    private(set) var structuredTranscripts: Set<String> = []
    var filter: SessionFilter = .needsYou
    /// The sessions picked in the list; the detail shows one when exactly one is.
    var selection: Set<AppSession.ID> = []
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
    var focusFollowUp = false
    var showStats = false
    var showLinkRepo = false
    /// Terminal tabs open right now; quitting asks first while any are.
    var openTerminals = 0
    /// Why the last start failed, for the banner that offers to try again.
    private(set) var startError: String?
    /// Whether notifications are allowed, once the app has asked the system.
    private(set) var notificationsAllowed: Bool?
    private var triedAutoStart = false

    /// The one window's store, for the app delegate.
    static weak var shared: AppStore?

    /// Start the engine when the app opens and finds it stopped. On unless turned off in Settings › General.
    static var startsEngine: Bool {
        get { UserDefaults.standard.object(forKey: "startEngineOnLaunch") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "startEngineOnLaunch") }
    }

    let notifier = Notifier()
    private let client = ControlClient()
    private var reconnectTask: Task<Void, Never>?

    init() {
        AppStore.shared = self
        client.onEvent = { [weak self] event, line in self?.handle(event: event, line: line) }
        client.onDisconnect = { [weak self] in self?.lost() }
        notifier.onOpen = { [weak self] branch in self?.reveal(branch: branch) }
        notifier.onApproval = { [weak self] id, allow in
            guard let self, let approval = self.approvals.first(where: { $0.id == id }) else { return }
            Task { await self.decide(approval, allow: allow) }
        }
    }

    // MARK: Connection

    func start() {
        notifier.setUp()
        Task {
            await connect()
            notificationsAllowed = await notifier.allowed()
        }
    }

    private func connect() async {
        do {
            try client.connect()
            hello = try await client.request("hello", as: Hello.self)
            engineBehind = false
            _ = try await client.request("subscribe", ["notices": true])
            approvals = (try? await client.request("approvals", as: ApprovalsReply.self))?.approvals ?? []
            connection = .connected
            await refreshAll()
        } catch {
            client.disconnect()
            connection = .notRunning
            if !triedAutoStart && AppStore.startsEngine {
                // Opening the app is how you start Sidequest; nothing to click.
                triedAutoStart = true
                await startDaemon(quietly: true)
                return
            }
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
        case "approval":
            if let event = try? JSONDecoder().decode(ApprovalEvent.self, from: line) {
                approvals.append(event.approval)
                notifier.postApproval(event.approval)
                updateBadge()
            }
        case "approval-settled":
            if let event = try? JSONDecoder().decode(ApprovalSettledEvent.self, from: line) {
                approvals.removeAll { $0.id == event.approvalId }
                notifier.withdraw(approval: event.approvalId)
                updateBadge()
            }
        default: break
        }
    }

    // MARK: Reading

    func refreshSessions() async {
        guard let reply = try? await client.request("sessions", as: SessionsReply.self) else { return }
        sessions = reply.sessions
        stats = reply.stats
        updateBadge()
    }

    private func updateBadge() {
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

    var needsYouCount: Int { sessions.filter { needsYou($0) }.count }

    /// A reply to read, a failed run, or a question waiting on you.
    func needsYou(_ session: AppSession) -> Bool {
        session.needsYou || approvals.contains { $0.branch == session.branch }
    }

    func pendingApprovals(for session: AppSession) -> [Approval] {
        approvals.filter { $0.branch == session.branch }
    }
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

    var selectedSession: AppSession? { selection.count == 1 ? sessions.first(where: { selection.contains($0.id) }) : nil }
    var selectedSessions: [AppSession] { sessions.filter { selection.contains($0.id) } }

    private func matches(_ session: AppSession, _ filter: SessionFilter) -> Bool {
        switch filter {
        case .needsYou: return needsYou(session)
        case .working: return session.isWorking && !needsYou(session)
        case .done: return session.isDone && !needsYou(session)
        case .all: return true
        case .repo(let name): return session.repo == name
        }
    }

    /// Open the window on a session, from a notification.
    func reveal(branch: String) {
        guard let session = sessions.first(where: { $0.branch == branch }) else { return }
        filter = needsYou(session) ? .needsYou : .all
        selection = [session.id]
        NSApp.activate()
    }

    /// What is wrong right now, most blocking first.
    var banners: [Banner] {
        var out: [Banner] = []
        if connection == .notRunning {
            if let startError, startError.contains("without --remote-debugging-port") {
                out.append(Banner(id: "daemon", title: "Slack needs a quick restart",
                                  detail: "It's open without Sidequest. Your messages and drafts stay put.",
                                  action: "Restart Slack", fix: .startDaemonRestartingSlack))
            } else if let startError {
                out.append(Banner(id: "daemon", title: "Sidequest didn't start",
                                  detail: startError.split(separator: "\n").first.map(String.init) ?? startError,
                                  action: "Try Again", fix: .startDaemon))
            } else {
                out.append(Banner(id: "daemon", title: "Sidequest isn't running", detail: "Start it and it connects to Slack.", action: "Start", fix: .startDaemon))
            }
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
        if engineBehind || engineMismatch {
            out.append(Banner(id: "engine", title: "Sidequest's engine is a different version",
                              detail: CommandLineTool.bundled == nil ? "Update it to match this app." : "Switch to the one that came with this app.",
                              action: CommandLineTool.bundled == nil ? "Update" : "Switch", fix: .updateEngine))
        }
        // First run, one step at a time: each shows until it is done.
        if let reply = configReply, reply.config.channels.isEmpty {
            out.append(Banner(id: "link", title: "Link your first channel",
                              detail: "Pick a Slack channel and the repo its messages are about.", action: "Link a Repo…", fix: .linkRepo))
        }
        if notificationsAllowed == false {
            out.append(Banner(id: "notify", title: "Turn on notifications",
                              detail: "So you hear when a reply is ready or an agent asks to run something.", action: "Turn On", fix: .notifications))
        }
        if configReply?.config.settings.terminal == "warp", let hook = checks.first(where: { $0.label == "shell hook" }), hook.status != "ok" {
            out.append(Banner(id: "hook", title: "Install the shell hook",
                              detail: "So sessions start even when Warp ignores its launch config.", action: "Install", fix: .installHook))
        }
        let failed = checks.filter(\.failed)
        if !failed.isEmpty {
            out.append(Banner(id: "checks", title: failed.count == 1 ? failed[0].label : "\(failed.count) setup checks failed",
                              detail: failed.count == 1 ? failed[0].detail : "See what needs fixing.", action: "Show", fix: .showChecks))
        }
        return out
    }

    private var engineMismatch: Bool {
        guard let hello, !hello.build.isEmpty, let mine = BuildInfo.commit, !mine.isEmpty else { return false }
        return !hello.build.hasPrefix(mine) && !mine.hasPrefix(hello.build)
    }

    func perform(_ fix: Banner.Fix) {
        switch fix {
        case .startDaemon: Task { await startDaemon() }
        case .startDaemonRestartingSlack: Task { await startDaemon(restartingSlack: true) }
        case .linkRepo: showLinkRepo = true
        case .notifications: Task { notificationsAllowed = await notifier.askOrOpenSettings() }
        case .installHook: Task { await installShellHook() }
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
        } catch let error as DaemonError where error.isUnknownOp {
            engineBehind = true
            lastError = DaemonError(
                message: "Sidequest's engine is older than this app.",
                hint: CommandLineTool.bundled == nil
                    ? "Update it from the banner, then try again."
                    : "Switch to the one that came with this app from the banner, then try again."
            )
        } catch let error as DaemonError {
            lastError = error
        } catch {
            lastError = DaemonError(message: error.localizedDescription)
        }
    }

    /// Start the engine. `quietly` (on launch) leaves a failure to the banner rather than an alert.
    func startDaemon(restartingSlack: Bool = false, quietly: Bool = false) async {
        working = "Starting Sidequest…"
        let out = await CommandLineTool.sidequest(restartingSlack ? ["start", "--force"] : ["start"])
        working = nil
        if out.status == 0 {
            startError = nil
        } else {
            let text = out.text.trimmingCharacters(in: .whitespacesAndNewlines)
            let error = text.components(separatedBy: "\n").first { $0.hasPrefix("error:") }
                .map { String($0.dropFirst("error:".count)).trimmingCharacters(in: .whitespaces) }
            startError = error ?? (text.isEmpty ? "The engine exited without saying why." : text)
            if !quietly && !(startError?.contains("without --remote-debugging-port") ?? false) {
                lastError = DaemonError(message: "Sidequest didn't start.", hint: startError)
            }
        }
        await connect()
    }

    func stopDaemon() async {
        await act("Stopping Sidequest…") { _ = await CommandLineTool.sidequest(["stop"]) }
    }

    /// Bring the engine in line with the app: restart on the bundled one, or update an installed one.
    func updateEngine() async {
        if CommandLineTool.bundled != nil {
            await act("Switching engines…") { _ = await CommandLineTool.sidequest(["stop"]) }
            await startDaemon()
            return
        }
        await act("Updating Sidequest's engine…") {
            let out = await CommandLineTool.sidequest(["update"])
            if out.status != 0 {
                throw DaemonError(message: "The update didn't finish.", hint: out.text.trimmingCharacters(in: .whitespacesAndNewlines))
            }
        }
    }

    func refreshNotificationStatus() async {
        notificationsAllowed = await notifier.allowed()
    }

    func installCommandLineTool() async {
        await act { try CommandLineTool.installLink() }
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
        selection.remove(session.id)
    }

    /// Mark sessions done, or not done again. For the ones nothing else says are finished:
    /// a question answered in its terminal never gets a reply or a pull request.
    /// Marked ones leave Working and Needs You at once, and the list moves on to the next.
    func markDone(_ targets: [AppSession], done: Bool = true) async {
        guard !targets.isEmpty else { return }
        let ids = Set(targets.map(\.id))
        let before = visibleSessions
        let next: AppSession? = before.firstIndex(where: { ids.contains($0.id) }).flatMap { start in
            before[start...].first(where: { !ids.contains($0.id) }) ?? before[..<start].last(where: { !ids.contains($0.id) })
        }
        let stamp = done ? ISO8601DateFormatter().string(from: Date()) : nil
        for index in sessions.indices where ids.contains(sessions[index].id) {
            sessions[index].doneAt = stamp
            if done { sessions[index].needsYou = false }
        }
        if !selection.isEmpty, selection.isSubset(of: ids), !visibleSessions.contains(where: { ids.contains($0.id) }) {
            selection = next.map { Set([$0.id]) } ?? []
        }
        updateBadge()
        await act {
            for session in targets {
                _ = try await self.client.request("mark-done", ["branch": session.branch, "done": done])
            }
        }
        await refreshSessions()
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

    // MARK: Headless workspace

    /// Catch up on a session's conversation: new items are appended, a reset starts it over.
    func loadTranscript(_ session: AppSession) async {
        let have = transcripts[session.branch]?.count ?? 0
        guard let reply = try? await client.request("transcript", ["branch": session.branch, "after": have], as: TranscriptReply.self) else { return }
        if reply.from == 0 {
            if transcripts[session.branch] != reply.items { transcripts[session.branch] = reply.items }
        } else if !reply.items.isEmpty {
            transcripts[session.branch, default: []].append(contentsOf: reply.items)
        }
        if reply.structured { structuredTranscripts.insert(session.branch) }
        if reply.running != session.running { await refreshSessions() }
    }

    func changes(for session: AppSession) async -> [ChangedFile] {
        (try? await client.request("changes", ["branch": session.branch], as: ChangesReply.self))?.files ?? []
    }

    func diff(for session: AppSession, path: String) async -> String {
        (try? await client.request("file-diff", ["branch": session.branch, "path": path], as: FileDiffReply.self))?.patch ?? ""
    }

    func stopRun(_ session: AppSession) async {
        await act("Stopping…") { _ = try await self.client.request("stop-run", ["branch": session.branch]) }
        await refreshSessions()
    }

    func runAgain(_ session: AppSession) async {
        await act { _ = try await self.client.request("run-again", ["branch": session.branch]) }
        transcripts[session.branch] = nil
        await refreshSessions()
    }

    func terminalCommand(for session: AppSession) async -> TerminalCommandReply? {
        try? await client.request("terminal-command", ["branch": session.branch], as: TerminalCommandReply.self)
    }

    func decide(_ approval: Approval, allow: Bool, always: Bool = false) async {
        approvals.removeAll { $0.id == approval.id }
        notifier.withdraw(approval: approval.id)
        updateBadge()
        await act {
            _ = try await self.client.request("approval-decision", ["approvalId": approval.id, "allow": allow, "always": always])
        }
    }

    // MARK: Status for Settings and cards

    func cleanPreview() async -> Int? {
        struct Reply: Decodable { var removable: Int }
        return (try? await client.request("clean-preview", as: Reply.self))?.removable
    }

    func syncStatus() async -> SyncStatus? {
        try? await client.request("sync-status", as: SyncStatus.self)
    }

    func logTail(_ session: AppSession, lines: Int = 12) async -> [String] {
        struct Reply: Decodable { var lines: [String] }
        return (try? await client.request("log-tail", ["branch": session.branch, "lines": lines], as: Reply.self))?.lines ?? []
    }
}
