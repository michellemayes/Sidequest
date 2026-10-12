import AppKit
import SwiftUI

/// One session: what it wants from you first (a reply to post, a question, a failure), then the message it
/// came from and everything it has done, with its details at the side and a box to tell it what to do next.
struct SessionDetailView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.theme) private var theme
    let session: AppSession

    @State private var reply: ResultReply?
    @State private var draft = ""
    @State private var followUp = ""
    @State private var tab: WorkspaceTab = .overview
    @State private var logTail: [String] = []
    @State private var width: CGFloat = 0
    @FocusState private var replyFocused: Bool
    @FocusState private var followUpFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                header
                if session.headless {
                    Picker("View", selection: $tab) {
                        ForEach(WorkspaceTab.allCases) { tab in Text(tab.rawValue).tag(tab) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(maxWidth: 440)
                }
            }
            .padding(.horizontal, 24).padding(.top, 20).padding(.bottom, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            Divider()
            switch session.headless ? tab : .overview {
            case .overview:
                ScrollView { overview }
            case .conversation:
                conversation
            case .changes:
                ChangesView(session: session)
            case .terminal:
                TerminalTab(session: session)
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
            if wanted {
                if tab == .terminal { tab = .overview }
                followUpFocused = true
                store.focusFollowUp = false
            }
        }
        .task(id: "\(session.id)-\(session.state)") {
            logTail = session.state == "failed" ? await store.logTail(session) : []
        }
        .onChange(of: store.focusReply) { _, wanted in
            if wanted { tab = .overview; replyFocused = true; store.focusReply = false }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    PromptTag(session: session)
                    StatusPill(session: session)
                }
                Text(session.title)
                    .font(.title2.weight(.semibold))
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
                Menu { SessionMenu(session: session) } label: { Image(systemName: "ellipsis") }
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .help("More")
                    .accessibilityLabel("More actions")
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
            tab = .overview
        case .reviewReply:
            tab = .overview
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

    // MARK: Overview

    /// What needs you and the story so far, with the details beside them when there is room and below when not.
    private var overview: some View {
        Group {
            if width >= 680 {
                HStack(alignment: .top, spacing: 28) {
                    mainColumn.frame(maxWidth: 720, alignment: .leading)
                    rail.frame(width: 230)
                }
            } else {
                VStack(alignment: .leading, spacing: 24) {
                    mainColumn
                    rail
                }
            }
        }
        .padding(.horizontal, 24).padding(.vertical, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(GeometryReader { proxy in
            Color.clear
                .onAppear { width = proxy.size.width }
                .onChange(of: proxy.size.width) { _, new in width = new }
        })
    }

    private var mainColumn: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(store.pendingApprovals(for: session)) { approval in
                ApprovalCard(approval: approval)
            }
            if session.resultPending || reply != nil { replyCard }
            if session.state == "failed" { failureCard }
            if session.headless && session.running { liveCard }
            if !session.message.isEmpty { quote }
            ActivityTimeline(session: session)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var replyCard: some View {
        let pending = session.resultPending && !session.markedDone
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                if pending {
                    Text("YOUR TURN")
                        .font(.caption.weight(.bold))
                        .tracking(0.6)
                        .foregroundStyle(theme.text(.needsYou))
                }
                Text("Reply to the thread, as you").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(reply.map { "Written by \($0.agent)" } ?? "").font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            Divider()
            TextEditor(text: $draft)
                .font(.body)
                .frame(minHeight: 120)
                .scrollContentBackground(.hidden)
                .padding(10)
                .background(Color(nsColor: .textBackgroundColor))
                .focused($replyFocused)
            Divider()
            HStack(spacing: 8) {
                if store.health?.attached == 0 {
                    Text("Open Slack to post").font(.caption).foregroundStyle(.secondary)
                } else if !session.channel.isEmpty {
                    Text("Posts in #\(session.channel)\(session.author.isEmpty ? "" : " under @\(session.author)'s message")")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Don't Post") { Task { await store.dismissReply(session); reply = nil } }
                Button("Post in Thread") { Task { await store.postReply(session, text: draft) } }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.health?.attached == 0)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
        }
        .background(pending ? theme.fill(.needsYou).opacity(0.05) : Color.clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(pending ? theme.fill(.needsYou).opacity(0.45) : Color.secondary.opacity(0.25), lineWidth: pending ? 1.5 : 1)
        )
    }

    private var failureCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(session.exitCode.map { "The agent stopped with exit code \($0)" } ?? "The agent stopped with an error",
                  systemImage: "xmark.octagon.fill")
                .foregroundStyle(theme.text(.failed))
                .font(.callout.weight(.semibold))
            if logTail.isEmpty {
                Text("Its log is in .sidequest/agent.log in the worktree.").font(.caption).foregroundStyle(.secondary)
            } else {
                Text(logTail.joined(separator: "\n"))
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.background, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(theme.fill(.failed).opacity(0.2)))
            }
            HStack {
                if session.headless {
                    Button("Run Again") { Task { await store.runAgain(session) } }
                        .buttonStyle(.borderedProminent)
                }
                Button("Show Log") {
                    let log = (session.worktreePath as NSString).appendingPathComponent(".sidequest/agent.log")
                    NSWorkspace.shared.open(URL(fileURLWithPath: log))
                }
                if session.headless {
                    Button("Open Terminal Tab") { tab = .terminal }
                } else {
                    Button("Open in Terminal") { Task { await store.reopen(session) } }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.fill(.failed).opacity(0.07), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(theme.fill(.failed).opacity(0.3)))
    }

    /// A headless run going right now: the last few things it did, and a way into the whole conversation.
    private var liveCard: some View {
        let recent = (store.transcripts[session.branch] ?? []).filter { $0.kind == "tool" || $0.kind == "agent" }.suffix(3)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                StatusDot(tone: .working)
                Text("Running in the background").font(.callout.weight(.semibold)).foregroundStyle(theme.text(.working))
                Spacer()
                Button("Open Conversation") { tab = .conversation }
                    .controlSize(.small)
            }
            if recent.isEmpty {
                Text("Starting…").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(Array(recent.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(item.kind == "tool" ? (item.tool ?? "Tool") : "Said")
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .foregroundStyle(theme.text(.working))
                        .background(theme.fill(.working).opacity(0.14), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                    Text(item.text)
                        .font(item.kind == "tool" ? Font.caption.monospaced() : Font.caption)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.fill(.working).opacity(0.06), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(theme.fill(.working).opacity(0.25)))
    }

    private var quote: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Text(session.author.first.map { String($0).uppercased() } ?? "#")
                    .font(.callout.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 26, height: 26)
                    .background(Color.secondary.opacity(0.55), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    .accessibilityHidden(true)
                Text(session.author.isEmpty ? "From Slack" : "@\(session.author)").font(.callout.weight(.semibold))
                if !session.channel.isEmpty {
                    Text("in #\(session.channel)").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if let url = URL(string: session.permalink), !session.permalink.isEmpty {
                    Link("View in Slack", destination: url).font(.caption).foregroundStyle(theme.accentText)
                }
            }
            Text(session.message).font(.body).textSelection(.enabled).lineLimit(10)
        }
        .card()
    }

    // MARK: Side rail

    private var rail: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 10) {
                railHeading("Details")
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 7) {
                    fact("Branch", session.branch, mono: true)
                    if !session.baseBranch.isEmpty { fact("Cut from", session.baseBranch, mono: true) }
                    fact("Changes", [session.commits == 1 ? "1 commit" : "\(session.commits) commits", session.dirty ? "uncommitted changes" : "clean"].joined(separator: " · "))
                    if !session.agent.isEmpty { fact("Agent", session.agent) }
                    if !session.repo.isEmpty { fact("Repo", session.repo) }
                    fact("Worktree", session.worktreePath, mono: true)
                }
                .font(.caption)
            }
            VStack(alignment: .leading, spacing: 2) {
                railHeading("Open")
                    .padding(.bottom, 6)
                railButton("In Terminal", "terminal") { Task { await store.reopen(session) } }
                if session.pr != nil || session.commits > 0 {
                    railButton(session.pr.map { "Pull Request #\($0.number)" } ?? "Open Pull Request", "arrow.triangle.pull") {
                        Task { await store.openPullRequest(session) }
                    }
                }
                if let url = URL(string: session.permalink), !session.permalink.isEmpty {
                    railButton("Message in Slack", "number") { NSWorkspace.shared.open(url) }
                }
                railButton("Worktree in Finder", "folder") {
                    NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: session.worktreePath)
                }
                railButton("Copy Branch Name", "doc.on.doc") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(session.branch, forType: .string)
                }
            }
        }
    }

    private func railHeading(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.caption.weight(.semibold))
            .tracking(0.4)
            .foregroundStyle(.secondary)
    }

    private func fact(_ label: String, _ value: String, mono: Bool = false) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value)
                .font(mono ? Font.caption.monospaced() : Font.caption)
                .textSelection(.enabled)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    private func railButton(_ title: String, _ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label {
                Text(title).foregroundStyle(.primary)
            } icon: {
                Image(systemName: symbol).foregroundStyle(theme.accentText)
            }
            .frame(maxWidth: .infinity, minHeight: 26, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: Conversation (headless)

    private var conversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    TranscriptView(session: session)
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
    }

    // MARK: Follow-up

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
        .padding(.horizontal, 24).padding(.vertical, 12)
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
    }

    private func loadReply() async {
        guard session.resultMs != nil else { reply = nil; return }
        reply = await store.reply(for: session)
        draft = reply?.text ?? ""
    }
}

/// One thing that has happened to a session, or the next thing that will.
struct ActivityStep: Hashable {
    enum Mark: Hashable {
        /// Done.
        case reached
        /// Happening now, or waiting on you.
        case current
        case failed
        /// Not yet.
        case pending
    }

    var label: String
    var detail: String
    var time: Date?
    var mark: Mark

    /// Started → worktree → commits → pull request → reply → merged, as far as the session has got.
    /// A question (Investigate, Review, Ask) that has committed nothing skips commits and the pull request.
    static func steps(for session: AppSession) -> [ActivityStep] {
        var steps: [ActivityStep] = []
        var origin = session.promptLabel.isEmpty ? "A session" : session.promptLabel
        if !session.author.isEmpty { origin += ", from @\(session.author)" }
        if !session.channel.isEmpty { origin += " in #\(session.channel)" }
        steps.append(ActivityStep(label: "Started from Slack", detail: origin, time: session.created, mark: .reached))
        steps.append(ActivityStep(label: "Worktree ready",
                                  detail: session.baseBranch.isEmpty ? session.branch : "\(session.branch), cut from \(session.baseBranch)",
                                  time: nil, mark: .reached))

        if session.headless && session.running {
            steps.append(ActivityStep(label: "Running", detail: "In the background; its conversation is in the app", time: nil, mark: .current))
        }
        if session.state == "failed" {
            steps.append(ActivityStep(label: "Agent stopped", detail: session.exitCode.map { "Exit code \($0)" } ?? "With an error", time: nil, mark: .failed))
        }

        let answersOnly = session.commits == 0 && session.pr == nil && ["investigate", "review", "ask"].contains(session.promptKey)
        if !answersOnly {
            let committed = session.commits > 0 || ["pr-open", "pr-closed", "merged"].contains(session.state)
            if committed {
                let count = max(session.commits, 1)
                steps.append(ActivityStep(label: count == 1 ? "1 commit" : "\(count) commits",
                                          detail: session.dirty ? "Plus uncommitted changes" : "Nothing left uncommitted",
                                          time: nil, mark: .reached))
            } else {
                steps.append(ActivityStep(label: "Commits", detail: session.dirty ? "Uncommitted changes so far" : "None yet", time: nil, mark: .pending))
            }
            if let pr = session.pr {
                steps.append(ActivityStep(label: "Pull request #\(pr.number) opened",
                                          detail: session.state == "pr-closed" ? "Closed without merging" : "On \(session.baseBranch.isEmpty ? "its base" : session.baseBranch)",
                                          time: nil, mark: .reached))
            } else {
                steps.append(ActivityStep(label: "Pull request", detail: "None yet", time: nil, mark: .pending))
            }
        }

        if let ms = session.resultMs {
            let at = Date(timeIntervalSince1970: ms / 1000)
            steps.append(session.resultPending && !session.markedDone
                         ? ActivityStep(label: "Reply drafted", detail: "Waiting for you to read and post it", time: at, mark: .current)
                         : ActivityStep(label: "Reply", detail: "Posted or set aside", time: at, mark: .reached))
        } else if session.state == "answered" {
            steps.append(ActivityStep(label: "Answered", detail: "The agent left its answer", time: nil, mark: .reached))
        } else {
            steps.append(ActivityStep(label: "Reply", detail: "None yet", time: nil, mark: .pending))
        }

        if session.state == "merged" {
            steps.append(ActivityStep(label: "Merged", detail: "Into \(session.baseBranch.isEmpty ? "its base" : session.baseBranch)", time: nil, mark: .reached))
        } else if session.markedDone {
            steps.append(ActivityStep(label: "Done", detail: "Marked by you", time: session.doneAt.flatMap(ISODate.parse), mark: .reached))
        } else if session.state == "gone" {
            steps.append(ActivityStep(label: "Cleaned up", detail: "The worktree is gone", time: nil, mark: .reached))
        } else if answersOnly {
            steps.append(ActivityStep(label: "Done", detail: "Mark it done once nothing is left", time: nil, mark: .pending))
        } else {
            steps.append(ActivityStep(label: "Merged", detail: "Not yet", time: nil, mark: .pending))
        }
        return steps
    }
}

/// The session's story, top to bottom, joined by a line that fills in as it goes.
struct ActivityTimeline: View {
    @Environment(\.theme) private var theme
    let session: AppSession

    var body: some View {
        let steps = ActivityStep.steps(for: session)
        VStack(alignment: .leading, spacing: 10) {
            Text("Activity").font(.headline)
            VStack(alignment: .leading, spacing: 0) {
                ForEach(steps.indices, id: \.self) { index in
                    row(steps[index], next: index + 1 < steps.count ? steps[index + 1] : nil)
                }
            }
        }
    }

    private func row(_ step: ActivityStep, next: ActivityStep?) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 0) {
                marker(step.mark)
                    .padding(.top, 3)
                if let next {
                    Rectangle()
                        .fill(next.mark == .reached ? theme.accent : Color.secondary.opacity(0.25))
                        .frame(width: 2)
                        .frame(maxHeight: .infinity)
                }
            }
            .frame(width: 12)
            VStack(alignment: .leading, spacing: 2) {
                Text(step.label)
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(labelColor(step.mark))
                if !step.detail.isEmpty {
                    Text(step.detail).font(.callout).foregroundStyle(.secondary)
                }
            }
            .padding(.bottom, next == nil ? 0 : 14)
            Spacer(minLength: 8)
            if let time = step.time {
                Text(time.formatted(Self.style(for: time)))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }

    /// The time of day for today, the date for anything older.
    private static func style(for time: Date) -> Date.FormatStyle {
        Calendar.current.isDateInToday(time) ? Date.FormatStyle.dateTime.hour().minute() : Date.FormatStyle.dateTime.month(.abbreviated).day()
    }

    @ViewBuilder
    private func marker(_ mark: ActivityStep.Mark) -> some View {
        switch mark {
        case .reached:
            Circle().fill(theme.accent).frame(width: 12, height: 12)
        case .current:
            Circle().strokeBorder(theme.accent, lineWidth: 2).frame(width: 12, height: 12)
        case .failed:
            Circle().strokeBorder(theme.fill(.failed), lineWidth: 2).frame(width: 12, height: 12)
        case .pending:
            Circle().strokeBorder(Color.secondary.opacity(0.4), lineWidth: 2).frame(width: 12, height: 12)
        }
    }

    private func labelColor(_ mark: ActivityStep.Mark) -> Color {
        switch mark {
        case .reached: return Color.primary
        case .current: return theme.accentText
        case .failed: return theme.text(.failed)
        case .pending: return Color.secondary
        }
    }
}
