import AppKit
import UserNotifications

/// Notifications from the app, rather than the daemon's osascript ones that
/// come from Script Editor: they say Sidequest, and clicking one opens the
/// session it is about.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    /// Called with the branch of a session notification that was clicked.
    var onOpen: ((String) -> Void)?
    /// Called when an update notification was clicked.
    var onUpdate: (() -> Void)?
    /// Called with an approval's id and your answer, from its notification's buttons.
    var onApproval: ((String, Bool) -> Void)?

    private static let approvalCategory = "approval"

    private var center: UNUserNotificationCenter? {
        // Only a bundled app may use the notification center; `swift run` is not one.
        Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
    }

    func setUp() {
        guard let center else { return }
        center.delegate = self
        let allow = UNNotificationAction(identifier: "allow", title: "Allow")
        let deny = UNNotificationAction(identifier: "deny", title: "Deny", options: [.destructive])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.approvalCategory, actions: [allow, deny], intentIdentifiers: []),
        ])
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func post(_ notice: Notice) {
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.body
        content.sound = .default
        if let branch = notice.branch {
            content.userInfo = ["branch": branch]
            content.threadIdentifier = branch
        }
        deliver(content, id: "session-\(notice.branch ?? UUID().uuidString)-\(Date().timeIntervalSince1970)")
    }

    func postUpdate(version: String) {
        let content = UNMutableNotificationContent()
        content.title = "Sidequest \(version) is available"
        content.body = "Click to update. It takes a few seconds."
        content.userInfo = ["update": version]
        deliver(content, id: "update-\(version)")
    }

    func postApproval(_ approval: Approval) {
        let content = UNMutableNotificationContent()
        content.title = "\(approval.tool) wants to run"
        content.subtitle = approval.title
        content.body = approval.summary
        content.sound = .default
        content.categoryIdentifier = Self.approvalCategory
        content.userInfo = ["branch": approval.branch, "approval": approval.id]
        deliver(content, id: "approval-\(approval.id)")
    }

    /// Take an answered question's notification away.
    func withdraw(approval id: String) {
        center?.removeDeliveredNotifications(withIdentifiers: ["approval-\(id)"])
    }

    private func deliver(_ content: UNMutableNotificationContent, id: String) {
        center?.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let branch = info["branch"] as? String
        let update = info["update"] != nil
        let approval = info["approval"] as? String
        let action = response.actionIdentifier
        Task { @MainActor in
            if let approval, action == "allow" || action == "deny" {
                self.onApproval?(approval, action == "allow")
                return
            }
            NSApp.activate()
            if update { self.onUpdate?() }
            if let branch { self.onOpen?(branch) }
        }
        completionHandler()
    }
}
