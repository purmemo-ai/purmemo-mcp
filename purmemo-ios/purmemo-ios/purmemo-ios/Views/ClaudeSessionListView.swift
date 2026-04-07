import SwiftUI

/// Project list for Claude Channel v3 — shows active projects (grouped sessions).
/// Tapping a project navigates to its chat view, routing to the best active session.
struct ClaudeSessionListView: View {
    var authService: AuthService
    var stream: ClaudeChannelStream?
    @Binding var claudeMessages: [ClaudeChannelMessage]
    var onSendBroadcast: (String) -> Void
    var onDeleteMessage: ((String) -> Void)?

    @State private var projects: [ClaudeProject] = []
    @State private var isLoading = false

    var body: some View {
        Group {
            if projects.isEmpty && !isLoading {
                emptyState
            } else {
                projectList
            }
        }
        .task { await loadProjects() }
        .refreshable { await loadProjects() }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "terminal.fill")
                .font(.system(size: 36))
                .foregroundColor(Color(hex: "#E7FC44").opacity(0.2))
            Text("No Active Projects")
                .font(.system(size: 15))
                .foregroundColor(.white.opacity(0.3))
            Text("Start a Claude Code session to see it here")
                .font(.system(size: 13))
                .foregroundColor(.white.opacity(0.2))
            Spacer()
        }
    }

    // MARK: - Project List

    private var projectList: some View {
        ScrollView {
            LazyVStack(spacing: 6) {
                ForEach(projects) { project in
                    NavigationLink(value: project.id) {
                        projectRow(project)
                    }
                    .buttonStyle(.plain)
                }

                // Broadcast row
                let broadcastCount = claudeMessages.filter { $0.targetSessionId == nil }.count
                if broadcastCount > 0 || !projects.isEmpty {
                    NavigationLink(value: "__broadcast__") {
                        broadcastRow(messageCount: broadcastCount)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
        .navigationDestination(for: String.self) { projectId in
            if projectId == "__broadcast__" {
                ClaudeSessionChatView(
                    authService: authService,
                    sessionId: nil,
                    sessionName: "Broadcast",
                    sessionStatus: "active",
                    stream: stream,
                    claudeMessages: $claudeMessages,
                    onDelete: onDeleteMessage
                )
            } else {
                let project = projects.first(where: { $0.id == projectId })
                ClaudeSessionChatView(
                    authService: authService,
                    sessionId: project?.sessionId,
                    sessionName: project?.projectName ?? "Project",
                    sessionStatus: project?.status ?? "disconnected",
                    stream: stream,
                    claudeMessages: $claudeMessages,
                    onDelete: onDeleteMessage
                )
            }
        }
    }

    // MARK: - Project Row

    private func projectRow(_ project: ClaudeProject) -> some View {
        HStack(spacing: 12) {
            // Status dot
            Circle()
                .fill(statusColor(project.status))
                .frame(width: 8, height: 8)

            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(project.projectName)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(.white)

                    if project.activeSessionCount > 1 {
                        Text("\(project.activeSessionCount)")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(.white.opacity(0.4))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color.white.opacity(0.08))
                            .clipShape(Capsule())
                    }

                    Spacer()

                    if let lastMsg = project.lastMessage, let date = lastMsg.createdAt {
                        Text(formatRelative(date))
                            .font(.system(size: 11))
                            .foregroundColor(.white.opacity(0.2))
                    }
                }

                HStack {
                    if let lastMsg = project.lastMessage {
                        let prefix = lastMsg.direction == "outbound" ? "Claude: " : "You: "
                        Text(prefix + lastMsg.displayText)
                            .font(.system(size: 13))
                            .foregroundColor(.white.opacity(0.4))
                            .lineLimit(1)
                    } else {
                        Text(project.status)
                            .font(.system(size: 13))
                            .foregroundColor(.white.opacity(0.2))
                            .italic()
                    }

                    Spacer()

                    if project.unreadCount > 0 {
                        Text("\(project.unreadCount)")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundColor(.black)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color(hex: "#E7FC44"))
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Color(hex: "#1a1a1a"))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.white.opacity(0.04), lineWidth: 1)
        )
    }

    // MARK: - Broadcast Row

    private func broadcastRow(messageCount: Int) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "megaphone.fill")
                .font(.system(size: 12))
                .foregroundColor(Color(hex: "#E7FC44").opacity(0.5))

            VStack(alignment: .leading, spacing: 3) {
                Text("Broadcast")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundColor(.white.opacity(0.6))
                Text("Messages to all sessions")
                    .font(.system(size: 13))
                    .foregroundColor(.white.opacity(0.2))
            }

            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Color(hex: "#1a1a1a").opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.white.opacity(0.02), lineWidth: 1)
        )
    }

    // MARK: - Helpers

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "active": return .green
        case "idle": return .yellow
        default: return .gray.opacity(0.4)
        }
    }

    private func formatRelative(_ dateStr: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: dateStr) else {
            formatter.formatOptions = [.withInternetDateTime]
            guard let date2 = formatter.date(from: dateStr) else { return "" }
            return relativeString(from: date2)
        }
        return relativeString(from: date)
    }

    private func relativeString(from date: Date) -> String {
        let seconds = Date().timeIntervalSince(date)
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86400 { return "\(Int(seconds / 3600))h" }
        return "\(Int(seconds / 86400))d"
    }

    private func loadProjects() async {
        let api = PurmemoAPI(authService: authService)
        do {
            projects = try await api.getClaudeProjects()
        } catch {}
        isLoading = false
    }
}
