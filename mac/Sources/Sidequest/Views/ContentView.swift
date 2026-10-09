import AppKit
import SwiftUI

/// The main window: what to show on the left, the sessions in the middle, the one you picked on the right.
struct ContentView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 260)
        } content: {
            SessionListView()
                .navigationSplitViewColumnWidth(min: 260, ideal: 320, max: 420)
        } detail: {
            if let session = store.selectedSession {
                SessionDetailView(session: session)
                    .id(session.id)
            } else {
                EmptyDetailView()
            }
        }
        .onAppear { SettingsOpener.action = openSettings }
        .sheet(isPresented: $store.showChecks) { ChecksView() }
        .alert(item: $store.lastError) { error in
            Alert(title: Text(error.message), message: error.hint.map { Text($0) })
        }
        .confirmationDialog(
            "Remove this session?",
            isPresented: Binding(get: { store.confirmRemove != nil }, set: { if !$0 { store.confirmRemove = nil } }),
            presenting: store.confirmRemove
        ) { session in
            Button("Remove", role: .destructive) { Task { await store.remove(session) } }
            if session.dirty {
                Button("Discard Changes and Remove", role: .destructive) { Task { await store.remove(session, force: true) } }
            }
        } message: { session in
            Text(session.dirty
                 ? "Its worktree has uncommitted changes. The branch stays if it has commits that aren't merged."
                 : "Its worktree is deleted. The branch stays if it has commits that aren't merged.")
        }
        .confirmationDialog("Clean up finished sessions?", isPresented: $store.confirmClean) {
            Button("Clean Up") { Task { _ = await store.cleanUp() } }
            Button("Include Ones Touched in the Last Hour") { Task { _ = await store.cleanUp(recent: true) } }
        } message: {
            Text("Removes worktrees whose branch is merged. Uncommitted work is never deleted.")
        }
        .overlay(alignment: .bottom) {
            if let working = store.working {
                Label(working, systemImage: "hourglass")
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule())
                    .padding()
            }
        }
    }
}

extension DaemonError: Identifiable {
    var id: String { message + (hint ?? "") }
}

struct EmptyDetailView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        ContentUnavailableView {
            Label(store.sessions.isEmpty ? "No sessions yet" : "Pick a session", systemImage: "sparkle")
        } description: {
            Text(store.sessions.isEmpty
                 ? "In Slack, hover a message and click Sidequest → Fix. The session shows up here."
                 : "Its message, progress and reply show here.")
        }
    }
}

/// Needs you, working, done, all, then one entry per repo; your stats at the bottom.
struct SidebarView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        @Bindable var store = store
        List(selection: Binding(get: { store.filter }, set: { if let f = $0 { store.filter = f } })) {
            Section {
                row(.needsYou, icon: "circle.fill", badge: true)
                row(.working, icon: "circle.lefthalf.filled")
                row(.done, icon: "checkmark.circle")
                row(.all, icon: "tray.full")
            }
            if !store.repos.isEmpty {
                Section("Repos") {
                    ForEach(store.repos, id: \.self) { repo in
                        row(.repo(repo), icon: "folder")
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            if let stats = store.stats {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(stats.today) today · \(stats.streak)-day streak")
                    Text("\(stats.total) sessions in all")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
            }
        }
    }

    private func row(_ filter: SessionFilter, icon: String, badge: Bool = false) -> some View {
        let count = store.count(filter)
        let label: Text? = badge && count == 0 ? nil : Text("\(count)")
        return Label(filter.title, systemImage: icon)
            .badge(label)
            .tag(filter)
    }
}

/// The sessions for the sidebar's choice, named for their Slack messages.
struct SessionListView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            ForEach(store.banners) { banner in
                BannerView(banner: banner)
            }
            List(store.visibleSessions, selection: $store.selection) { session in
                SessionRow(session: session)
                    .tag(session.id)
                    .contextMenu { SessionMenu(session: session) }
            }
            .overlay {
                if store.visibleSessions.isEmpty {
                    ContentUnavailableView(store.filter == .needsYou ? "Nothing needs you" : "No sessions here",
                                           systemImage: store.filter == .needsYou ? "checkmark.seal" : "tray")
                }
            }
        }
        .navigationTitle(store.filter.title)
        .searchable(text: $store.search, placement: .toolbar)
    }
}

struct SessionRow: View {
    let session: AppSession

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline) {
                Text(session.title).font(.headline).lineLimit(1)
                Spacer(minLength: 6)
                StatusPill(session: session)
            }
            Text([session.repo, session.channel.isEmpty ? nil : "#\(session.channel)", session.promptLabel]
                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 3)
    }
}

/// One word for where a session has got to, coloured by whether it needs you.
struct StatusPill: View {
    let session: AppSession

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .monospacedDigit()
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(background, in: Capsule())
            .foregroundStyle(foreground)
    }

    var text: String {
        if session.resultPending { return "reply ready" }
        if session.headless && session.running { return "running \(Elapsed.short(since: session.created))" }
        switch session.state {
        case "failed": return session.exitCode.map { "failed · exit \($0)" } ?? "failed"
        case "committed": return session.commits == 1 ? "1 commit" : "\(session.commits) commits"
        case "pr-open": return session.pr.map { "PR #\($0.number)" } ?? "PR open"
        case "pr-closed": return "PR closed"
        case "merged": return "merged"
        case "answered": return "answered"
        case "gone": return "cleaned up"
        case "working": return "working \(Elapsed.short(since: session.created))"
        default: return Elapsed.short(since: session.created) + " ago"
        }
    }

    var background: Color {
        if session.resultPending { return .accentColor }
        switch session.state {
        case "failed": return .red.opacity(0.15)
        case "merged": return .green.opacity(0.15)
        default: return .secondary.opacity(0.12)
        }
    }

    var foreground: Color {
        if session.resultPending { return .white }
        switch session.state {
        case "failed": return .red
        case "merged": return .green
        default: return .secondary
        }
    }
}

enum Elapsed {
    static func short(since date: Date?) -> String {
        guard let date else { return "" }
        let minutes = max(0, Int(Date().timeIntervalSince(date) / 60))
        if minutes < 60 { return "\(minutes)m" }
        if minutes < 60 * 24 { return "\(minutes / 60)h" }
        return "\(minutes / (60 * 24))d"
    }
}

/// A problem, with the button that fixes it.
struct BannerView: View {
    @Environment(AppStore.self) private var store
    let banner: Banner

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 1) {
                Text(banner.title).font(.callout.weight(.semibold))
                Text(banner.detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button(banner.action) { store.perform(banner.fix) }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
        .padding(10)
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))
        .padding([.horizontal, .top], 10)
    }
}

/// The same actions as the Session menu, on a row's right-click.
struct SessionMenu: View {
    @Environment(AppStore.self) private var store
    let session: AppSession

    var body: some View {
        Button("Open in Terminal") { Task { await store.reopen(session) } }
        if session.pr != nil || session.commits > 0 {
            Button(session.pr == nil ? "Open Pull Request" : "View Pull Request") { Task { await store.openPullRequest(session) } }
        }
        if let url = URL(string: session.permalink), !session.permalink.isEmpty {
            Button("View in Slack") { NSWorkspace.shared.open(url) }
        }
        Divider()
        Button("Show Worktree in Finder") { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: session.worktreePath) }
        Button("Copy Branch Name") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(session.branch, forType: .string)
        }
        Divider()
        Button("Remove Session…", role: .destructive) { store.confirmRemove = session }
    }
}

/// Doctor's checks, with fixes for the ones the app can make.
struct ChecksView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Setup checks").font(.title2.bold())
            List(store.checks) { row in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: row.status == "ok" ? "checkmark.circle.fill" : row.failed ? "xmark.circle.fill" : "minus.circle")
                        .foregroundStyle(row.status == "ok" ? .green : row.failed ? .red : .secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.label)
                        if !row.detail.isEmpty { Text(row.detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                    }
                    Spacer()
                    if row.label == "shell hook" && row.status != "ok" {
                        Button("Install") { Task { await store.installShellHook() } }
                    }
                }
            }
            .frame(minHeight: 320)
            HStack {
                Button("Run Again") { Task { await store.runChecks() } }
                Spacer()
                Button("Done") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 560)
    }
}
