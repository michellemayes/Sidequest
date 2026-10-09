import AppKit
import SwiftUI

/// The menu bar at the top of the screen: every CLI command has a home here or in Settings.
struct SidequestCommands: Commands {
    let store: AppStore
    let updater: Updater

    /// Read when an item is clicked, not when the menu was built, so it is the session selected now.
    private var session: AppSession? { store.selectedSession }

    var body: some Commands {
        CommandGroup(after: .appInfo) {
            Button("Check for Updates…") { Task { await updater.check(); updater.install() } }
        }
        CommandGroup(after: .appSettings) {
            Divider()
            Button("Run Checks") {
                Task { await store.runChecks() }
                store.showChecks = true
            }
            Button("Restart Slack with Sidequest") { Task { await store.restartSlack() } }
            Button("Start Sidequest") { Task { await store.startDaemon() } }
            Button("Stop Sidequest") { Task { await store.stopDaemon() } }
        }

        CommandMenu("Session") {
            Button("Open in Terminal") { if let session { Task { await store.reopen(session) } } }
                .keyboardShortcut("o")
            Button("Review Reply") { if session?.resultPending == true { store.focusReply = true } }
                .keyboardShortcut("r")
            Button(session?.pr == nil ? "Open Pull Request" : "View Pull Request") {
                if let session { Task { await store.openPullRequest(session) } }
            }
            .keyboardShortcut("p", modifiers: [.command, .shift])
            Button("View in Slack") { if let url = session.flatMap({ URL(string: $0.permalink) }) { NSWorkspace.shared.open(url) } }
            Divider()
            Button("Show Worktree in Finder") {
                if let session { NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: session.worktreePath) }
            }
            Button("Copy Branch Name") {
                if let session {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(session.branch, forType: .string)
                }
            }
            .keyboardShortcut("c", modifiers: [.command, .shift])
            Divider()
            Button("Remove Session…") { if let session { store.confirmRemove = session } }
                .keyboardShortcut(.delete)
            Button("Clean Up Finished Sessions…") { store.confirmClean = true }
        }

        CommandGroup(before: .sidebar) {
            Button("Needs You") { store.filter = .needsYou }.keyboardShortcut("1")
            Button("Working") { store.filter = .working }.keyboardShortcut("2")
            Button("Done") { store.filter = .done }.keyboardShortcut("3")
            Button("All Sessions") { store.filter = .all }.keyboardShortcut("4")
            Divider()
        }

        CommandGroup(replacing: .help) {
            Button("Sidequest Guide") { open("https://github.com/\(BuildInfo.repository)/blob/main/docs/guide.md") }
            Button("Troubleshooting") { open("https://github.com/\(BuildInfo.repository)/blob/main/docs/guide.md#troubleshooting") }
            Divider()
            Button("Open Log") { NSWorkspace.shared.open(URL(fileURLWithPath: Paths.log)) }
            Button("Open Config File") { NSWorkspace.shared.open(URL(fileURLWithPath: Paths.config)) }
        }
    }

    private func open(_ link: String) {
        if let url = URL(string: link) { NSWorkspace.shared.open(url) }
    }
}

enum Paths {
    static var root: String {
        ProcessInfo.processInfo.environment["SIDEQUEST_HOME"].flatMap { $0.isEmpty ? nil : $0 }
            ?? (NSHomeDirectory() as NSString).appendingPathComponent(".sidequest")
    }
    static var log: String { (root as NSString).appendingPathComponent("sidequest.log") }
    static var config: String { (root as NSString).appendingPathComponent("config.json") }
}
