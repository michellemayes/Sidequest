import Foundation

/// Why a request to the daemon did not get the answer asked for.
struct DaemonError: LocalizedError, Equatable {
    var message: String
    var hint: String?

    var errorDescription: String? { message }
    var recoverySuggestion: String? { hint }

    static let notRunning = DaemonError(
        message: "Sidequest isn't running.",
        hint: "Start it, and it will connect to Slack."
    )
}

/// Talks to the running daemon over ~/.sidequest/control.sock: one JSON
/// object per line each way. Requests carry an id and get one answer with
/// it; lines with an `event` and no id are news after `subscribe`.
@MainActor
final class ControlClient {
    /// Called on the main actor for every event line, with its name and the whole line.
    var onEvent: ((String, Data) -> Void)?
    /// Called when the connection drops; the store reconnects.
    var onDisconnect: (() -> Void)?

    private let path: String
    private var handle: FileHandle?
    private var buffer = Data()
    private var nextId = 0
    private var pending: [String: CheckedContinuation<Data, Error>] = [:]

    init(path: String = ControlClient.defaultPath) {
        self.path = path
    }

    static var defaultPath: String {
        let root = ProcessInfo.processInfo.environment["SIDEQUEST_HOME"].flatMap { $0.isEmpty ? nil : $0 }
            ?? (NSHomeDirectory() as NSString).appendingPathComponent(".sidequest")
        return (root as NSString).appendingPathComponent("control.sock")
    }

    var isConnected: Bool { handle != nil }

    /// Open the socket. Throws `notRunning` when no daemon is listening.
    func connect() throws {
        if handle != nil { return }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw DaemonError.notRunning }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: address.sun_path)
        guard bytes.count < capacity else {
            close(fd)
            throw DaemonError(message: "The control socket's path is too long.", hint: path)
        }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, length) }
        }
        guard result == 0 else {
            close(fd)
            throw DaemonError.notRunning
        }

        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        handle.readabilityHandler = { [weak self] h in
            let data = h.availableData
            Task { @MainActor in self?.receive(data) }
        }
        self.handle = handle
    }

    func disconnect() {
        handle?.readabilityHandler = nil
        try? handle?.close()
        handle = nil
        buffer.removeAll()
        let waiting = pending
        pending.removeAll()
        for (_, continuation) in waiting { continuation.resume(throwing: DaemonError.notRunning) }
    }

    /// Send one request and wait for its answer line. An answer carrying
    /// `error` throws it, with the daemon's hint.
    func request(_ op: String, _ params: [String: Any] = [:]) async throws -> Data {
        if handle == nil { try connect() }
        guard let handle else { throw DaemonError.notRunning }
        nextId += 1
        let id = "app-\(nextId)"
        var body = params
        body["id"] = id
        body["op"] = op
        var line = try JSONSerialization.data(withJSONObject: body)
        line.append(0x0A)

        let data: Data = try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            do {
                try handle.write(contentsOf: line)
            } catch {
                pending[id] = nil
                continuation.resume(throwing: DaemonError.notRunning)
            }
        }
        if let failure = try? JSONDecoder().decode(ErrorLine.self, from: data), let message = failure.error {
            throw DaemonError(message: message, hint: failure.hint)
        }
        return data
    }

    /// Send a request and decode its answer.
    func request<T: Decodable>(_ op: String, _ params: [String: Any] = [:], as type: T.Type) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await request(op, params))
    }

    private struct ErrorLine: Decodable {
        var error: String?
        var hint: String?
    }

    private struct Envelope: Decodable {
        var id: String?
        var event: String?
    }

    private func receive(_ data: Data) {
        if data.isEmpty {
            // End of file: the daemon stopped.
            disconnect()
            onDisconnect?()
            return
        }
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<newline)
            buffer.removeSubrange(buffer.startIndex...newline)
            guard !line.isEmpty, let envelope = try? JSONDecoder().decode(Envelope.self, from: line) else { continue }
            if let id = envelope.id, let continuation = pending.removeValue(forKey: id) {
                continuation.resume(returning: line)
            } else if let event = envelope.event {
                onEvent?(event, line)
            }
        }
    }
}

/// Encodable values as the JSON objects JSONSerialization takes, for request params.
enum JSONParam {
    static func value<T: Encodable>(_ value: T) -> Any {
        guard let data = try? JSONEncoder().encode(value),
              let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return NSNull()
        }
        return object
    }
}
