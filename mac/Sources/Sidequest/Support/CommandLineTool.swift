import AppKit
import Foundation

/// The `sidequest` CLI the daemon comes from: the copy inside the app when it
/// carries one, else the one you installed (npm link). Either way it runs
/// through your login shell, so the daemon it starts finds git, your agent
/// and your terminals on the PATH your shell sets up.
enum CommandLineTool {
    struct Output {
        var status: Int32
        var text: String
    }

    /// The CLI inside Sidequest.app, when this build carries the engine.
    static var bundled: String? {
        guard let path = Bundle.main.resourceURL?.appendingPathComponent("engine/bin/sidequest").path,
              FileManager.default.isExecutableFile(atPath: path) else { return nil }
        return path
    }

    /// Where Help › Install Command-Line Tool puts the bundled CLI.
    static let installedLink = "/usr/local/bin/sidequest"

    /// Run `sidequest <args>` through the login shell.
    static func sidequest(_ args: [String]) async -> Output {
        let command = ([bundled.map(quote) ?? "sidequest"] + args.map(quote)).joined(separator: " ")
        return await run("/bin/zsh", ["-lc", command])
    }

    /// Link the bundled CLI onto your PATH, asking for an administrator's password to write to /usr/local/bin.
    static func installLink() throws {
        guard let bundled else {
            throw DaemonError(message: "This build of Sidequest doesn't carry its own CLI.", hint: "Install it with npm link from a checkout instead.")
        }
        let shell = "mkdir -p /usr/local/bin && ln -sf \(quote(bundled)) \(quote(installedLink))"
        let source = "do shell script \"\(shell.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\""))\" with administrator privileges"
        var error: NSDictionary?
        NSAppleScript(source: source)?.executeAndReturnError(&error)
        if let error, (error[NSAppleScript.errorNumber] as? Int) != -128 {
            throw DaemonError(message: "The command-line tool wasn't installed.", hint: error[NSAppleScript.errorMessage] as? String)
        }
    }

    static func quote(_ text: String) -> String {
        "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    static func run(_ executable: String, _ args: [String]) async -> Output {
        await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: executable)
            process.arguments = args
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            process.terminationHandler = { p in
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                continuation.resume(returning: Output(status: p.terminationStatus, text: String(decoding: data, as: UTF8.self)))
            }
            do {
                try process.run()
            } catch {
                continuation.resume(returning: Output(status: -1, text: error.localizedDescription))
            }
        }
    }
}
