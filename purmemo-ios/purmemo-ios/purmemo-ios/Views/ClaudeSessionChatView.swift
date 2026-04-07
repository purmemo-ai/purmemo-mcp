import SwiftUI

/// Per-session chat view for Claude Channel v3.
/// Shows messages targeted at (or produced by) a specific session, plus broadcasts.
/// sessionId == nil means "Broadcast" view (only untargeted messages).
struct ClaudeSessionChatView: View {
    var authService: AuthService
    let sessionId: String?
    let sessionName: String
    let sessionStatus: String
    var stream: ClaudeChannelStream?
    @Binding var claudeMessages: [ClaudeChannelMessage]
    var onDelete: ((String) -> Void)?

    @State private var isLoading = true
    @State private var newMessageText = ""
    @State private var expandedMessages: Set<String> = []
    @State private var showScrollToBottom = false
    @State private var scrollProxy: ScrollViewProxy?
    @Environment(\.dismiss) private var dismiss

    /// Filter messages relevant to this session
    private var filteredMessages: [ClaudeChannelMessage] {
        if let sid = sessionId {
            // Only messages explicitly targeted at or produced by this session
            // Broadcasts (targetSessionId == nil) belong in the Broadcast tab only
            return claudeMessages.filter { m in
                m.sessionId == sid || m.targetSessionId == sid
            }
        } else {
            // Broadcast view: only untargeted messages
            return claudeMessages.filter { $0.targetSessionId == nil }
        }
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                ZStack(alignment: .bottom) {
                    chatContent

                    if showScrollToBottom {
                        Button {
                            if let newest = filteredMessages.first {
                                withAnimation(.easeOut(duration: 0.3)) {
                                    scrollProxy?.scrollTo(newest.id, anchor: .bottom)
                                }
                            }
                        } label: {
                            Image(systemName: "arrow.down")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundColor(.white.opacity(0.7))
                                .frame(width: 36, height: 36)
                                .background(Color(hex: "#1a1a1a"))
                                .clipShape(Circle())
                                .overlay(
                                    Circle()
                                        .stroke(Color.white.opacity(0.1), lineWidth: 1)
                                )
                                .shadow(color: .black.opacity(0.4), radius: 4, y: 2)
                        }
                        .padding(.bottom, 8)
                        .transition(.opacity.combined(with: .scale(scale: 0.8)))
                    }
                }
                inputBar
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 6) {
                    if sessionId != nil {
                        Circle()
                            .fill(statusColor(sessionStatus))
                            .frame(width: 7, height: 7)
                    } else {
                        Image(systemName: "megaphone.fill")
                            .font(.system(size: 10))
                            .foregroundColor(Color(hex: "#E7FC44").opacity(0.5))
                    }
                    Text(sessionName)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(.white)
                }
            }
        }
        .task { await loadMessages() }
    }

    // MARK: - Chat Content

    private var chatContent: some View {
        Group {
            if isLoading && filteredMessages.isEmpty {
                VStack {
                    Spacer()
                    RingLoader(size: 40)
                    Spacer()
                }
            } else {
                if filteredMessages.isEmpty {
                    VStack {
                        Spacer()
                        Text("No messages yet")
                            .font(.system(size: 14))
                            .foregroundColor(.white.opacity(0.2))
                        Spacer()
                    }
                } else {
                    messageList(filteredMessages)
                }
            }
        }
    }

    private func messageList(_ msgs: [ClaudeChannelMessage]) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 4) {
                    ForEach(msgs.reversed()) { message in
                        messageBubble(message)
                            .id(message.id)
                            .onAppear {
                                // Hide FAB when newest message is visible
                                if message.id == msgs.first?.id {
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        showScrollToBottom = false
                                    }
                                }
                            }
                            .onDisappear {
                                // Show FAB when newest message scrolls out of view
                                if message.id == msgs.first?.id {
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        showScrollToBottom = true
                                    }
                                }
                            }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .padding(.bottom, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await loadMessages() }
            .onChange(of: msgs.count) { _, _ in
                if let newest = msgs.first {
                    withAnimation(.easeOut(duration: 0.3)) {
                        proxy.scrollTo(newest.id, anchor: .bottom)
                    }
                }
            }
            .onAppear {
                scrollProxy = proxy
                if let newest = msgs.first {
                    proxy.scrollTo(newest.id, anchor: .bottom)
                }
            }
        }
    }

    // MARK: - Message Views

    @ViewBuilder
    private func messageBubble(_ message: ClaudeChannelMessage) -> some View {
        if message.isInbound {
            userBubble(message)
        } else {
            claudeCard(message)
        }
    }

    // User messages: right-aligned chat bubble
    private func userBubble(_ message: ClaudeChannelMessage) -> some View {
        HStack {
            Spacer(minLength: 60)

            VStack(alignment: .trailing, spacing: 3) {
                Text(message.content)
                    .font(.system(size: 14))
                    .foregroundColor(.white)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 4) {
                    if message.targetSessionId == nil && sessionId != nil {
                        Text("broadcast")
                            .font(.system(size: 9, weight: .medium))
                            .foregroundColor(Color(hex: "#E7FC44").opacity(0.3))
                    }
                    if let date = message.createdAt {
                        Text(formatRelative(date))
                            .font(.system(size: 10))
                            .foregroundColor(.white.opacity(0.12))
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color(hex: "#E7FC44").opacity(0.15))
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(Color(hex: "#E7FC44").opacity(0.2), lineWidth: 1)
            )
        }
        .contextMenu {
            Button(role: .destructive) {
                Task { await deleteMessage(message) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    // Claude responses: full-width code-formatted card
    private func claudeCard(_ message: ClaudeChannelMessage) -> some View {
        let isExpanded = expandedMessages.contains(message.id)

        return VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack(spacing: 6) {
                Image(systemName: "brain.head.profile")
                    .font(.system(size: 10))
                    .foregroundColor(Color(hex: "#E7FC44").opacity(0.5))
                Text("Claude")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(Color(hex: "#E7FC44").opacity(0.5))
                Spacer()
                if let date = message.createdAt {
                    Text(formatRelative(date))
                        .font(.system(size: 10))
                        .foregroundColor(.white.opacity(0.15))
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 6)

            // Divider
            Rectangle()
                .fill(Color.white.opacity(0.04))
                .frame(height: 1)

            // Content — markdown rendered
            Text(renderMarkdown(message.content))
                .font(.system(size: 13))
                .foregroundColor(.white.opacity(0.8))
                .lineLimit(isExpanded ? nil : 12)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .textSelection(.enabled)

            // Show more/less
            if message.content.count > 500 {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        if isExpanded {
                            expandedMessages.remove(message.id)
                        } else {
                            expandedMessages.insert(message.id)
                        }
                    }
                } label: {
                    HStack {
                        Spacer()
                        Text(isExpanded ? "Show less" : "Show more")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(Color(hex: "#E7FC44").opacity(0.5))
                        Spacer()
                    }
                }
                .padding(.bottom, 6)
            }
        }
        .background(Color(hex: "#111111"))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.white.opacity(0.06), lineWidth: 1)
        )
        .contextMenu {
            Button(role: .destructive) {
                Task { await deleteMessage(message) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
            Button {
                UIPasteboard.general.string = message.content
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
        }
    }

    // MARK: - Input Bar

    private var inputBar: some View {
        HStack(spacing: 10) {
            TextField(
                sessionId != nil ? "Message \(sessionName)..." : "Broadcast to all sessions...",
                text: $newMessageText,
                axis: .vertical
            )
            .textFieldStyle(.plain)
            .font(.system(size: 15))
            .foregroundColor(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color(hex: "#1a1a1a"))
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .overlay(
                RoundedRectangle(cornerRadius: 20)
                    .stroke(Color.white.opacity(0.06), lineWidth: 1)
            )
            .lineLimit(1...4)

            if !newMessageText.trimmingCharacters(in: .whitespaces).isEmpty {
                Button {
                    sendMessage()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 28))
                        .foregroundColor(Color(hex: "#E7FC44"))
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color.black)
    }

    // MARK: - Actions

    private func loadMessages() async {
        // Messages come from the parent's SSE stream via claudeMessages/filteredMessages.
        // Just mark loading complete — the stream handles real-time updates.
        isLoading = false
    }

    private func sendMessage() {
        let text = newMessageText.trimmingCharacters(in: .whitespaces)
        guard !text.isEmpty else { return }
        newMessageText = ""
        Task {
            let api = PurmemoAPI(authService: authService)
            do {
                // Send to API — the SSE stream will deliver it back in real-time
                _ = try await api.sendClaudeChannelMessage(
                    content: text,
                    targetSessionId: sessionId
                )
            } catch {}
        }
    }

    private func deleteMessage(_ message: ClaudeChannelMessage) async {
        // Optimistic: remove from parent immediately, before API round-trip
        onDelete?(message.id)
        let api = PurmemoAPI(authService: authService)
        do {
            try await api.deleteClaudeChannelMessage(id: message.id)
        } catch {}
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

    // MARK: - Markdown Rendering

    private func renderMarkdown(_ text: String) -> AttributedString {
        let baseFont = UIFont.systemFont(ofSize: 13)
        let boldFont = UIFont.boldSystemFont(ofSize: 13)
        let codeFont = UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        let baseColor = UIColor.white.withAlphaComponent(0.8)
        let codeColor = UIColor(red: 0.91, green: 0.99, blue: 0.27, alpha: 0.85) // #E7FC44

        let result = NSMutableAttributedString()
        let lines = text.components(separatedBy: "\n")

        for (lineIdx, line) in lines.enumerated() {
            if lineIdx > 0 {
                result.append(NSAttributedString(string: "\n"))
            }

            // Process inline markdown: **bold** and `code`
            var i = line.startIndex
            while i < line.endIndex {
                // Check for **bold**
                if line[i] == "*",
                   line.index(after: i) < line.endIndex,
                   line[line.index(after: i)] == "*" {
                    let contentStart = line.index(i, offsetBy: 2)
                    if let endRange = line.range(of: "**", range: contentStart..<line.endIndex) {
                        let boldText = String(line[contentStart..<endRange.lowerBound])
                        let attrs: [NSAttributedString.Key: Any] = [
                            .font: boldFont,
                            .foregroundColor: UIColor.white
                        ]
                        result.append(NSAttributedString(string: boldText, attributes: attrs))
                        i = endRange.upperBound
                        continue
                    }
                }

                // Check for `inline code`
                if line[i] == "`" && (i == line.startIndex || line[line.index(before: i)] != "`") {
                    let contentStart = line.index(after: i)
                    if contentStart < line.endIndex,
                       let endIdx = line[contentStart...].firstIndex(of: "`") {
                        let codeText = String(line[contentStart..<endIdx])
                        let attrs: [NSAttributedString.Key: Any] = [
                            .font: codeFont,
                            .foregroundColor: codeColor,
                            .backgroundColor: UIColor.white.withAlphaComponent(0.06)
                        ]
                        result.append(NSAttributedString(string: codeText, attributes: attrs))
                        i = line.index(after: endIdx)
                        continue
                    }
                }

                // Regular character
                let attrs: [NSAttributedString.Key: Any] = [
                    .font: baseFont,
                    .foregroundColor: baseColor
                ]
                result.append(NSAttributedString(string: String(line[i]), attributes: attrs))
                i = line.index(after: i)
            }
        }

        return AttributedString(result)
    }
}
