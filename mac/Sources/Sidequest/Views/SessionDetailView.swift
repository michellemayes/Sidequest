import AppKit
import SwiftUI

/// One session: the message it came from, how far it has got, the reply to post, and what to tell it next.
struct SessionDetailView: View {
    @Environment(AppStore.self) private var store
    let session: AppSession

    @State private var reply: ResultReply?
    @State private var draft = ""
    @State private var followUp = ""
    @FocusState private var replyFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    if !session.message.isEmpty { quote }
                    ProgressTrack(session: session)
                    if session.resultPending || reply != nil { replyCard }
                    if session.state == "failed" { failureCard }
                    facts
                }
                .padding(20)
                .frame(maxWidth: 760, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            composer
        }
        .toolbar { toolbar }
        .task(id: session.resultMs) { await loadReply() }
        .onChange(of: store.focusReply) { _, wanted in
            if wanted { replyFocused = true; store.focusReply = false }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(session.title).font(.title2.bold()).textSelection(.enabled)
            Text(metaLine).font(.callout).foregroundStyle(.secondary)
        }
    }

    private var metaLine: String {
        var parts = [session.promptLabel, session.repo]
        if !session.channel.isEmpty { parts.append("#\(session.channel)") }
        if let created = session.created {
            parts.append("started \(created.formatted(date: .abbreviated, time: .shortened))")
        }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var quote: some View {
        HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 2).fill(.quaternary).frame(width: 3)
            VStack(alignment: .leading, spacing: 4) {
                if !session.author.isEmpty { Text("@\(session.author)").font(.callout.weight(.semibold)) }
                Text(session.message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled).lineLimit(8)
                if let url = URL(string: session.permalink), !session.permalink.isEmpty {
                    Link("View in Slack", destination: url).font(.caption)
                }
            }
        }
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
            Text("Its log is in .sidequest/agent.log in the worktree.").font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Show Log") {
                    let log = (session.worktreePath as NSString).appendingPathComponent(".sidequest/agent.log")
                    NSWorkspace.shared.open(URL(fileURLWithPath: log))
                }
                Button("Open in Terminal") { Task { await store.reopen(session) } }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }

    private var facts: some View {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
            fact("Branch", session.branch)
            if !session.baseBranch.isEmpty { fact("Cut from", session.baseBranch) }
            fact("Changes", [session.commits == 1 ? "1 commit" : "\(session.commits) commits", session.dirty ? "uncommitted changes" : "clean"].joined(separator: " · "))
            if !session.agent.isEmpty { fact("Agent", session.agent) }
            fact("Worktree", session.worktreePath)
        }
        .font(.callout)
    }

    private func fact(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value).font(.callout.monospaced()).textSelection(.enabled).lineLimit(1).truncationMode(.middle)
        }
    }

    private var composer: some View {
        HStack(spacing: 8) {
            TextField("Follow up: tell the session what to do next…", text: $followUp, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
                .onSubmit(sendFollowUp)
            Button("Send", action: sendFollowUp)
                .disabled(followUp.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || session.state == "gone")
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
            Button { Task { await store.reopen(session) } } label: { Label("Open in Terminal", systemImage: "terminal") }
                .help("Open this session in its terminal")
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
struct ProgressTrack: View {
    let session: AppSession

    private var steps: [(String, Bool)] {
        let committed = session.commits > 0 || ["pr-open", "pr-closed", "merged"].contains(session.state)
        let replied = session.resultMs != nil
        let pr = session.pr != nil
        return [
            ("Started", true),
            (committed ? (session.commits == 1 ? "1 commit" : "\(max(session.commits, 1)) commits") : "Commits", committed),
            (session.resultPending ? "Reply ready" : "Reply", replied),
            (session.pr.map { "PR #\($0.number)" } ?? "PR", pr),
            ("Merged", session.state == "merged"),
        ]
    }

    var body: some View {
        HStack(spacing: 6) {
            ForEach(steps.indices, id: \.self) { index in
                let step = steps[index]
                if index > 0 {
                    Capsule().fill(step.1 ? Color.accentColor : Color.secondary.opacity(0.25)).frame(height: 2)
                }
                HStack(spacing: 4) {
                    Circle().fill(step.1 ? Color.accentColor : Color.secondary.opacity(0.3)).frame(width: 8, height: 8)
                    Text(step.0).font(.caption).foregroundStyle(step.1 ? .primary : .secondary).fixedSize()
                }
            }
        }
    }
}
