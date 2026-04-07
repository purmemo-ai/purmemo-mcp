import Foundation

struct SaveMemoryRequest: Encodable {
    let content: String
    let source_type: String = "mobile_ios"
}

struct SaveMemoryResponse: Codable {
    let id: String
    let content: String
    let created_at: String
}

struct RecallMemory: Codable, Identifiable, Hashable {
    let id: String
    let title: String?
    let content: String
    let score: Double?
    let created_at: String?

    func hash(into hasher: inout Hasher) { hasher.combine(id) }
    static func == (lhs: RecallMemory, rhs: RecallMemory) -> Bool { lhs.id == rhs.id }
}

struct RecallResponse: Codable {
    let memories: [RecallMemory]
    let query: String?
}

// MARK: - Projects Intelligence

struct ProjectsSummary {
    let projects: [ProjectItem]
    let workItems: [WorkItem]
    let completions: [CompletionItem]
    let blockers: [BlockerItem]
}

struct ProjectItem: Identifiable {
    let name: String
    let memoryCount: Int
    let openItems: Int
    let blockerCount: Int
    let lastActivity: String?

    var id: String { name }
}

struct WorkItem: Identifiable {
    let memoryId: String
    let memoryTitle: String?
    let projectName: String?
    let text: String
    let type: String      // task, bug, feature, decision, question
    let priority: String  // urgent, high, medium, low
    let deadline: String?
    let sourceIndex: Int?

    var id: String { "\(memoryId)-\(text.prefix(20))" }

    var typeIcon: String {
        switch type {
        case "bug": return "ladybug"
        case "feature": return "sparkles"
        case "decision": return "arrow.triangle.branch"
        case "question": return "questionmark.circle"
        default: return "checklist"
        }
    }

    var priorityColor: String {
        switch priority {
        case "urgent": return "#FF3B30"
        case "high": return "#FF9500"
        case "medium": return "#E7FC44"
        default: return "#8E8E93"
        }
    }
}

struct CompletionItem: Identifiable {
    let memoryId: String
    let memoryTitle: String?
    let projectName: String?
    let text: String
    let createdAt: String?

    var id: String { "\(memoryId)-\(text.prefix(20))" }
}

struct BlockerItem: Identifiable {
    let memoryId: String
    let memoryTitle: String?
    let projectName: String?
    let text: String
    let severity: String  // critical, major, minor
    let blockingCause: String?
    let sourceIndex: Int?

    var id: String { "\(memoryId)-\(text.prefix(20))" }

    var severityColor: String {
        switch severity {
        case "critical": return "#FF3B30"
        case "major": return "#FF9500"
        default: return "#8E8E93"
        }
    }
}

struct FullMemory {
    let id: String
    let title: String?
    let content: String?
    let created_at: String?
    let updated_at: String?
    let source_type: String?
    let platform: String?
    let tags: [String]?

    // Intelligence fields
    let summary: String?
    let category: String?
    let intent: String?
    let status: String?
    let project_name: String?
    let technologies: [String]
    let observations: [MemoryObservation]
    let entities: [Entity]
    let workItems: [MemoryWorkItem]
    let blockers: [MemoryBlocker]
    let completions: [MemoryCompletion]
    let image_count: Int
    let has_images: Bool
    let word_count: Int?
    let read_time_minutes: Int?
}

struct MemoryObservation: Identifiable {
    let text: String
    let confidence: Double?
    let type: String? // fact, opinion, question, action

    var id: String { text }

    var typeIcon: String {
        switch type {
        case "fact": return "checkmark.seal"
        case "opinion": return "quote.bubble"
        case "question": return "questionmark.circle"
        case "action": return "bolt"
        default: return "circle.fill"
        }
    }
}

struct Entity: Identifiable {
    let name: String
    let type: String?

    var id: String { name }
}

struct MemoryWorkItem: Identifiable {
    let text: String
    let type: String?
    let priority: String?
    let status: String?

    var id: String { text }
}

struct MemoryBlocker: Identifiable {
    let text: String
    let severity: String?

    var id: String { text }
}

struct MemoryCompletion: Identifiable {
    let text: String

    var id: String { text }
}

// MARK: - Todos

struct TodoItem: Identifiable {
    let id: String
    let text: String
    var status: String        // pending, active, done, blocked
    let priority: String      // urgent, high, medium, low
    let sourceType: String    // extracted, manual, workflow
    let sourceMemoryId: String?
    let projectName: String?
    let notes: String?
    let deadline: String?
    let snoozedUntil: String?
    let completedAt: String?
    let createdAt: String?
    let updatedAt: String?

    var priorityColor: String {
        switch priority {
        case "urgent": return "#FF3B30"
        case "high": return "#FF9500"
        case "medium": return "#E7FC44"
        default: return "#8E8E93"
        }
    }

    var priorityIcon: String {
        switch priority {
        case "urgent": return "exclamationmark.triangle.fill"
        case "high": return "arrow.up.circle.fill"
        case "medium": return "minus.circle"
        default: return "arrow.down.circle"
        }
    }

    var statusIcon: String {
        switch status {
        case "active": return "circle.dashed"
        case "done": return "checkmark.circle.fill"
        case "blocked": return "xmark.octagon"
        default: return "circle"
        }
    }

    var isDone: Bool { status == "done" }
}

struct TodoSummary {
    let byProject: [[String: Any]]
    let activeCount: Int
}

struct TodoSuggestion: Identifiable {
    let id: String
    let todoId: String
    let memoryId: String
    let completionText: String
    let matchReason: String
    let confidence: Double
    let todoText: String?
    let memoryTitle: String?
}

// MARK: - Media Items

struct MediaItem: Identifiable {
    let id: String
    let title: String?
    let sourceUrl: String?
    let sourceType: String?
    let platform: String?
    let thumbnailUrl: String?
    let imageCount: Int
    let hasImages: Bool
    let createdAt: String?
    let category: String?

    var isLink: Bool { sourceUrl != nil && !hasImages }
    var isImage: Bool { hasImages }

    var mediaTypeIcon: String {
        if hasImages { return "photo" }
        if let url = sourceUrl?.lowercased() {
            if url.contains("youtube") || url.contains("youtu.be") || url.contains("tiktok") || url.contains("vimeo") { return "play.rectangle" }
            if url.contains("twitter") || url.contains("x.com") { return "bubble.left" }
        }
        return "link"
    }

    var sourceBadge: String? {
        if let url = sourceUrl?.lowercased() {
            if url.contains("youtube") || url.contains("youtu.be") { return "YouTube" }
            if url.contains("tiktok") { return "TikTok" }
            if url.contains("twitter") || url.contains("x.com") { return "X" }
            if url.contains("instagram") { return "Instagram" }
            if url.contains("reddit") { return "Reddit" }
            if url.contains("github") { return "GitHub" }
        }
        if let st = sourceType {
            if st.contains("ios_image") { return "Photos" }
            if st.contains("screenshot") { return "Screenshot" }
            if st.contains("desktop_clipboard") { return "Desktop" }
            if st.contains("chrome") { return "Chrome" }
        }
        return platform
    }
}

struct MediaListResponse {
    let items: [MediaItem]
    let total: Int
    let hasMore: Bool
}

// MARK: - Claude Channel Message

struct ClaudeChannelMessage: Identifiable {
    let id: String
    let content: String
    let contentPreview: String?
    let direction: String       // "inbound" | "outbound"
    let parentMessageId: String?
    let projectName: String?
    let sessionId: String?
    let targetSessionId: String?
    let createdAt: String?
    let updatedAt: String?

    var isInbound: Bool { direction == "inbound" }
    var isOutbound: Bool { direction == "outbound" }
    var displayText: String { contentPreview ?? content }
}

// MARK: - Claude Channel Session (v3)

struct ClaudeSession: Identifiable {
    let id: String
    let projectName: String
    let model: String?
    let cwd: String?
    let status: String          // "active" | "idle" | "disconnected"
    let lastHeartbeatAt: String?
    let registeredAt: String?
    let lastMessage: ClaudeChannelMessage?
    let unreadCount: Int

    var isActive: Bool { status == "active" }
    var isIdle: Bool { status == "idle" }
    var isDisconnected: Bool { status == "disconnected" }
}

// MARK: - Claude Channel Project (v3 — user-facing)

struct ClaudeProject: Identifiable {
    var id: String { projectName }
    let projectName: String
    let sessionId: String       // best active session for routing
    let model: String?
    let cwd: String?
    let status: String          // status of best session
    let lastHeartbeatAt: String?
    let activeSessionCount: Int
    let totalSessionCount: Int
    let lastMessage: ClaudeChannelMessage?
    let unreadCount: Int

    var isActive: Bool { status == "active" }
    var isIdle: Bool { status == "idle" }
}
