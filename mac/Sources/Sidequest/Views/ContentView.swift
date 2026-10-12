import AppKit
import SwiftUI

/// The main window: your sessions on the left, grouped by what needs you, and the one you picked on the right.
struct ContentView: View {
    @Environment(AppStore.self) private var store
    @Environment(Updater.self) private var updater
    @Environment(Appearance.self) private var appearance
    @Environment(\.openSettings) private var openSettings
    @Environment(\.openWindow) private var openWindow
    @Environment(\.theme) private var theme
    @State private var showAppearance = false

    var body: some View {
        @Bindable var store = store
        NavigationSplitView {
            SessionListView()
                .navigationSplitViewColumnWidth(min: 300, ideal: 340, max: 440)
        } detail: {
            Group {
                if let session = store.selectedSession {
                    SessionDetailView(session: session)
                        .id(session.id)
                } else if store.selection.count > 1 {
                    SelectionDetailView()
                } else {
                    EmptyDetailView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(theme.detailSurface ?? Color.clear)
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showAppearance.toggle() } label: {
                    Label("Appearance", systemImage: "paintpalette")
                }
                .help("Choose the app's colours")
                .popover(isPresented: $showAppearance, arrowEdge: .bottom) {
                    AppearanceEditor()
                        .frame(width: 380, height: 560)
                        .themed()
                        .environment(appearance)
                }
            }
        }
        .onAppear {
            SettingsOpener.action = openSettings
            updater.showWindow = { [openWindow] in openWindow(id: UpdateView.windowID) }
        }
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

/// The sessions, grouped into what needs you, what is working and what is done, with a filter bar and a
/// repo picker above them and your streak below.
///
/// The list keeps its own selection rather than the system's, so the picked row wears the accent you chose:
/// a click picks one, ⌘-click adds or removes one, ⇧-click picks a run, and the arrow keys move.
struct SessionListView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.theme) private var theme
    /// Where a ⇧-click run starts.
    @State private var anchor: AppSession.ID?
    @FocusState private var focused: Bool

    var body: some View {
        @Bindable var store = store
        ScrollViewReader { proxy in
            List {
                ForEach(store.sections) { section in
                    Section {
                        ForEach(section.sessions) { session in
                            row(session)
                        }
                    } header: {
                        GroupHeader(group: section.group, count: section.sessions.count)
                    }
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(theme.listSurface == nil ? .automatic : .hidden)
            .background(theme.listSurface ?? Color.clear)
            .focusable()
            .focusEffectDisabled()
            .focused($focused)
            .onKeyPress(.downArrow) { move(1, proxy); return .handled }
            .onKeyPress(.upArrow) { move(-1, proxy); return .handled }
        }
        .overlay {
            if store.visibleSessions.isEmpty {
                ContentUnavailableView(store.filter == .needsYou ? "Nothing needs you" : "No sessions here",
                                       systemImage: store.filter == .needsYou ? "checkmark.seal" : "tray")
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                ForEach(store.banners) { banner in
                    BannerView(banner: banner)
                }
                VStack(spacing: 8) {
                    FilterBar()
                    RepoPicker()
                }
                .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 6)
            }
            .background(theme.listSurface.map { AnyShapeStyle($0) } ?? AnyShapeStyle(Material.bar))
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            StreakCard()
        }
        .navigationTitle(store.filter.title)
        .searchable(text: $store.search, placement: .toolbar)
    }

    private func row(_ session: AppSession) -> some View {
        let selected = store.selection.contains(session.id)
        return SessionRow(session: session)
            .contentShape(Rectangle())
            .onTapGesture { click(session) }
            .listRowBackground(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(selected ? theme.selection : Color.clear)
                    .padding(.horizontal, 8)
            )
            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                Button {
                    Task { await store.markDone([session], done: !session.markedDone) }
                } label: {
                    Label(session.markedDone ? "Not Done" : "Done",
                          systemImage: session.markedDone ? "arrow.uturn.backward" : "checkmark")
                }
                .tint(session.markedDone ? Color.gray : Color.green)
            }
            .contextMenu {
                if selected && store.selection.count > 1 {
                    SelectionMenu(ids: store.selection)
                } else {
                    SessionMenu(session: session)
                }
            }
            .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
            .accessibilityAction { click(session) }
    }

    /// The visible sessions top to bottom, as the arrow keys and ⇧-click walk them.
    private var order: [AppSession.ID] { store.sections.flatMap { $0.sessions.map(\.id) } }

    private func click(_ session: AppSession) {
        focused = true
        let flags = NSEvent.modifierFlags
        if flags.contains(.command) {
            if store.selection.contains(session.id) { store.selection.remove(session.id) } else { store.selection.insert(session.id) }
            anchor = session.id
        } else if flags.contains(.shift), let anchor, let from = order.firstIndex(of: anchor), let to = order.firstIndex(of: session.id) {
            store.selection = Set(order[min(from, to)...max(from, to)])
        } else {
            store.selection = [session.id]
            anchor = session.id
        }
    }

    private func move(_ step: Int, _ proxy: ScrollViewProxy) {
        let ids = order
        guard !ids.isEmpty else { return }
        let current = (store.selection.count == 1 ? store.selection.first : anchor).flatMap { ids.firstIndex(of: $0) }
        let next = current.map { min(max($0 + step, 0), ids.count - 1) } ?? (step > 0 ? 0 : ids.count - 1)
        store.selection = [ids[next]]
        anchor = ids[next]
        proxy.scrollTo(ids[next])
    }
}

/// A group's name in its tone, with how many it holds.
struct GroupHeader: View {
    @Environment(\.theme) private var theme
    let group: SessionGroup
    let count: Int

    var body: some View {
        HStack(spacing: 6) {
            Text(group.title.uppercased())
                .foregroundStyle(group.tone == .neutral ? Color.secondary : theme.text(group.tone))
            Text("\(count)").foregroundStyle(.secondary).monospacedDigit()
        }
        .font(.caption.weight(.semibold))
        .tracking(0.4)
    }
}

/// Needs you, Working, Done or All, each with its count.
struct FilterBar: View {
    @Environment(AppStore.self) private var store
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 2) {
            ForEach(SessionFilter.allCases, id: \.self) { filter in
                let on = store.filter == filter
                Button { store.filter = filter } label: {
                    HStack(spacing: 4) {
                        Text(filter.short)
                        Text("\(store.count(filter))")
                            .monospacedDigit()
                            .foregroundStyle(filter == .needsYou && store.count(filter) > 0 ? theme.text(.needsYou) : Color.secondary)
                    }
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, minHeight: 24)
                    .background(on ? Color(nsColor: .controlBackgroundColor) : Color.clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .shadow(color: on ? .black.opacity(0.12) : .clear, radius: 1, y: 0.5)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(on ? Color.primary : Color.secondary)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(2)
        .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

/// Every repo, or one.
struct RepoPicker: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        @Bindable var store = store
        if store.repos.count > 1 || store.repoFilter != nil {
            Picker(selection: $store.repoFilter) {
                Text("All repos").tag(String?.none)
                Divider()
                ForEach(store.repos, id: \.self) { repo in
                    Text(repo).tag(Optional(repo))
                }
            } label: {
                Label("Repo", systemImage: "folder").foregroundStyle(.secondary)
            }
            .pickerStyle(.menu)
            .controlSize(.small)
        }
    }
}

/// Your day streak; a click shows the rest of your stats.
struct StreakCard: View {
    @Environment(AppStore.self) private var store
    @Environment(\.theme) private var theme

    var body: some View {
        if let stats = store.stats {
            Button { store.showStats = true } label: {
                HStack(spacing: 10) {
                    Image(systemName: "flame.fill")
                        .foregroundStyle(stats.streak > 0 ? Color.orange : Color.secondary)
                        .font(.title3)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(stats.streak == 1 ? "1-day streak" : "\(stats.streak)-day streak")
                            .font(.callout.weight(.semibold))
                        Text("\(stats.today) today · best is \(stats.bestStreak == 1 ? "1 day" : "\(stats.bestStreak) days")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Text("Stats").font(.caption).foregroundStyle(theme.accentText)
                }
                .padding(10)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.quaternary))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(10)
            .help("Show stats")
        }
    }
}

/// A session in the list: its state, its message, where it came from, and what it is waiting on.
struct SessionRow: View {
    @Environment(AppStore.self) private var store
    @Environment(\.theme) private var theme
    let session: AppSession

    var body: some View {
        let look = SessionLook(session)
        let needsYou = store.needsYou(session)
        let asking = !store.pendingApprovals(for: session).isEmpty
        HStack(alignment: .top, spacing: 10) {
            StatusDot(tone: asking ? .needsYou : look.tone)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(session.title)
                        .font(.body.weight(needsYou ? .semibold : .regular))
                        .lineLimit(2)
                        .foregroundStyle(store.group(of: session) == .done ? Color.secondary : Color.primary)
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
                }
                if let hint {
                    Text(hint)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(needsYou ? theme.text(asking ? .needsYou : look.tone) : Color.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 5)
    }

    /// What it is waiting on, in a few words; nil when the state already says it all.
    private var hint: String? {
        if let approval = store.pendingApprovals(for: session).first { return "\(approval.tool) wants to run" }
        if session.markedDone { return nil }
        if session.resultPending { return session.pr.map { "Reply ready to review · PR #\($0.number)" } ?? "Reply ready to review" }
        if session.state == "failed" { return session.exitCode.map { "Stopped with exit code \($0)" } ?? "Stopped with an error" }
        if session.headless && session.running { return "Running in the background" }
        if session.state == "committed" && session.pr == nil {
            return session.commits == 1 ? "1 commit, no pull request yet" : "\(session.commits) commits, no pull request yet"
        }
        return nil
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
