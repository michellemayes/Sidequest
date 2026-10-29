import SwiftUI

/// How a session's state looks wherever it is shown: one symbol, one of the palette's tones, one word.
struct SessionLook {
    var symbol: String
    var tone: Tone
    var word: String

    init(_ session: AppSession) {
        if session.markedDone {
            self.init("checkmark.circle.fill", .done, "done")
        } else if session.resultPending {
            self.init("text.bubble.fill", .needsYou, "reply ready")
        } else if session.headless && session.running {
            self.init("circle.dotted", .working, "running \(Elapsed.short(since: session.created))")
        } else {
            switch session.state {
            case "asking": self.init("questionmark.bubble.fill", .needsYou, "waiting on you")
            case "failed": self.init("xmark.octagon.fill", .failed, session.exitCode.map { "failed · exit \($0)" } ?? "failed")
            case "committed": self.init("circle.lefthalf.filled", .working, session.commits == 1 ? "1 commit" : "\(session.commits) commits")
            case "pr-open": self.init("arrow.triangle.pull", .done, session.pr.map { "PR #\($0.number)" } ?? "PR open")
            case "pr-closed": self.init("xmark.circle", .neutral, "PR closed")
            case "merged": self.init("arrow.triangle.merge", .done, "merged")
            case "answered": self.init("text.bubble", .done, "answered")
            case "gone": self.init("archivebox", .neutral, "cleaned up")
            case "working": self.init("circle.dotted", .working, "working")
            // Not followed any more (too old, or tracking is off): nothing new is known about it.
            default: self.init("moon.zzz", .neutral, "idle")
            }
        }
    }

    private init(_ symbol: String, _ tone: Tone, _ word: String) {
        self.symbol = symbol
        self.tone = tone
        self.word = word
    }
}

/// A small round mark in a tone's colour, ringed with a tint of it.
struct StatusDot: View {
    @Environment(\.theme) private var theme
    let tone: Tone

    var body: some View {
        Circle()
            .fill(theme.fill(tone))
            .frame(width: 9, height: 9)
            .background(Circle().fill(theme.fill(tone).opacity(0.2)).padding(-3))
            .accessibilityHidden(true)
    }
}

/// A word in a capsule, tinted with a tone, or filled with it when it wants you.
struct Pill: View {
    @Environment(\.theme) private var theme
    let text: String
    let tone: Tone
    var filled = false

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .monospacedDigit()
            .lineLimit(1)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(filled ? theme.fill(tone) : theme.fill(tone).opacity(0.14), in: Capsule())
            .foregroundStyle(filled ? theme.onFill(tone) : theme.text(tone))
    }
}

/// One word for where a session has got to, tinted to match.
struct StatusPill: View {
    let session: AppSession

    var body: some View {
        let look = SessionLook(session)
        Pill(text: look.word, tone: look.tone, filled: session.resultPending && !session.markedDone)
    }
}

/// A prompt's name in its tag colour.
struct PromptChip: View {
    @Environment(\.theme) private var theme
    let text: String
    let promptKey: String

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .foregroundStyle(theme.tagText(promptKey))
            .background(theme.tagFill(promptKey), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
    }
}

/// The prompt a session was started with (Fix, Investigate, Ask…), as a small tag.
struct PromptTag: View {
    let session: AppSession

    var body: some View {
        if !session.promptLabel.isEmpty {
            PromptChip(text: session.promptLabel, promptKey: session.promptKey)
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
