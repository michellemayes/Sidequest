import AppKit
import SwiftTerm
import SwiftUI

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
