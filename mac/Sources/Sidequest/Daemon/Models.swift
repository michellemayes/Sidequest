import Foundation

// What the daemon sends over the control socket, as src/control/app.ts
// writes it. Field names match the JSON exactly.

struct PullRequest: Codable, Hashable {
    var number: Int
    var url: String
    var state: String
}

/// One session, named for the Slack message it came from.
struct AppSession: Codable, Identifiable, Hashable {
    var id: String
    var branch: String
    var title: String
    var message: String
    var author: String
    var channel: String
    var repo: String
    var repoPath: String
    var worktreePath: String
    var baseBranch: String
    var promptKey: String
    var promptLabel: String
    var agent: String
    var agentId: String
    var createdAt: String
    var permalink: String
    /// working, answered, committed, pr-open, pr-closed, merged, gone, failed or unknown.
    var state: String
    var commits: Int
    var dirty: Bool
    var pr: PullRequest?
    var resultMs: Double?
    var resultPending: Bool
    var exitCode: Int?
    var needsYou: Bool
    /// Runs with no terminal: the app is where you watch and work on it.
    var headless: Bool
    /// A headless run is going right now.
    var running: Bool

    var created: Date? { ISODate.parse(createdAt) }

    /// Still being worked on: nothing to show yet, or commits but no pull request.
    var isWorking: Bool { state == "working" || state == "committed" || state == "unknown" }
    var isDone: Bool { ["answered", "pr-open", "pr-closed", "merged", "gone"].contains(state) }
}

struct Stats: Codable, Hashable {
    var total: Int
    var today: Int
    var streak: Int
    var bestStreak: Int
    var byPrompt: [String: Int]?
    var byChannel: [String: Int]?
}

struct SyncStatus: Codable, Hashable {
    struct Waiting: Codable, Hashable {
        var channel: String
        var repo: String
    }
    /// When this Mac last agreed with Slack; empty when it never has.
    var syncedAt: String
    /// The computer that had last written the note then.
    var from: String
    /// Synced links waiting for a checkout on this Mac.
    var waiting: [Waiting]
}

struct SessionsReply: Codable {
    var sessions: [AppSession]
    var stats: Stats
}

struct Health: Codable, Hashable {
    struct DebugPort: Codable, Hashable {
        var port: Int
        var open: Bool
        var isSlack: Bool
        var matching: Int
    }
    struct Agent: Codable, Hashable {
        var id: String
        var label: String
        var host: String
    }
    var attached: Int
    var slackRunning: Bool
    var debugPort: DebugPort
    var agent: Agent
    var terminal: String
}

struct Hello: Codable {
    var protocolVersion: Int
    var version: String
    var build: String

    enum CodingKeys: String, CodingKey {
        case protocolVersion = "protocol"
        case version, build
    }
}

struct AgentSetting: Codable, Hashable {
    var id: String
    var command: String
    var args: [String]
}

/// Every setting in ~/.sidequest/config.json, as src/config/schema.ts defines them.
struct SidequestSettings: Codable, Hashable {
    var worktreesRoot: String
    var terminal: String
    var warpStrategy: String
    var warpPreview: Bool
    var tmuxSession: String
    var agent: AgentSetting
    var skipPermissions: Bool
    var headlessApprovals: Bool
    var fetchBeforeCreate: Bool
    var threadContextLimit: Int
    var repoSearchRoots: [String]
    var pruneBranchesOnClean: Bool
    var autoClean: Bool
    var autoCleanAfterDays: Double
    var cdpPort: Int
    var relaunchSlack: Bool
    var targetUrlPattern: String
    var autoReply: Bool
    var reactions: Bool
    var postResults: String
    var trackStatus: Bool
    var notify: Bool
    var verbose: Bool
    var sync: Bool
}

struct RepoLink: Codable, Hashable, Identifiable {
    var repoPath: String
    var channel: String
    var baseBranch: String
    var label: String
    var linkedBy: String
    var linkedAt: String
    var remote: String

    var id: String { "\(channel)\u{0}\(repoPath)" }
    var displayLabel: String { label.isEmpty ? (repoPath as NSString).lastPathComponent : label }
}

/// A user override for one prompt; nil fields fall back to the built-in.
struct PromptOverride: Codable, Hashable {
    var label: String?
    var emoji: String?
    var template: String?
    var branchPrefix: String?
    var reply: String?
    var hidden: Bool?
    var agent: String?
}

struct Config: Codable, Hashable {
    var settings: SidequestSettings
    var channels: [String: [RepoLink]]
    var prompts: [String: PromptOverride]
}

/// A prompt as it stands, the override merged over its default.
struct Prompt: Codable, Hashable {
    var label: String
    var emoji: String
    var template: String
    var branchPrefix: String
    var reply: String
    var agent: String
}

struct PromptEntry: Codable, Hashable, Identifiable {
    var key: String
    var hidden: Bool
    var builtIn: Bool
    var prompt: Prompt
    var id: String { key }
}

struct AgentChoice: Codable, Hashable, Identifiable {
    var id: String
    var label: String
    var host: String
    var headless: Bool
    var app: Bool
}

struct TerminalChoice: Codable, Hashable, Identifiable {
    var id: String
    var label: String
    var summary: String
}

struct ConfigReply: Codable {
    var config: Config
    var prompts: [PromptEntry]
    var agents: [AgentChoice]
    var terminals: [TerminalChoice]
}

/// One of doctor's checks.
struct CheckRow: Codable, Hashable, Identifiable {
    var status: String
    var label: String
    var detail: String
    var section: String?
    var id: String { label }
    var failed: Bool { status == "fail" }
}

struct ChecksReply: Codable {
    var rows: [CheckRow]
}

struct ResultReply: Codable {
    var text: String
    var label: String
    var channel: String
    var permalink: String
    var agent: String
}

struct CleanReply: Codable {
    var removed: Int
    var kept: Int
}

struct Notice: Codable, Hashable {
    var title: String
    var body: String
    var branch: String?
}

enum ISODate {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()

    static func parse(_ text: String) -> Date? {
        withFraction.date(from: text) ?? plain.date(from: text)
    }
}

// MARK: Headless workspace

/// One step of a headless run, as src/session/transcript.ts reads it.
struct TranscriptItem: Codable, Hashable {
    /// you, agent, tool, error, done or log.
    var kind: String
    var text: String
    var tool: String?
}

struct TranscriptReply: Codable {
    var items: [TranscriptItem]
    /// The index of the first item, so a poll appends; 0 starts over.
    var from: Int
    var total: Int
    /// From the agent's event stream, rather than its plain log.
    var structured: Bool
    var running: Bool
}

struct ChangedFile: Codable, Hashable, Identifiable {
    var path: String
    var added: Int?
    var removed: Int?
    /// modified, added or deleted.
    var status: String
    var id: String { path }
}

struct ChangesReply: Codable {
    var files: [ChangedFile]
}

struct FileDiffReply: Codable {
    var patch: String
}

struct TerminalCommandReply: Codable {
    var cwd: String
    var argv: [String]
}

/// A headless agent asking whether it may use a tool.
struct Approval: Codable, Hashable, Identifiable {
    var id: String
    var branch: String
    var worktreePath: String
    var title: String
    var tool: String
    /// For a shell, "always" covers this exact command only.
    var perCommand: Bool?
    var summary: String
    var askedAt: String
}

struct ApprovalsReply: Codable {
    var approvals: [Approval]
}

struct ApprovalEvent: Codable {
    var approval: Approval
}

struct ApprovalSettledEvent: Codable {
    var approvalId: String
}
