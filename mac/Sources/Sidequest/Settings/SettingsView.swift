import AppKit
import ServiceManagement
import SwiftUI

/// Every option Sidequest has, one tab per part of it. Changes save at once,
/// through the daemon, which checks them against the same schema as
/// config.json and hands them to the Slack overlay.
struct SettingsView: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Group {
            if store.configReply == nil {
                ContentUnavailableView("Sidequest isn't running",
                                       systemImage: "bolt.horizontal.circle",
                                       description: Text("Start it to change its settings."))
                    .frame(width: 560, height: 360)
            } else {
                TabView {
                    GeneralPane().tabItem { Label("General", systemImage: "gearshape") }
                    AgentPane().tabItem { Label("Agent", systemImage: "sparkle") }
                    TerminalPane().tabItem { Label("Terminal", systemImage: "terminal") }
                    SlackPane().tabItem { Label("Slack", systemImage: "number") }
                    ChannelsPane().tabItem { Label("Channels", systemImage: "arrow.left.arrow.right") }
                    PromptsPane().tabItem { Label("Prompts", systemImage: "text.quote") }
                    CleanupPane().tabItem { Label("Clean-up", systemImage: "trash") }
                    SyncPane().tabItem { Label("Sync", systemImage: "arrow.triangle.2.circlepath") }
                    AdvancedPane().tabItem { Label("Advanced", systemImage: "wrench.and.screwdriver") }
                }
                .frame(width: 680, height: 520)
            }
        }
    }
}

extension AppStore {
    /// A setting as a binding: reads the daemon's copy, writes go back through set-config.
    func setting<T: Encodable & Equatable>(_ key: String, _ path: WritableKeyPath<SidequestSettings, T>, fallback: T) -> Binding<T> {
        Binding(
            get: { self.configReply?.config.settings[keyPath: path] ?? fallback },
            set: { value in
                guard self.configReply?.config.settings[keyPath: path] != value else { return }
                self.set(key, value)
            }
        )
    }

    var settings: SidequestSettings? { configReply?.config.settings }
}

/// A text field that saves when you press Return or leave it, not on every keystroke.
struct CommitField: View {
    let title: String
    @Binding var value: String
    var prompt: String = ""
    var monospaced = false
    @State private var draft = ""
    @FocusState private var focused: Bool

    var body: some View {
        TextField(title, text: $draft, prompt: Text(prompt))
            .font(monospaced ? .body.monospaced() : .body)
            .focused($focused)
            .onAppear { draft = value }
            .onChange(of: value) { _, new in if !focused { draft = new } }
            .onChange(of: focused) { _, isFocused in if !isFocused { commit() } }
            .onSubmit(commit)
    }

    private func commit() {
        if draft != value { value = draft }
    }
}

// MARK: General

struct GeneralPane: View {
    @Environment(AppStore.self) private var store
    @Environment(Updater.self) private var updater
    @State private var openAtLogin = SMAppService.mainApp.status == .enabled
    @State private var startsEngine = AppStore.startsEngine

    var body: some View {
        @Bindable var updater = updater
        Form {
            Section {
                Toggle(isOn: $openAtLogin) {
                    Text("Open at login")
                    Text("Sidequest starts with your Mac and keeps Slack connected")
                }
                .onChange(of: openAtLogin) { _, on in
                    do {
                        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
                    } catch {
                        openAtLogin = SMAppService.mainApp.status == .enabled
                    }
                }
                Toggle(isOn: $startsEngine) {
                    Text("Start Sidequest when the app opens")
                    Text("Connects to Slack, opening it if it isn't already. With Open at login, Sidequest is ready as soon as your Mac is")
                }
                .onChange(of: startsEngine) { _, on in AppStore.startsEngine = on }
                LabeledContent {
                    if store.connection == .connected {
                        Button("Stop") { Task { await store.stopDaemon() } }
                    } else {
                        Button("Start") { Task { await store.startDaemon() } }
                    }
                } label: {
                    Text(store.connection == .connected ? "Sidequest is running" : "Sidequest is stopped")
                    if let health = store.health {
                        Text(health.attached == 1 ? "Connected to 1 Slack window" : "Connected to \(health.attached) Slack windows")
                    }
                }
                Toggle(isOn: store.setting("notify", \.notify, fallback: true)) {
                    Text("Notify me when a session needs me")
                    Text("Reply ready, pull request opened or merged, a run failed")
                }
                Toggle(isOn: store.setting("trackStatus", \.trackStatus, fallback: true)) {
                    Text("Follow sessions' progress")
                    Text("Commits and pull requests, checked every 15 seconds. Uses gh for pull requests. Takes effect when Sidequest restarts")
                }
            }
            Section("Updates") {
                LabeledContent {
                    Button(updater.checking ? "Checking…" : "Check Now") { Task { await updater.check() } }
                        .disabled(updater.checking)
                } label: {
                    Text("Sidequest \(BuildInfo.version)")
                    Text(updater.updateAvailable ? "Version \(updater.latest?.version ?? "") is available" : "Up to date")
                }
                if updater.updateAvailable {
                    Button("Update Now") { updater.install() }.buttonStyle(.borderedProminent)
                }
                if updater.installsInApp {
                    Toggle("Install updates automatically", isOn: $updater.installsAutomatically)
                }
                LabeledContent {
                    Button("Update Engine") { Task { await store.updateEngine() } }
                } label: {
                    Text("Engine")
                    Text(store.hello.map { "\($0.version) · \(String($0.build.prefix(7)))" } ?? "Not running")
                }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: Agent

struct AgentPane: View {
    @Environment(AppStore.self) private var store

    private var agent: AgentSetting {
        store.settings?.agent ?? AgentSetting(id: "claude", command: "", args: [])
    }

    private func setAgent(_ change: (inout AgentSetting) -> Void) {
        var next = agent
        change(&next)
        if next != agent { store.set("agent", next) }
    }

    var body: some View {
        let choices = store.configReply?.agents ?? []
        let current = choices.first { $0.id == agent.id }
        Form {
            Section {
                Picker("New sessions use", selection: Binding(get: { agent.id }, set: { id in setAgent { $0 = AgentSetting(id: id, command: "", args: []) } })) {
                    Section("In a terminal") {
                        ForEach(choices.filter { !$0.app }) { Text($0.label).tag($0.id) }
                    }
                    Section("In a desktop app") {
                        ForEach(choices.filter(\.app)) { Text($0.label).tag($0.id) }
                    }
                }
                if let current, let check = store.checks.first(where: { $0.label.hasPrefix(current.label) }) {
                    Label(check.status == "ok" ? "Installed" : (check.detail.isEmpty ? "Not found" : check.detail),
                          systemImage: check.status == "ok" ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                        .foregroundStyle(check.status == "ok" ? .green : .orange)
                        .font(.callout)
                }
                if let current {
                    Text(current.app ? "Opens \(current.host) with the prompt ready. Each prompt can pick its own agent in Prompts."
                                     : "Runs in your terminal. Each prompt can pick its own agent in Prompts.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if current?.app != true {
                Section("Options") {
                    CommitField(title: "Extra arguments", value: Binding(get: { agent.args.joined(separator: " ") },
                                                                          set: { text in setAgent { $0.args = text.split(whereSeparator: \.isWhitespace).map(String.init) } }),
                                prompt: "--model opus", monospaced: true)
                    CommitField(title: "Custom command", value: Binding(get: { agent.command }, set: { text in setAgent { $0.command = text.trimmingCharacters(in: .whitespaces) } }),
                                prompt: "The agent's own, from your PATH", monospaced: true)
                }
                Section {
                    Toggle(isOn: store.setting("skipPermissions", \.skipPermissions, fallback: false)) {
                        Text("Skip permission prompts")
                        Text("Starts the agent with its own flag for acting without asking (--dangerously-skip-permissions for Claude Code). Never synced")
                    }
                    if store.settings?.skipPermissions == true {
                        Label("Whoever wrote the Slack message can now steer an agent that runs commands on your Mac without asking.",
                              systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                            .font(.callout)
                    }
                }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: Terminal

struct TerminalPane: View {
    @Environment(AppStore.self) private var store
    @AppStorage("terminalFontSize") private var terminalFontSize = 13.0

    var body: some View {
        let reply = store.configReply
        let agent = reply?.agents.first { $0.id == store.settings?.agent.id }
        let terminal = store.settings?.terminal ?? "warp"
        let hook = store.checks.first { $0.label == "shell hook" }
        Form {
            if agent?.app == true {
                Section {
                    Text("\(agent?.label ?? "This agent") opens in its own app, so these settings don't apply to it.")
                        .foregroundStyle(.secondary)
                }
            }
            Section {
                Picker("Open sessions in", selection: store.setting("terminal", \.terminal, fallback: "warp")) {
                    ForEach(reply?.terminals ?? []) { choice in
                        Text(choice.id == "headless" && agent?.headless == false ? "\(choice.label) (not with \(agent?.label ?? "this agent"))" : choice.label)
                            .tag(choice.id)
                            .selectionDisabled(choice.id == "headless" && agent?.headless == false)
                    }
                }
                if let summary = reply?.terminals.first(where: { $0.id == terminal })?.summary {
                    Text(summary.prefix(1).uppercased() + summary.dropFirst()).font(.caption).foregroundStyle(.secondary)
                }
                if terminal == "headless", let agent, !agent.headless {
                    Label("\(agent.label) can't run headless. Pick Claude Code, Codex, Gemini CLI, Cursor Agent or Qwen Code in Agent.",
                          systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }
            if terminal == "warp" {
                Section("Warp") {
                    Picker("How to open a tab", selection: store.setting("warpStrategy", \.warpStrategy, fallback: "auto")) {
                        Text("Automatic").tag("auto")
                        Text("Tab config").tag("tab_config")
                        Text("Launch config").tag("launch_config")
                        Text("Plain new tab").tag("new_tab")
                    }
                    Text("Automatic tries a tab config, then a launch config, then a plain tab, until the agent starts.")
                        .font(.caption).foregroundStyle(.secondary)
                    Toggle("Use Warp Preview", isOn: store.setting("warpPreview", \.warpPreview, fallback: false))
                    LabeledContent {
                        Button(hook?.status == "ok" ? "Reinstall" : "Install") { Task { await store.installShellHook() } }
                    } label: {
                        Text("Shell hook")
                        Text(hook?.status == "ok" ? "Installed. Starts the agent when a Warp tab opens on a worktree"
                                                  : "Not installed. Lets sessions start even when Warp ignores a launch config")
                    }
                }
            }
            if terminal == "tmux" {
                Section("tmux") {
                    CommitField(title: "Session for new windows", value: store.setting("tmuxSession", \.tmuxSession, fallback: ""),
                                prompt: "The one you used last")
                }
            }
            if terminal == "headless" {
                Section("Headless") {
                    Text("The agent runs in the background with no terminal. Watch it, see its changes, tell it what to do next, or open it in a terminal tab, all in the session's window. Its answer becomes the reply here and in Slack.")
                        .font(.callout).foregroundStyle(.secondary)
                    Toggle(isOn: store.setting("headlessApprovals", \.headlessApprovals, fallback: false)) {
                        Text("Ask me before commands run")
                        Text("Claude Code only. Instead of refusing what its limits don't allow, it asks you here and in a notification. With the app closed, it's refused as before. Applies to sessions started from now on")
                    }
                    .disabled(agent?.id != "claude" || store.settings?.skipPermissions == true)
                    Stepper(value: $terminalFontSize, in: 9...24) {
                        Text("Terminal tab font size: \(Int(terminalFontSize)) pt")
                    }
                }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: Slack

struct SlackPane: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Form {
            Section {
                Picker("Agent replies", selection: store.setting("postResults", \.postResults, fallback: "ask")) {
                    Text("Ask me first").tag("ask")
                    Text("Post automatically").tag("auto")
                    Text("Off").tag("off")
                }
                Text("The answer the agent writes for the thread. Ask me first shows it here and on the message to edit and post.")
                    .font(.caption).foregroundStyle(.secondary)
                Toggle(isOn: store.setting("autoReply", \.autoReply, fallback: false)) {
                    Text("Say I'm on it")
                    Text("Post \u{201C}Working on a fix.\u{201D} in the thread when a session starts. Each prompt's text is in Prompts")
                }
                Toggle(isOn: store.setting("reactions", \.reactions, fallback: false)) {
                    Text("React on the message")
                    Text("👀 while it works, then ✅ when the reply is posted or the PR merges, or ❌ if a headless run fails")
                }
                Stepper(value: store.setting("threadContextLimit", \.threadContextLimit, fallback: 10), in: 0...50) {
                    Text("Thread messages in the prompt: \(store.settings?.threadContextLimit ?? 10)")
                }
            }
            Section("Connection") {
                Toggle(isOn: store.setting("relaunchSlack", \.relaunchSlack, fallback: true)) {
                    Text("Bring Sidequest back if Slack is reopened")
                    Text("Slack opened from the Dock is restarted with Sidequest attached")
                }
            }
        }
        .formStyle(.grouped)
    }
}

// MARK: Channels

struct ChannelsPane: View {
    @Environment(AppStore.self) private var store
    @State private var adding = false
    @State private var selection: RepoLink.ID?

    private var links: [RepoLink] {
        (store.configReply?.config.channels ?? [:])
            .sorted { $0.key < $1.key }
            .flatMap { key, links in links.map { var l = $0; l.channel = key; return l } }
    }

    var body: some View {
        Form {
            Section {
                Table(links, selection: $selection) {
                    TableColumn("Channel") { link in Text("#\(link.channel)") }
                    TableColumn("Repo") { link in Text(link.repoPath).font(.callout.monospaced()).truncationMode(.head) }
                    TableColumn("Base") { link in
                        CommitField(title: "", value: Binding(get: { link.baseBranch },
                                                             set: { v in Task { await store.updateLink(link, baseBranch: v) } }),
                                    prompt: "default")
                    }
                    .width(90)
                    TableColumn("Label") { link in
                        CommitField(title: "", value: Binding(get: { link.label },
                                                             set: { v in Task { await store.updateLink(link, label: v) } }),
                                    prompt: link.displayLabel)
                    }
                    .width(110)
                }
                .frame(minHeight: 180)
                HStack {
                    Button("Link a Repo…") { adding = true }
                    Button("Unlink") {
                        if let link = links.first(where: { $0.id == selection }) { Task { await store.unlinkRepo(link) } }
                    }
                    .disabled(selection == nil)
                    Button("Make Default") {
                        if let link = links.first(where: { $0.id == selection }) { Task { await store.updateLink(link, makeDefault: true) } }
                    }
                    .disabled(selection == nil)
                    Spacer()
                    Text("A channel's first repo is its default").font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("Finding repos") {
                FolderList(title: "Look for repos in",
                           note: "Used to suggest repos for a channel. Empty means ~/code, ~/src, ~/Developer and similar",
                           folders: store.setting("repoSearchRoots", \.repoSearchRoots, fallback: []))
                Toggle(isOn: store.setting("fetchBeforeCreate", \.fetchBeforeCreate, fallback: true)) {
                    Text("Fetch the base branch first")
                    Text("Starts when the menu opens in Slack, and never holds a session up more than 3 seconds")
                }
            }
        }
        .formStyle(.grouped)
        .sheet(isPresented: $adding) { LinkRepoSheet() }
    }
}

struct LinkRepoSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var channel = ""
    @State private var path = ""

    var body: some View {
        Form {
            TextField("Channel", text: $channel, prompt: Text("storefront-eng"))
            HStack {
                TextField("Repo", text: $path, prompt: Text("~/code/storefront"))
                Button("Choose…") { if let url = FolderPicker.pick() { path = url.path } }
            }
        }
        .formStyle(.grouped)
        .frame(width: 440)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Link") {
                    let name = channel.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "#"))
                    Task { await store.linkRepo(channel: name, path: path); dismiss() }
                }
                .disabled(channel.trimmingCharacters(in: .whitespaces).isEmpty || path.isEmpty)
            }
        }
    }
}

enum FolderPicker {
    @MainActor static func pick() -> URL? {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        return panel.runModal() == .OK ? panel.url : nil
    }
}

/// A list of folders, with Add… and a remove button on each.
struct FolderList: View {
    let title: String
    let note: String
    @Binding var folders: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title)
                Spacer()
                Button("Add…") { if let url = FolderPicker.pick() { folders.append(url.path) } }
            }
            ForEach(folders, id: \.self) { folder in
                HStack {
                    Text(folder).font(.callout.monospaced())
                    Spacer()
                    Button { folders.removeAll { $0 == folder } } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.borderless)
                }
            }
            Text(note).font(.caption).foregroundStyle(.secondary)
        }
    }
}

// MARK: Prompts

struct PromptsPane: View {
    @Environment(AppStore.self) private var store
    @State private var selected: String? = "fix"
    @State private var newKey = ""
    @State private var creating = false

    var body: some View {
        let prompts = store.configReply?.prompts ?? []
        HSplitView {
            List(selection: $selected) {
                ForEach(prompts) { entry in
                    HStack {
                        Text(entry.prompt.label)
                        Spacer()
                        if entry.hidden { Image(systemName: "eye.slash").foregroundStyle(.secondary) }
                    }
                    .tag(entry.key)
                }
            }
            .frame(minWidth: 150, maxWidth: 190)
            .safeAreaInset(edge: .bottom) {
                Button("New Prompt…") { creating = true }.padding(8)
            }
            Group {
                if let entry = prompts.first(where: { $0.key == selected }) {
                    PromptEditor(entry: entry).id(entry.key + entry.prompt.template + String(entry.hidden))
                } else {
                    ContentUnavailableView("Pick a prompt", systemImage: "text.quote")
                }
            }
            .frame(minWidth: 400, maxWidth: .infinity, maxHeight: .infinity)
        }
        .alert("New prompt", isPresented: $creating) {
            TextField("write-test", text: $newKey)
            Button("Create") {
                let key = newKey.lowercased().replacingOccurrences(of: " ", with: "-")
                store.setPrompt(key, PromptOverride(label: newKey, template: "{{message}}\n{{thread}}{{attachments}}"))
                selected = key
                newKey = ""
            }
            Button("Cancel", role: .cancel) { newKey = "" }
        } message: {
            Text("Lowercase letters, digits and dashes. It also names the prompt's branches.")
        }
    }
}

struct PromptEditor: View {
    @Environment(AppStore.self) private var store
    let entry: PromptEntry
    @State private var draft: Prompt
    @State private var hidden: Bool

    static let tokens = ["author", "channel", "message", "thread", "permalink", "date", "branch", "baseBranch",
                         "repo", "worktree", "ticket", "ticketId", "question", "attachments"]

    init(entry: PromptEntry) {
        self.entry = entry
        _draft = State(initialValue: entry.prompt)
        _hidden = State(initialValue: entry.hidden)
    }

    var body: some View {
        let agents = store.configReply?.agents ?? []
        Form {
            Section {
                TextField("Label", text: $draft.label)
                TextField("Emoji", text: $draft.emoji, prompt: Text("wrench"))
                Toggle("Show in the Slack menu", isOn: Binding(get: { !hidden }, set: { hidden = !$0 }))
                Picker("Agent", selection: $draft.agent) {
                    Text("Default").tag("")
                    ForEach(agents) { Text($0.label).tag($0.id) }
                }
                TextField("Branch prefix", text: $draft.branchPrefix)
                TextField("Thread reply", text: $draft.reply, prompt: Text("Posted when it starts, if Say I'm on it is on"))
            }
            Section("Template") {
                TextEditor(text: $draft.template)
                    .font(.callout.monospaced())
                    .frame(minHeight: 120)
                FlowTokens(tokens: Self.tokens) { token in draft.template += "{{\(token)}}" }
            }
            Section {
                HStack {
                    Button(entry.builtIn ? "Reset to Default" : "Delete Prompt", role: entry.builtIn ? nil : .destructive) {
                        store.setPrompt(entry.key, nil)
                    }
                    Spacer()
                    Button("Save") { save() }
                        .buttonStyle(.borderedProminent)
                        .disabled(draft == entry.prompt && hidden == entry.hidden)
                }
            }
        }
        .formStyle(.grouped)
    }

    private func save() {
        store.setPrompt(entry.key, PromptOverride(
            label: draft.label,
            emoji: draft.emoji,
            template: draft.template,
            branchPrefix: draft.branchPrefix,
            reply: draft.reply,
            hidden: hidden ? true : nil,
            agent: draft.agent
        ))
    }
}

/// Template tokens as chips; click one to add it.
struct FlowTokens: View {
    let tokens: [String]
    let insert: (String) -> Void

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 88), spacing: 4)], alignment: .leading, spacing: 4) {
            ForEach(tokens, id: \.self) { token in
                Button(token) { insert(token) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .font(.caption.monospaced())
            }
        }
    }
}

// MARK: Clean-up

struct CleanupPane: View {
    @Environment(AppStore.self) private var store
    @State private var outcome: String?
    @State private var removable: Int?

    var body: some View {
        Form {
            Section {
                HStack {
                    CommitField(title: "Worktrees folder", value: store.setting("worktreesRoot", \.worktreesRoot, fallback: ""), monospaced: true)
                    Button("Choose…") { if let url = FolderPicker.pick() { store.set("worktreesRoot", url.path) } }
                }
                Toggle(isOn: store.setting("autoClean", \.autoClean, fallback: false)) {
                    Text("Clean up automatically")
                    Text("Every six hours, remove merged worktrees nobody has touched for a while")
                }
                Stepper(value: store.setting("autoCleanAfterDays", \.autoCleanAfterDays, fallback: 7), in: 0...365) {
                    Text("Untouched for \(Int(store.settings?.autoCleanAfterDays ?? 7)) days")
                }
                .disabled(store.settings?.autoClean != true)
                Toggle(isOn: store.setting("pruneBranchesOnClean", \.pruneBranchesOnClean, fallback: true)) {
                    Text("Delete merged branches too")
                    Text("A branch with commits that aren't merged is always kept")
                }
            }
            Section {
                HStack {
                    Text(outcome ?? cleanupSummary)
                        .font(.callout).foregroundStyle(.secondary)
                    Spacer()
                    Button("Clean Up Now") {
                        Task {
                            if let reply = await store.cleanUp() {
                                outcome = "Removed \(reply.removed), kept \(reply.kept)."
                                removable = await store.cleanPreview()
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        .formStyle(.grouped)
        .task { removable = await store.cleanPreview() }
    }

    private var cleanupSummary: String {
        let rule = "Removes worktrees whose branch is merged. Uncommitted work is never deleted."
        switch removable {
        case .none: return rule
        case .some(0): return "Nothing finished to remove. " + rule
        case .some(1): return "1 finished session can be removed. " + rule
        case .some(let n): return "\(n) finished sessions can be removed. " + rule
        }
    }
}

// MARK: Sync

struct SyncPane: View {
    @Environment(AppStore.self) private var store
    @State private var status: SyncStatus?

    var body: some View {
        Form {
            Section {
                Toggle(isOn: store.setting("sync", \.sync, fallback: false)) {
                    Text("Sync with my other Macs")
                    Text("Through a pinned message in your DM with yourself in Slack. No server or account")
                }
                if store.settings?.sync == true {
                    LabeledContent("Last synced") {
                        Text(lastSynced).foregroundStyle(.secondary)
                    }
                    if let waiting = status?.waiting, !waiting.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Waiting for a clone on this Mac")
                            ForEach(waiting, id: \.self) { link in
                                Text("#\(link.channel) → \(link.repo)").font(.callout.monospaced()).foregroundStyle(.secondary)
                            }
                            Text("Each links itself once you clone it where Sidequest looks for repos.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            Section("What syncs") {
                Text("Channel links (matched by git remote), prompts, the agent and its arguments, fetching, thread messages, clean-up, Say I'm on it, reactions and agent replies.")
                    .font(.callout)
            }
            Section("What stays on this Mac") {
                Text("Terminal settings, folders, Slack connection settings, skip permission prompts, approvals, and your session history.")
                    .font(.callout)
            }
        }
        .formStyle(.grouped)
        .task(id: store.settings?.sync) {
            // Checked every two minutes by the daemon; looked at again here while the tab is open.
            while !Task.isCancelled {
                status = await store.syncStatus()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    private var lastSynced: String {
        guard let status, let date = ISODate.parse(status.syncedAt) else { return "Not yet" }
        let when = date.formatted(.relative(presentation: .named))
        return status.from.isEmpty ? when : "\(when), last changed on \(status.from)"
    }
}

// MARK: Advanced

struct AdvancedPane: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        Form {
            Section {
                CommitField(title: "DevTools port",
                            value: Binding(get: { String(store.settings?.cdpPort ?? 9222) },
                                           set: { if let port = Int($0) { store.set("cdpPort", port) } }),
                            monospaced: true)
                Text("Where Sidequest connects to Slack. Changing it restarts Slack on the next start.")
                    .font(.caption).foregroundStyle(.secondary)
                CommitField(title: "Slack window pattern", value: store.setting("targetUrlPattern", \.targetUrlPattern, fallback: ""), monospaced: true)
                Toggle(isOn: store.setting("verbose", \.verbose, fallback: false)) {
                    Text("Log overlay activity")
                    Text("To Slack's developer console")
                }
            }
            Section {
                HStack {
                    Button("Run Checks") {
                        Task { await store.runChecks() }
                        store.showChecks = true
                    }
                    Button("Open Log") { NSWorkspace.shared.open(URL(fileURLWithPath: Paths.log)) }
                    Button("Open Config File") { NSWorkspace.shared.open(URL(fileURLWithPath: Paths.config)) }
                }
            }
        }
        .formStyle(.grouped)
    }
}
