import AppKit
import SwiftUI

/// One session: the message it came from, how far it has got, the reply to post, and what to tell it next.
struct SessionDetailView: View {
    @Environment(AppStore.self) private var store
    let session: AppSession

    @State private var reply: ResultReply?
    @State private var draft = ""
    @State private var followUp = ""
    @State private var tab: WorkspaceTab = .conversation
    @State private var logTail: [String] = []
    @FocusState private var replyFocused: Bool
    @FocusState private var followUpFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            if session.headless {
                workspace
            } else {
                ScrollView { overview.padding(20).frame(maxWidth: 760, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading) }
            }
            if tab != .terminal || !session.headless {
                Divider()
                composer
            }
        }
        .toolbar { toolbar }
        .task(id: session.resultMs) { await loadReply() }
        .task(id: session.id) {
            // A headless run is watched as it goes: often while it runs, now and then after.
            guard session.headless else { return }
            while !Task.isCancelled {
                await store.loadTranscript(session)
                try? await Task.sleep(for: .seconds(session.running ? 1.5 : 6))
            }
        }
        .onChange(of: store.focusFollowUp) { _, wanted in
            if wanted { tab = .conversation; followUpFocused = true; store.focusFollowUp = false }
        }
        .task(id: "\(session.id)-\(session.state)") {
            logTail = session.state == "failed" ? await store.logTail(session) : []
        }
        .onChange(of: store.focusReply) { _, wanted in
            if wanted { replyFocused = true; store.focusReply = false }
        }
    }

    /// The message, its progress, and the reply: the whole view for a terminal session.
    private var overview: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            if !session.message.isEmpty { quote }
            ProgressTrack(session: session).card()
            if session.resultPending || reply != nil { replyCard }
            if session.state == "failed" { failureCard }
            facts
        }
    }

    /// A headless session: the conversation, its changes, or a terminal on it.
    private var workspace: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                header
                Picker("View", selection: $tab) {
                    ForEach(WorkspaceTab.allCases) { tab in Text(tab.rawValue).tag(tab) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(maxWidth: 360)
            }
            .padding([.horizontal, .top], 20)
            .padding(.bottom, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            Divider()
            switch tab {
            case .conversation:
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            if !session.message.isEmpty { quote }
                            TranscriptView(session: session)
                            if session.resultPending || reply != nil { replyCard }
                            if session.state == "failed" { failureCard }
                            Color.clear.frame(height: 1).id("end")
                        }
                        .padding(20)
                        .frame(maxWidth: 760, alignment: .leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .onChange(of: store.transcripts[session.branch]?.count ?? 0) { _, _ in
                        withAnimation { proxy.scrollTo("end", anchor: .bottom) }
                    }
                }
            case .changes:
                ChangesView(session: session)
            case .terminal:
                TerminalTab(session: session)
            }
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    PromptTag(session: session)
                    StatusPill(session: session)
                }
                Text(session.title)
                    .font(.title3.weight(.semibold))
                    .lineLimit(3)
                    .textSelection(.enabled)
                Text(metaLine).font(.callout).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            HStack(spacing: 8) {
                MarkDoneButton(sessions: [session])
                    .help(session.markedDone ? "Put it back in Working" : "Nothing left to do here: move it to Done")
                if let step = nextStep {
                    Button(step.title) { perform(step) }
                        .buttonStyle(.borderedProminent)
                }
            }
            .controlSize(.regular)
            .fixedSize()
        }
    }

    /// The one thing to do next, which follows where the session has got to.
    private enum NextStep {
        case answer, reviewReply, stop, runAgain, reopen, terminal, openPR
        case viewPR(Int)

        var title: String {
            switch self {
            case .answer: return "Answer Its Question"
            case .reviewReply: return "Review Reply"
            case .stop: return "Stop"
            case .runAgain: return "Run Again"
            case .reopen: return "Open in Terminal"
            case .terminal: return "Open Terminal"
            case .openPR: return "Open Pull Request"
            case .viewPR(let number): return "View PR #\(number)"
            }
        }
    }

    private var nextStep: NextStep? {
        if !store.pendingApprovals(for: session).isEmpty { return .answer }
        // Done is done: the next step is whatever you pick, not a button asking for it.
        if session.markedDone { return nil }
        if session.resultPending { return .reviewReply }
        if session.headless && session.running { return .stop }
        if session.state == "failed" { return session.headless ? .runAgain : .reopen }
        if let pr = session.pr, session.state == "pr-open" { return .viewPR(pr.number) }
        if session.commits > 0 && session.pr == nil { return .openPR }
        if session.state == "merged" || session.state == "gone" { return nil }
        return session.headless ? .terminal : .reopen
    }

    private func perform(_ step: NextStep) {
        switch step {
        case .answer:
            tab = .conversation
        case .reviewReply:
            tab = .conversation
            replyFocused = true
        case .stop:
            Task { await store.stopRun(session) }
        case .runAgain:
            Task { await store.runAgain(session) }
        case .reopen:
            Task { await store.reopen(session) }
        case .terminal:
            tab = .terminal
        case .openPR, .viewPR:
            Task { await store.openPullRequest(session) }
        }
    }

    private var metaLine: String {
        var parts = [session.repo]
        if !session.channel.isEmpty { parts.append("#\(session.channel)") }
        if let created = session.created {
            parts.append("started \(created.formatted(.relative(presentation: .named)))")
        }
        if let done = session.doneAt.flatMap(ISODate.parse) {
            parts.append("done \(done.formatted(.relative(presentation: .named)))")
        }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var quote: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(session.author.isEmpty ? "From Slack" : "@\(session.author)", systemImage: "quote.bubble")
                    .font(.callout.weight(.semibold))
                Spacer()
                if let url = URL(string: session.permalink), !session.permalink.isEmpty {
                    Link("View in Slack", destination: url).font(.caption)
                }
            }
            Text(session.message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled).lineLimit(8)
        }
        .card()
    }

    private var replyCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Reply to the thread, as you").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(reply.map { "Written by \($0.agent)" } ?? "").font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            Divider()
            TextEditor(text: $draft)
                .font(.body)
                .frame(minHeight: 140)
                .scrollContentBackground(.hidden)
                .padding(8)
                .focused($replyFocused)
            Divider()
            HStack {
                if store.health?.attached == 0 {
                    Text("Open Slack to post").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Don't Post") { Task { await store.dismissReply(session); reply = nil } }
                Button("Post in Thread") { Task { await store.postReply(session, text: draft) } }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.health?.attached == 0)
            }
            .padding(10)
        }
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.quaternary))
    }

    private var failureCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(session.exitCode.map { "The agent stopped with exit code \($0)" } ?? "The agent stopped with an error",
                  systemImage: "xmark.octagon.fill")
                .foregroundStyle(.red)
                .font(.callout.weight(.semibold))
            if logTail.isEmpty {
                Text("Its log is in .sidequest/agent.log in the worktree.").font(.caption).foregroundStyle(.secondary)
            } else {
                Text(logTail.joined(separator: "\n"))
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.background, in: RoundedRectangle(cornerRadius: 6))
            }
            HStack {
                Button("Show Log") {
                    let log = (session.worktreePath as NSString).appendingPathComponent(".sidequest/agent.log")
                    NSWorkspace.shared.open(URL(fileURLWithPath: log))
                }
                if session.headless {
                    Button("Run Again") { Task { await store.runAgain(session) } }
                    Button("Open Terminal Tab") { tab = .terminal }
                } else {
                    Button("Open in Terminal") { Task { await store.reopen(session) } }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }

    private var facts: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Details").font(.headline)
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 7) {
                fact("Branch", session.branch)
                if !session.baseBranch.isEmpty { fact("Cut from", session.baseBranch) }
                fact("Changes", [session.commits == 1 ? "1 commit" : "\(session.commits) commits", session.dirty ? "uncommitted changes" : "clean"].joined(separator: " · "))
                if !session.agent.isEmpty { fact("Agent", session.agent) }
                fact("Worktree", session.worktreePath)
            }
            .font(.callout)
        }
        .card()
    }

    private func fact(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary).gridColumnAlignment(.trailing)
            Text(value).font(.callout.monospaced()).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
        }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField(session.headless ? "Tell it what to do next…" : "Follow up: tell the session what to do next…", text: $followUp, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
                .focused($followUpFocused)
                .onSubmit(sendFollowUp)
            Button("Send", action: sendFollowUp)
                .disabled(followUp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.state == "gone" || session.running)
        }
        .padding(12)
    }

    private func sendFollowUp() {
        let text = followUp.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        followUp = ""
        Task { await store.followUp(session, text: text) }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            if let health = store.health {
                Label("\(health.agent.label) in \(health.agent.host)", systemImage: health.attached > 0 ? "circle.fill" : "circle")
                    .labelStyle(.titleAndIcon)
                    .foregroundStyle(.secondary)
                    .font(.caption)
            }
        }
        ToolbarItemGroup(placement: .primaryAction) {
            if session.headless {
                if session.running {
                    Button { Task { await store.stopRun(session) } } label: { Label("Stop", systemImage: "stop.circle") }
                        .help("Stop the background run; the worktree stays")
                } else {
                    Button { Task { await store.runAgain(session) } } label: { Label("Run Again", systemImage: "arrow.clockwise") }
                        .help("Run the session's prompt again in the background")
                }
                Button { tab = .terminal } label: { Label("Terminal", systemImage: "terminal") }
                    .help("Open the agent here, carrying on the conversation")
            } else {
                Button { Task { await store.reopen(session) } } label: { Label("Open in Terminal", systemImage: "terminal") }
                    .help("Open this session in its terminal")
            }
            if session.pr != nil || session.commits > 0 {
                Button { Task { await store.openPullRequest(session) } } label: {
                    Label(session.pr.map { "PR #\($0.number)" } ?? "Open PR", systemImage: "arrow.triangle.pull")
                }
            }
            Menu { SessionMenu(session: session) } label: { Label("More", systemImage: "ellipsis.circle") }
        }
    }

    private func loadReply() async {
        guard session.resultMs != nil else { reply = nil; return }
        reply = await store.reply(for: session)
        draft = reply?.text ?? ""
    }
}

/// Started → commits → reply → pull request → merged, filled as far as the session has got.
/// A question (Investigate, Review, Ask) that has committed nothing is just started → reply → done.
struct ProgressTrack: View {
    let session: AppSession

    private struct Step {
        var label: String
        var reached: Bool
    }

    private var answersOnly: Bool {
        session.commits == 0 && session.pr == nil && ["investigate", "review", "ask"].contains(session.promptKey)
    }

    private var steps: [Step] {
        let reply = Step(label: session.resultPending ? "Reply ready" : "Reply", reached: session.resultMs != nil)
        if answersOnly {
            return [Step(label: "Started", reached: true), reply, Step(label: "Done", reached: session.markedDone || session.state == "gone")]
        }
        let committed = session.commits > 0 || ["pr-open", "pr-closed", "merged"].contains(session.state)
        let merged = session.state == "merged"
        return [
            Step(label: "Started", reached: true),
            Step(label: committed ? (session.commits == 1 ? "1 commit" : "\(max(session.commits, 1)) commits") : "Commits", reached: committed),
            reply,
            Step(label: session.pr.map { "PR #\($0.number)" } ?? "PR", reached: session.pr != nil),
            Step(label: session.markedDone && !merged ? "Done" : "Merged", reached: merged || session.markedDone),
        ]
    }

    var body: some View {
        HStack(spacing: 8) {
            ForEach(steps.indices, id: \.self) { index in
                let step = steps[index]
                if index > 0 {
                    Capsule()
                        .fill(step.reached ? Color.accentColor : Color.secondary.opacity(0.25))
                        .frame(minWidth: 12, maxWidth: .infinity, minHeight: 2, maxHeight: 2)
                }
                HStack(spacing: 5) {
                    Image(systemName: step.reached ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(step.reached ? Color.accentColor : Color.secondary.opacity(0.6))
                    Text(step.label)
                        .font(.callout)
                        .foregroundStyle(step.reached ? .primary : .secondary)
                        .fixedSize()
                }
            }
        }
    }
}
