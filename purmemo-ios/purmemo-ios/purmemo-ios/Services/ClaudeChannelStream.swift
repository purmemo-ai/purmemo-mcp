import Foundation
import os

private let logger = Logger(subsystem: "ai.purmemo.purmemo-ios", category: "SSE")

/// SSE client for real-time Claude Channel updates.
/// Connects to GET /api/v1/claude-channel/stream and pushes message events to the caller.
@Observable
class ClaudeChannelStream {
    private var task: Task<Void, Never>?
    private var authService: AuthService
    private var retryDelay: TimeInterval = 1
    private let maxRetryDelay: TimeInterval = 30
    private(set) var isConnected = false

    var onMessagesLoaded: (([ClaudeChannelMessage]) -> Void)?
    var onMessageReceived: ((ClaudeChannelMessage) -> Void)?
    var onMessageDeleted: ((String) -> Void)?

    init(authService: AuthService) {
        self.authService = authService
    }

    func connect() {
        disconnect()
        logger.notice("connect() called")
        task = Task { await streamLoop() }
    }

    func disconnect() {
        logger.notice("disconnect() called, wasConnected=\(self.isConnected)")
        task?.cancel()
        task = nil
        isConnected = false
    }

    private func streamLoop() async {
        logger.notice("streamLoop started")
        while !Task.isCancelled {
            do {
                try await openStream()
                logger.notice("openStream returned normally (stream ended)")
            } catch is CancellationError {
                logger.notice("streamLoop cancelled")
                break
            } catch {
                isConnected = false
                logger.error("streamLoop error: \(error.localizedDescription) — retrying in \(self.retryDelay)s")
                try? await Task.sleep(nanoseconds: UInt64(retryDelay * 1_000_000_000))
                retryDelay = min(retryDelay * 2, maxRetryDelay)
            }
        }
        isConnected = false
        logger.notice("streamLoop exited")
    }

    private func openStream() async throws {
        let token = try await authService.validToken()
        logger.notice("opening SSE connection...")
        let url = URL(string: "https://api.purmemo.ai/api/v1/claude-channel/stream")!
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        // Disable caching — SSE must not be cached
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = 300

        let (bytes, response) = try await URLSession.shared.bytes(for: request)

        if let http = response as? HTTPURLResponse {
            logger.notice("SSE HTTP status: \(http.statusCode)")
            if http.statusCode == 401 {
                _ = try? await authService.refreshToken()
                throw URLError(.userAuthenticationRequired)
            }
            guard (200...299).contains(http.statusCode) else {
                throw URLError(.badServerResponse)
            }
        }

        retryDelay = 1
        isConnected = true
        logger.notice("SSE connected — reading raw bytes")

        // Read raw bytes and split on newlines manually.
        // URLSession.AsyncBytes.lines buffers internally and doesn't yield
        // lines immediately, which breaks SSE real-time delivery.
        var lineBuffer = Data()

        for try await byte in bytes {
            if Task.isCancelled { break }

            if byte == UInt8(ascii: "\n") {
                let line = String(data: lineBuffer, encoding: .utf8) ?? ""
                lineBuffer.removeAll(keepingCapacity: true)
                processLine(line)
            } else {
                lineBuffer.append(byte)
            }
        }
        logger.notice("byte stream ended")
    }

    // SSE line state — accumulated across processLine calls
    private var eventType = ""
    private var dataBuffer = ""

    private func processLine(_ line: String) {
        if line.hasPrefix("event: ") {
            eventType = String(line.dropFirst(7))
        } else if line.hasPrefix("data: ") {
            dataBuffer += String(line.dropFirst(6))
        } else if line.isEmpty {
            // Empty line = end of SSE event
            if !eventType.isEmpty && !dataBuffer.isEmpty {
                logger.notice("SSE event: \(self.eventType) (\(self.dataBuffer.count) chars)")
                handleEvent(type: eventType, data: dataBuffer)
            }
            eventType = ""
            dataBuffer = ""
        }
    }

    private func handleEvent(type: String, data: String) {
        guard let jsonData = data.data(using: .utf8) else {
            logger.error("handleEvent: failed to convert data to utf8")
            return
        }

        switch type {
        case "connected":
            guard let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                  let items = json["messages"] as? [[String: Any]] else {
                logger.error("handleEvent: failed to parse connected payload")
                return
            }
            let messages = items.compactMap { PurmemoAPI.parseCCMessageDict($0) }
            logger.notice("connected: \(messages.count) messages loaded")
            Task { @MainActor in onMessagesLoaded?(messages) }

        case "response", "new_message":
            guard let dict = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                  let message = PurmemoAPI.parseCCMessageDict(dict) else {
                logger.error("handleEvent: failed to parse \(type) payload")
                return
            }
            logger.notice("\(type): \(message.direction) \(message.id.prefix(8))...")
            Task { @MainActor in onMessageReceived?(message) }

        case "delete":
            guard let dict = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any],
                  let id = dict["id"] as? String else {
                logger.error("handleEvent: failed to parse delete payload")
                return
            }
            logger.notice("delete: \(id.prefix(8))...")
            Task { @MainActor in onMessageDeleted?(id) }

        case "heartbeat":
            logger.notice("heartbeat received")

        default:
            logger.notice("unknown event: \(type)")
        }
    }
}
