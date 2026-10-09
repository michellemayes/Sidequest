import Foundation

/// The `sidequest` CLI the daemon comes from. The app starts the daemon and
/// updates it through the CLI, so both stay one install.
enum CommandLineTool {
    struct Output {
        var status: Int32
        var text: String
    }

    /// Where `sidequest` is, as your login shell finds it (npm link puts it on
    /// the shell's PATH, which apps launched from the Dock don't inherit).
    static func locate() async -> String? {
        let found = await run("/bin/zsh", ["-lc", "command -v sidequest"])
        let path = found.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return found.status == 0 && !path.isEmpty ? path : nil
    }

    /// Run `sidequest <args>` through the login shell, so node is on PATH too.
    static func sidequest(_ args: [String]) async -> Output {
        let quoted = args.map { "'" + $0.replacingOccurrences(of: "'", with: "'\\''") + "'" }.joined(separator: " ")
        return await run("/bin/zsh", ["-lc", "sidequest \(quoted)"])
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
