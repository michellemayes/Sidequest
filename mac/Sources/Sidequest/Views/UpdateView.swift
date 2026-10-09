import AppKit
import SwiftUI

/// Software Update: what Check for Updates… opens, from looking for a new
/// version through downloading and checking it to reopening on it.
struct UpdateView: View {
    @Environment(Updater.self) private var updater
    @Environment(\.dismissWindow) private var dismissWindow

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 64, height: 64)
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.headline)
                if let detail {
                    Text(detail)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                progress
                HStack {
                    Spacer()
                    buttons
                }
                .padding(.top, 8)
            }
        }
        .padding(20)
        .frame(width: 440)
        .onAppear {
            // Reopened with the app (after an update, say): look again rather than show nothing.
            if updater.phase == .idle { updater.checkForUpdates() }
        }
    }

    private var version: String { updater.latest?.version ?? "" }

    private var title: String {
        switch updater.phase {
        case .idle, .checking: "Checking for updates…"
        case .upToDate: "Sidequest is up to date"
        case .available: "Sidequest \(version) is available"
        case .downloading: "Downloading Sidequest \(version)…"
        case .installing: "Installing Sidequest \(version)…"
        case .readyToRelaunch: "Sidequest \(version) is ready"
        case .failed: "Sidequest wasn't updated"
        }
    }

    private var detail: String? {
        switch updater.phase {
        case .idle, .checking, .downloading: nil
        case .upToDate: "You have \(BuildInfo.version), the newest version."
        case .available: "You have \(BuildInfo.version). Sidequest downloads the new version, checks its signature, and reopens on it."
        case .installing: "Checking the download's signature."
        case .readyToRelaunch: "It goes in when Sidequest quits, and Sidequest reopens on it."
        case .failed(let message): message
        }
    }

    @ViewBuilder private var progress: some View {
        switch updater.phase {
        case .idle, .checking, .installing:
            ProgressView().progressViewStyle(.linear)
        case .downloading(let fraction):
            ProgressView(value: fraction) {
                EmptyView()
            } currentValueLabel: {
                Text("\(Int(fraction * 100))%").monospacedDigit()
            }
        default:
            EmptyView()
        }
    }

    @ViewBuilder private var buttons: some View {
        switch updater.phase {
        case .idle, .checking:
            Button("Cancel") { close() }.keyboardShortcut(.cancelAction)
        case .upToDate:
            Button("OK") { close() }.keyboardShortcut(.defaultAction)
        case .available:
            Button("Release Notes") { updater.openReleasePage() }
            Button("Later") { close() }.keyboardShortcut(.cancelAction)
            Button("Install and Relaunch") { updater.install() }.keyboardShortcut(.defaultAction)
        case .downloading:
            Button("Cancel") { updater.cancel() }.keyboardShortcut(.cancelAction)
        case .installing:
            Button("Cancel") {}.disabled(true)
        case .readyToRelaunch:
            Button("Later") { close() }.keyboardShortcut(.cancelAction)
            Button("Relaunch") { updater.relaunch() }.keyboardShortcut(.defaultAction)
        case .failed:
            Button("Download from GitHub") { updater.openReleasePage() }
            Button("Close") { close() }.keyboardShortcut(.cancelAction)
            Button("Try Again") {
                if updater.updateAvailable { updater.install() } else { updater.checkForUpdates() }
            }
            .keyboardShortcut(.defaultAction)
        }
    }

    private func close() {
        dismissWindow(id: UpdateView.windowID)
    }

    static let windowID = "update"
}
