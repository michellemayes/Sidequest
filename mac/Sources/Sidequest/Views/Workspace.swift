import AppKit
import SwiftTerm
import SwiftUI

/// The tabs a headless session has: watch it, see what it changed, or take the wheel.
enum WorkspaceTab: String, CaseIterable, Identifiable {
    case conversation = "Conversation"
    case changes = "Changes"
    case terminal = "Terminal"
    var id: String { rawValue }
}

/// What a headless run has said and done, kept up to date while it runs.
struct TranscriptView: View {
    @Environment(AppStore.self) private var store
    let session: AppSession

    var body: some View {
        let items = store.transcripts[session.branch] ?? []
        VStack(alignment: .leading, spacing: 10) {
            if items.isEmpty {
                Text(session.running ? "Starting…" : "Nothing yet. The conversation shows here once the agent starts.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            ForEach(items.indices, id: \.self) { index in
                TranscriptRow(item: items[index])
            }
            ForEach(store.pendingApprovals(for: session)) { approval in
                ApprovalCard(approval: approval)
            }
            if session.running {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Working…").font(.caption).foregroundStyle(.secondary)
                }
            }
            if !store.structuredTranscripts.contains(session.branch) && !items.isEmpty {
                Text("This agent has no event stream, so this is its log.").font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}

struct TranscriptRow: View {
    let item: TranscriptItem
    @State private var expanded = false

    var body: some View {
        switch item.kind {
        case "you":
            HStack {
                Spacer(minLength: 60)
                Text(item.text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 11).padding(.vertical, 7)
                    .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 12))
                    .foregroundStyle(.white)
            }
        case "agent":
            Text(item.text).textSelection(.enabled)
        case "tool":
            HStack(spacing: 6) {
                Text(item.tool ?? "Tool").font(.caption.weight(.semibold))
                Text(item.text).font(.caption.monospaced()).lineLimit(expanded ? nil : 1).truncationMode(.middle)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 9).padding(.vertical, 4)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 7))
            .onTapGesture { expanded.toggle() }
        case "error":
            Label(item.text, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red).font(.callout).textSelection(.enabled)
        case "done":
            Label(item.text, systemImage: "checkmark.circle").foregroundStyle(.secondary).font(.caption)
        default:
            Text(item.text).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
        }
    }
}

/// A headless agent asking before a tool its limits would refuse.
struct ApprovalCard: View {
    @Environment(AppStore.self) private var store
    let approval: Approval

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(approval.tool) wants to run").font(.callout.weight(.semibold))
            Text(approval.summary)
                .font(.callout.monospaced())
                .textSelection(.enabled)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.background, in: RoundedRectangle(cornerRadius: 6))
            HStack {
                Button("Allow") { Task { await store.decide(approval, allow: true) } }
                    .buttonStyle(.borderedProminent)
                Button("Always Allow \(approval.tool)") { Task { await store.decide(approval, allow: true, always: true) } }
                Button("Deny") { Task { await store.decide(approval, allow: false) } }
            }
        }
        .padding(12)
        .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentColor.opacity(0.6)))
    }
}

/// The worktree's changes against the session's base, refreshed while you look.
struct ChangesView: View {
    @Environment(AppStore.self) private var store
    let session: AppSession
    @State private var files: [ChangedFile] = []
    @State private var selected: ChangedFile.ID?
    @State private var patch = ""

    var body: some View {
        HSplitView {
            List(files, selection: $selected) { file in
                HStack {
                    Text(file.path).font(.callout.monospaced()).lineLimit(1).truncationMode(.head)
                    Spacer()
                    if file.status == "deleted" {
                        Text("deleted").font(.caption).foregroundStyle(.red)
                    } else {
                        Text("+\(file.added.map(String.init) ?? "–")").font(.caption.monospaced()).foregroundStyle(.green)
                        Text("−\(file.removed.map(String.init) ?? "–")").font(.caption.monospaced()).foregroundStyle(.red)
                    }
                }
                .tag(file.id)
            }
            .frame(minWidth: 200, idealWidth: 260)
            .overlay { if files.isEmpty { ContentUnavailableView("No changes yet", systemImage: "doc.text") } }
            ScrollView([.vertical, .horizontal]) {
                DiffText(patch: patch).padding(10).frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minWidth: 300)
            .overlay(alignment: .bottomTrailing) {
                if let path = selected {
                    Button("Open in Editor") {
                        NSWorkspace.shared.open(URL(fileURLWithPath: (session.worktreePath as NSString).appendingPathComponent(path)))
                    }
                    .padding(10)
                }
            }
        }
        .task(id: session.id) {
            while !Task.isCancelled {
                files = await store.changes(for: session)
                if selected == nil { selected = files.first?.id }
                if let selected { patch = await store.diff(for: session, path: selected) }
                try? await Task.sleep(for: .seconds(session.running ? 3 : 10))
            }
        }
        .onChange(of: selected) { _, path in
            Task {
                patch = ""
                if let path { patch = await store.diff(for: session, path: path) }
            }
        }
    }
}

/// A unified diff, coloured by line.
struct DiffText: View {
    let patch: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(patch.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { pair in
                let line = String(pair.element)
                Text(line.isEmpty ? " " : line)
                    .font(.caption.monospaced())
                    .foregroundStyle(color(line))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(background(line))
            }
        }
        .textSelection(.enabled)
    }

    private func color(_ line: String) -> Color {
        if line.hasPrefix("@@") { return .secondary }
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return .green }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return .red }
        return .primary
    }

    private func background(_ line: String) -> Color {
        if line.hasPrefix("+") && !line.hasPrefix("+++") { return .green.opacity(0.08) }
        if line.hasPrefix("-") && !line.hasPrefix("---") { return .red.opacity(0.08) }
        return .clear
    }
}

/// A real terminal in the window, running the agent interactively where the session left off.
struct TerminalTab: View {
    @Environment(AppStore.self) private var store
    let session: AppSession
    @State private var command: TerminalCommandReply?
    @State private var started = false
    @State private var generation = 0

    var body: some View {
        Group {
            if started, let command {
                AgentTerminal(command: command).id(generation)
            } else {
                ContentUnavailableView {
                    Label("Take the wheel", systemImage: "terminal")
                } description: {
                    Text(session.running
                         ? "Stop the background run first; then the agent opens here with its conversation carried on."
                         : "Opens \(session.agent.isEmpty ? "the agent" : session.agent) here, in the worktree, carrying on the conversation. Close the tab and the session goes back to running in the background on its next message.")
                } actions: {
                    Button("Open Terminal") { started = true; generation += 1 }
                        .buttonStyle(.borderedProminent)
                        .disabled(session.running || command == nil)
                }
            }
        }
        .task(id: session.id) { command = await store.terminalCommand(for: session) }
    }
}

/// SwiftTerm's terminal view, running `argv` through your login shell in the worktree.
struct AgentTerminal: NSViewRepresentable {
    let command: TerminalCommandReply

    func makeNSView(context: Context) -> LocalProcessTerminalView {
        let view = LocalProcessTerminalView(frame: .zero)
        let quoted = command.argv.map { "'" + $0.replacingOccurrences(of: "'", with: "'\\''") + "'" }.joined(separator: " ")
        let cwd = "'" + command.cwd.replacingOccurrences(of: "'", with: "'\\''") + "'"
        var environment = ProcessInfo.processInfo.environment
        environment["TERM"] = "xterm-256color"
        environment["COLORTERM"] = "truecolor"
        view.startProcess(
            executable: "/bin/zsh",
            args: ["-lc", "cd \(cwd) && exec \(quoted)"],
            environment: environment.map { "\($0.key)=\($0.value)" }
        )
        return view
    }

    func updateNSView(_ nsView: LocalProcessTerminalView, context: Context) {}

    static func dismantleNSView(_ nsView: LocalProcessTerminalView, coordinator: ()) {
        nsView.process?.terminate()
    }
}
