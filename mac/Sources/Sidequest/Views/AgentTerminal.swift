import AppKit
import SwiftTerm
import SwiftUI

/// SwiftTerm's terminal view, running `argv` through your login shell in the worktree.
struct AgentTerminal: NSViewRepresentable {
    let command: TerminalCommandReply
    var fontSize: Double = 13

    func makeNSView(context: Context) -> LocalProcessTerminalView {
        let view = LocalProcessTerminalView(frame: .zero)
        view.font = NSFont.monospacedSystemFont(ofSize: CGFloat(fontSize), weight: .regular)
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

    func updateNSView(_ nsView: LocalProcessTerminalView, context: Context) {
        if nsView.font.pointSize != CGFloat(fontSize) {
            nsView.font = NSFont.monospacedSystemFont(ofSize: CGFloat(fontSize), weight: .regular)
        }
    }

    static func dismantleNSView(_ nsView: LocalProcessTerminalView, coordinator: ()) {
        nsView.process?.terminate()
    }
}
