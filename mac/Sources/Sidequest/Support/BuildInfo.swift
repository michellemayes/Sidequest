import AppKit
import SwiftUI

/// What build-app.sh stamped into Info.plist.
enum BuildInfo {
    static var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    }

    /// The commit the app was built from; the daemon reports its own, and the two should match.
    static var commit: String? {
        Bundle.main.object(forInfoDictionaryKey: "SidequestCommit") as? String
    }

    /// The GitHub repository releases come from, as owner/name.
    static var repository: String {
        Bundle.main.object(forInfoDictionaryKey: "SidequestRepository") as? String ?? "michellemayes/Sidequest"
    }
}

/// Opens the Settings window from places that have no SwiftUI environment, such as a banner's action.
enum SettingsOpener {
    @MainActor static var action: OpenSettingsAction?

    @MainActor static func open() {
        if let action {
            action()
        } else {
            NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
        }
        NSApp.activate()
    }
}
