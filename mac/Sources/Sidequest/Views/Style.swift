import SwiftUI

/// How a session's state looks wherever it is shown: one symbol, one colour, one word.
struct SessionLook {
    var symbol: String
    var color: Color
    var word: String

    init(_ session: AppSession) {
        if session.markedDone {
            self.init("checkmark.circle.fill", .green, "done")
        } else if session.resultPending {
            self.init("text.bubble.fill", .accentColor, "reply ready")
        } else if session.headless && session.running {
            self.init("circle.dotted", .blue, "running \(Elapsed.short(since: session.created))")
        } else {
            switch session.state {
            case "failed": self.init("xmark.octagon.fill", .red, session.exitCode.map { "failed · exit \($0)" } ?? "failed")
            case "committed": self.init("circle.lefthalf.filled", .orange, session.commits == 1 ? "1 commit" : "\(session.commits) commits")
            case "pr-open": self.init("arrow.triangle.pull", .green, session.pr.map { "PR #\($0.number)" } ?? "PR open")
            case "pr-closed": self.init("xmark.circle", .secondary, "PR closed")
            case "merged": self.init("arrow.triangle.merge", .purple, "merged")
            case "answered": self.init("text.bubble", .teal, "answered")
            case "gone": self.init("archivebox", .secondary, "cleaned up")
            case "working": self.init("circle.dotted", .blue, "working")
            // Not followed any more (too old, or tracking is off): nothing new is known about it.
            default: self.init("moon.zzz", .secondary, "idle")
            }
        }
    }

    private init(_ symbol: String, _ color: Color, _ word: String) {
        self.symbol = symbol
        self.color = color
        self.word = word
    }
}

/// One word for where a session has got to, tinted to match.
struct StatusPill: View {
    let session: AppSession

    var body: some View {
        let look = SessionLook(session)
        let filled = session.resultPending && !session.markedDone
        Text(look.word)
            .font(.caption2.weight(.semibold))
            .monospacedDigit()
            .lineLimit(1)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(filled ? look.color : look.color.opacity(0.14), in: Capsule())
            .foregroundStyle(filled ? Color.white : look.color)
    }
}

/// The prompt a session was started with (Fix, Investigate, Ask…), as a small tag.
struct PromptTag: View {
    let session: AppSession

    var body: some View {
        if !session.promptLabel.isEmpty {
            Text(session.promptLabel)
                .font(.caption2.weight(.medium))
                .lineLimit(1)
                .padding(.horizontal, 6).padding(.vertical, 1)
                .foregroundStyle(color)
                .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
        }
    }

    private var color: Color {
        switch session.promptKey {
        case "fix": return .orange
        case "investigate": return .purple
        case "review": return .teal
        case "ask": return .blue
        case "linear": return .indigo
        case "jira": return .cyan
        case "github": return .gray
        default: return .secondary
        }
    }
}

extension View {
    /// A rounded panel, the one the detail view groups each part of a session in.
    func card(padding: CGFloat = 14) -> some View {
        self.padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.background.secondary, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.quaternary))
    }
}

/// Mark sessions done, or not done again when every one of them already is.
struct MarkDoneButton: View {
    @Environment(AppStore.self) private var store
    let sessions: [AppSession]

    private var undo: Bool { !sessions.isEmpty && sessions.allSatisfy(\.markedDone) }

    var body: some View {
        Button {
            let sessions = sessions
            let undo = undo
            Task { await store.markDone(sessions, done: !undo) }
        } label: {
            Label(title, systemImage: undo ? "arrow.uturn.backward.circle" : "checkmark.circle")
        }
        .disabled(sessions.isEmpty)
    }

    private var title: String {
        let count = sessions.count == 1 ? "" : " \(sessions.count)"
        return undo ? "Mark\(count) as Not Done" : "Mark\(count) as Done"
    }
}
