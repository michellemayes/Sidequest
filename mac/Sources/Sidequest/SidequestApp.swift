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

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { sender.windows.first { $0.identifier?.rawValue == "main" || $0.title == "Sidequest" }?.makeKeyAndOrderFront(nil) }
        return true
    }
}
