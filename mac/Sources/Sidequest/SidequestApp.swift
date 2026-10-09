import AppKit
import SwiftUI

@main
struct SidequestApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var store: AppStore
    @State private var updater: Updater

    init() {
        let store = AppStore()
        _store = State(initialValue: store)
        _updater = State(initialValue: Updater(notifier: store.notifier))
    }

    var body: some Scene {
        Window("Sidequest", id: "main") {
            ContentView()
                .environment(store)
                .environment(updater)
                .frame(minWidth: 900, minHeight: 560)
                .task {
                    store.start()
                    updater.start()
                }
        }
        .defaultSize(width: 1100, height: 680)
        .commands { SidequestCommands(store: store, updater: updater) }

        Settings {
            SettingsView()
                .environment(store)
                .environment(updater)
        }
    }
}

/// Keeps the app running in the background while its window is closed, as Mail does,
/// so notifications still arrive.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// A terminal tab is an agent you are talking to; quitting would end it, so ask first.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let open = MainActor.assumeIsolated { AppStore.shared?.openTerminals ?? 0 }
        guard open > 0 else { return .terminateNow }
        let alert = NSAlert()
        alert.messageText = open == 1 ? "Quit with a terminal tab open?" : "Quit with \(open) terminal tabs open?"
        alert.informativeText = "The agent running in it stops. Its conversation is saved, so the next message carries on in the background."
        alert.addButton(withTitle: "Quit")
        alert.addButton(withTitle: "Cancel")
        return alert.runModal() == .alertFirstButtonReturn ? .terminateNow : .terminateCancel
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { sender.windows.first { $0.identifier?.rawValue == "main" || $0.title == "Sidequest" }?.makeKeyAndOrderFront(nil) }
        return true
    }
}
