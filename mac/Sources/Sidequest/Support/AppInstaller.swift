import AppKit
import Foundation
import Security

/// Installs a release in place without Sparkle: downloads its zip, checks the
/// app inside is Sidequest signed by the same developer as this copy, and swaps
/// it in for this one once the app quits, then opens the new one.
enum AppInstaller {
    struct Failure: LocalizedError {
        var errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }

    /// A new copy, unpacked and checked, waiting for the app to quit.
    struct Staged: Sendable {
        /// This copy of Sidequest.app, which the new one replaces.
        var target: URL
        /// The new Sidequest.app.
        var app: URL
        /// The scratch folder it was unpacked in, on the same disk as `target`.
        var folder: URL
    }

    /// Where this copy lives, if it can replace itself there.
    static func target() throws -> URL {
        let app = Bundle.main.bundleURL
        guard Bundle.main.bundleIdentifier != nil, app.pathExtension == "app" else {
            throw Failure("Only a built Sidequest.app can update itself.")
        }
        // macOS runs a downloaded app from a read-only copy until it is moved.
        guard !app.path.contains("/AppTranslocation/") else {
            throw Failure("Move Sidequest to your Applications folder, open it from there, and try again.")
        }
        let files = FileManager.default
        guard files.isWritableFile(atPath: app.deletingLastPathComponent().path), files.isWritableFile(atPath: app.path) else {
            throw Failure("Sidequest can't replace itself in \(app.deletingLastPathComponent().path). Move it to a folder you can change, such as Applications, and try again.")
        }
        return app
    }

    /// Download `url` and unpack the app in it, reporting progress from 0 to 1 as it arrives.
    static func stage(_ url: URL, version: String, progress: @escaping @Sendable (Double) -> Void) async throws -> Staged {
        let target = try target()
        // Unpacked on the same disk as the app, so swapping them is a rename.
        let folder = try FileManager.default.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: target, create: true)
        do {
            let zip = folder.appendingPathComponent("Sidequest-\(version).zip")
            try await download(url, to: zip, progress: progress)
            let unpacked = folder.appendingPathComponent("unpacked", isDirectory: true)
            let out = await CommandLineTool.run("/usr/bin/ditto", ["-x", "-k", zip.path, unpacked.path])
            guard out.status == 0 else { throw Failure("The download couldn't be unpacked.") }
            try? FileManager.default.removeItem(at: zip)
            let contents = (try? FileManager.default.contentsOfDirectory(at: unpacked, includingPropertiesForKeys: nil)) ?? []
            guard let app = contents.first(where: { $0.pathExtension == "app" }) else {
                throw Failure("The download has no app in it.")
            }
            try Task.checkCancellation()
            // Checking every signature in a bundle this size takes a moment; keep it off the main thread.
            try await Task.detached { try AppInstaller.verify(app, version: version) }.value
            return Staged(target: target, app: app, folder: folder)
        } catch {
            try? FileManager.default.removeItem(at: folder)
            throw error
        }
    }

    /// Throw unless `app` is Sidequest `version`, intact, and signed by whoever signed this copy.
    static func verify(_ app: URL, version: String) throws {
        guard let bundle = Bundle(url: app), let id = bundle.bundleIdentifier, id == Bundle.main.bundleIdentifier else {
            throw Failure("The download isn't Sidequest, so it wasn't installed.")
        }
        guard bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == version else {
            throw Failure("The download isn't version \(version), so it wasn't installed.")
        }
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code else {
            throw Failure("The download's signature couldn't be read, so it wasn't installed.")
        }
        // A copy signed with a Developer ID only takes an update signed by the same team.
        var requirement: SecRequirement?
        if let team = teamIdentifier(of: Bundle.main.bundleURL) {
            let text = "anchor apple generic and identifier \"\(id)\" and certificate leaf[subject.OU] = \"\(team)\""
            guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess else {
                throw Failure("The download's signature couldn't be checked, so it wasn't installed.")
            }
        }
        let flags = SecCSFlags(rawValue: UInt32(kSecCSCheckAllArchitectures) | UInt32(kSecCSCheckNestedCode) | UInt32(kSecCSStrictValidate))
        guard SecStaticCodeCheckValidity(code, flags, requirement) == errSecSuccess else {
            throw Failure("The download's signature doesn't match this copy of Sidequest, so it wasn't installed.")
        }
    }

    /// The team that signed the app at `url`; nil when it is signed ad hoc.
    static func teamIdentifier(of url: URL) -> String? {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code else { return nil }
        var info: CFDictionary?
        guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: UInt32(kSecCSSigningInformation)), &info) == errSecSuccess,
              let info = info as? [String: Any] else { return nil }
        return info[kSecCodeInfoTeamIdentifier as String] as? String
    }

    /// Once this process has exited, put the new app where this one was and open it.
    /// If the new one can't be moved in, the old one goes back and opens instead.
    static func swapWhenQuit(_ staged: Staged) {
        let backup = staged.folder.appendingPathComponent("Previous.app")
        let script = """
        while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
        if mv "$2" "$4"; then
          if mv "$3" "$2"; then :; else mv "$4" "$2"; fi
        fi
        xattr -dr com.apple.quarantine "$2" 2>/dev/null
        rm -rf "$5"
        open "$2"
        """
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", script, "sh", String(ProcessInfo.processInfo.processIdentifier),
                             staged.target.path, staged.app.path, backup.path, staged.folder.path]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try? process.run()
    }

    // MARK: Download

    private static func download(_ url: URL, to destination: URL, progress: @escaping @Sendable (Double) -> Void) async throws {
        let delegate = DownloadDelegate(destination: destination, progress: progress)
        let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let task = session.downloadTask(with: url)
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                delegate.continuation = continuation
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
        try Task.checkCancellation()
    }

    private final class DownloadDelegate: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
        let destination: URL
        let progress: @Sendable (Double) -> Void
        var continuation: CheckedContinuation<Void, Error>?
        private var failure: Error?
        private var reported = -1

        init(destination: URL, progress: @escaping @Sendable (Double) -> Void) {
            self.destination = destination
            self.progress = progress
        }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                        totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
            guard totalBytesExpectedToWrite > 0 else { return }
            // Whole percents, so the bar moves without a flood of updates.
            let percent = Int(totalBytesWritten * 100 / totalBytesExpectedToWrite)
            if percent != reported {
                reported = percent
                progress(Double(percent) / 100)
            }
        }

        func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
            // The file at `location` is gone once this returns, so it is moved now.
            guard let status = (downloadTask.response as? HTTPURLResponse)?.statusCode, status == 200 else {
                failure = Failure("GitHub didn't send the update. Try again in a minute.")
                return
            }
            do {
                try? FileManager.default.removeItem(at: destination)
                try FileManager.default.moveItem(at: location, to: destination)
            } catch {
                failure = error
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            if let error = error ?? failure {
                if (error as? URLError)?.code == .cancelled {
                    continuation?.resume(throwing: CancellationError())
                } else {
                    continuation?.resume(throwing: error)
                }
            } else {
                continuation?.resume()
            }
            continuation = nil
        }
    }
}
