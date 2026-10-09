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
            } else if store.selection.count > 1 {
                SelectionDetailView()
            } else {
                EmptyDetailView()
            }
        }
        .onAppear { SettingsOpener.action = openSettings }
        .sheet(isPresented: $store.showChecks) { ChecksView() }
        .sheet(isPresented: $store.showStats) { StatsView() }
        .sheet(isPresented: $store.showLinkRepo) { LinkRepoSheet().padding() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await store.refreshNotificationStatus() }
        }
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

/// Several sessions picked at once: what can be done to all of them.
struct SelectionDetailView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        let picked = store.selectedSessions
        ContentUnavailableView {
            Label("\(picked.count) sessions selected", systemImage: "square.stack.3d.up")
        } description: {
            Text("Mark them done to move them out of Working and Needs You.")
        } actions: {
            MarkDoneButton(sessions: picked)
                .buttonStyle(.borderedProminent)
        }
    }
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
                row(.needsYou, icon: "exclamationmark.bubble.fill", tint: .orange, badge: true)
                row(.working, icon: "circle.dotted", tint: .blue)
                row(.done, icon: "checkmark.circle.fill", tint: .green)
                row(.all, icon: "tray.full.fill", tint: .secondary)
            }
            if !store.repos.isEmpty {
                Section("Repos") {
                    ForEach(store.repos, id: \.self) { repo in
                        row(.repo(repo), icon: "folder", tint: .secondary)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            if let stats = store.stats {
                HStack(spacing: 8) {
                    Image(systemName: "flame.fill")
                        .foregroundStyle(stats.streak > 0 ? Color.orange : Color.secondary)
                        .font(.title3)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(stats.streak == 1 ? "1-day streak" : "\(stats.streak)-day streak")
                            .font(.callout.weight(.semibold))
                        Text("\(stats.today) today · \(stats.total) in all")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                }
                .padding(10)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .padding(10)
                .contentShape(Rectangle())
                .onTapGesture { store.showStats = true }
                .help("Show stats")
            }
        }
    }

    private func row(_ filter: SessionFilter, icon: String, tint: Color, badge: Bool = false) -> some View {
        let count = store.count(filter)
        let label: Text? = badge && count == 0 ? nil : Text("\(count)")
        return Label {
            Text(filter.title)
        } icon: {
            Image(systemName: icon).foregroundStyle(tint)
        }
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
                    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                        Button {
                            Task { await store.markDone([session], done: !session.markedDone) }
                        } label: {
                            Label(session.markedDone ? "Not Done" : "Done",
                                  systemImage: session.markedDone ? "arrow.uturn.backward" : "checkmark")
                        }
                        .tint(session.markedDone ? Color.gray : Color.green)
                    }
            }
            .contextMenu(forSelectionType: AppSession.ID.self) { ids in
                SelectionMenu(ids: ids)
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
    @Environment(AppStore.self) private var store
    let session: AppSession

    var body: some View {
        let look = SessionLook(session)
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: store.pendingApprovals(for: session).isEmpty ? look.symbol : "hand.raised.fill")
                .foregroundStyle(store.pendingApprovals(for: session).isEmpty ? look.color : Color.orange)
                .font(.body)
                .frame(width: 18)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(session.title)
                        .font(.body.weight(store.needsYou(session) ? .semibold : .regular))
                        .lineLimit(2)
                        .foregroundStyle(session.markedDone ? .secondary : .primary)
                    Spacer(minLength: 4)
                    Text(Elapsed.short(since: session.created))
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 6) {
                    PromptTag(session: session)
                    Text([session.repo, session.channel.isEmpty ? nil : "#\(session.channel)"]
                            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    StatusPill(session: session)
                }
            }
        }
        .padding(.vertical, 5)
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
        MarkDoneButton(sessions: [session])
        Divider()
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

/// A right-click on the list: one session's whole menu, or what can be done to several.
struct SelectionMenu: View {
    @Environment(AppStore.self) private var store
    let ids: Set<AppSession.ID>

    var body: some View {
        let picked = store.sessions.filter { ids.contains($0.id) }
        if picked.count == 1, let session = picked.first {
            SessionMenu(session: session)
        } else if !picked.isEmpty {
            MarkDoneButton(sessions: picked)
        }
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

/// Your totals, as `sidequest stats` prints them, and what you use most.
struct StatsView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Stats").font(.title2.bold())
            if let stats = store.stats {
                Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 8) {
                    GridRow { Text("Sessions in all").foregroundStyle(.secondary); Text("\(stats.total)").monospacedDigit() }
                    GridRow { Text("Today").foregroundStyle(.secondary); Text("\(stats.today)").monospacedDigit() }
                    GridRow { Text("Streak").foregroundStyle(.secondary); Text(stats.streak == 1 ? "1 day" : "\(stats.streak) days").monospacedDigit() }
                    GridRow { Text("Best streak").foregroundStyle(.secondary); Text(stats.bestStreak == 1 ? "1 day" : "\(stats.bestStreak) days").monospacedDigit() }
                }
                HStack(alignment: .top, spacing: 32) {
                    ranking("By prompt", stats.byPrompt ?? [:])
                    ranking("By channel", (stats.byChannel ?? [:]).reduce(into: [:]) { $0["#\($1.key)"] = $1.value })
                }
            } else {
                Text("Start Sidequest to see your stats.").foregroundStyle(.secondary)
            }
            HStack { Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.defaultAction) }
        }
        .padding(20)
        .frame(width: 440)
    }

    private func ranking(_ title: String, _ counts: [String: Int]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(counts.sorted { $0.value > $1.value }.prefix(6), id: \.key) { key, value in
                HStack { Text(key); Spacer(minLength: 12); Text("\(value)").monospacedDigit().foregroundStyle(.secondary) }
            }
        }
        .frame(minWidth: 160, alignment: .leading)
    }
}
