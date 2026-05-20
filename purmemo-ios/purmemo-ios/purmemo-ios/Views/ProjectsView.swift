import SwiftUI

struct ProjectsView: View {
    var authService: AuthService
    @State private var summary: ProjectsSummary?
    @State private var isLoading = true
    @State private var selectedTab = 0
    @State private var selectedMemoryId: String?
    @State private var selectedMemoryTitle: String?
    @State private var addedTodoIds: Set<String> = []
    @State private var showSettings = false
    @State private var selectedProject: ProjectItem?
    @State private var blockersExpanded = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                header
                segmentedControl

                if isLoading {
                    Spacer()
                    RingLoader(size: 56)
                    Spacer()
                } else if let summary {
                    TabView(selection: $selectedTab) {
                        projectsList(summary)
                            .tag(0)
                        workItemsList(summary)
                            .tag(1)
                        completionsList(summary)
                            .tag(2)
                    }
                    .tabViewStyle(.page(indexDisplayMode: .never))
                    .background(Color.clear)
                    .ignoresSafeArea(edges: .bottom)
                } else {
                    emptyState
                }
            }
        }
        .preferredColorScheme(.dark)
        .task { await loadData() }
        .sheet(isPresented: Binding(
            get: { selectedMemoryId != nil },
            set: { if !$0 { selectedMemoryId = nil; selectedMemoryTitle = nil } }
        )) {
            if let memId = selectedMemoryId {
                MemoryDetailView(memoryId: memId, memoryTitle: selectedMemoryTitle, authService: authService)
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(authService: authService)
        }
        .sheet(isPresented: Binding(
            get: { selectedProject != nil },
            set: { if !$0 { selectedProject = nil } }
        )) {
            if let project = selectedProject, let summary {
                ProjectDetailView(
                    project: project,
                    workItems: summary.workItems,
                    blockers: summary.blockers,
                    completions: summary.completions,
                    authService: authService
                )
            }
        }
    }

    private func openMemory(_ id: String, title: String?) {
        selectedMemoryId = id
        selectedMemoryTitle = title
    }

    // MARK: - Header

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 6) {
                Image("PurmemoWordmark")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(height: 34)
                Text("Project Intelligence")
                    .font(.system(size: 12))
                    .foregroundColor(.white.opacity(0.4))
            }
            Spacer()
            Button { showSettings = true } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 18))
                    .foregroundColor(.white.opacity(0.5))
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .background(Color.black)
    }

    // MARK: - Segmented Control

    private var segmentedControl: some View {
        HStack(spacing: 0) {
            segmentButton("Projects", tab: 0, count: summary?.projects.count)
            segmentButton("Action Items", tab: 1, count: summary?.workItems.count)
            segmentButton("Shipped", tab: 2, count: summary?.completions.count)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .background(Color.black)
        .overlay(
            Rectangle()
                .fill(Color.white.opacity(0.06))
                .frame(height: 0.5),
            alignment: .bottom
        )
    }

    private func segmentButton(_ title: String, tab: Int, count: Int?) -> some View {
        Button { withAnimation(.easeInOut(duration: 0.2)) { selectedTab = tab } } label: {
            VStack(spacing: 6) {
                HStack(spacing: 4) {
                    Text(title)
                        .font(.system(size: 13, weight: selectedTab == tab ? .semibold : .regular))
                        .foregroundColor(selectedTab == tab ? .white : .white.opacity(0.4))
                    if let count, count > 0 {
                        Text("\(count)")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundColor(selectedTab == tab ? .black : .white.opacity(0.4))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(selectedTab == tab ? Color(hex: "#E7FC44") : Color.white.opacity(0.1))
                            .clipShape(Capsule())
                    }
                }
                Rectangle()
                    .fill(selectedTab == tab ? Color(hex: "#E7FC44") : Color.clear)
                    .frame(height: 2)
                    .clipShape(Capsule())
            }
        }
        .frame(maxWidth: .infinity)
    }

    // MARK: - Projects List

    private func projectsList(_ summary: ProjectsSummary) -> some View {
        ScrollView {
            VStack(spacing: 4) {
                if !summary.blockers.isEmpty {
                    blockerStack(summary.blockers)
                        .padding(.horizontal, 12)
                }

                BubbleGridView(
                    projects: summary.projects,
                    onSelect: { selectedProject = $0 }
                )
                .padding(.horizontal, 12)
            }
            .padding(.top, 6)
            .padding(.bottom, 60)
        }
        .refreshable { await loadData() }
    }

    private func blockerRow(_ blocker: BlockerItem) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(Color(hex: blocker.severityColor))
                .frame(width: 8, height: 8)
            VStack(alignment: .leading, spacing: 2) {
                Text(blocker.text)
                    .font(.system(size: 13))
                    .foregroundColor(.white)
                    .lineLimit(2)
                Text(displayLabel(project: blocker.projectName, memoryTitle: blocker.memoryTitle))
                    .font(.system(size: 11))
                    .foregroundColor(.white.opacity(0.3))
                    .lineLimit(1)
            }
            Spacer()
            addTodoButton(text: blocker.text, memoryId: blocker.memoryId, field: "blocker", project: blocker.projectName, priority: blocker.severity == "critical" ? "urgent" : "high", sourceIndex: blocker.sourceIndex)
        }
        .padding(12)
        .background(Color(hex: "#1a1a1a"))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color(hex: blocker.severityColor).opacity(0.2), lineWidth: 1)
        )
    }

    // MARK: - Blocker Stack

    private func blockerStack(_ blockers: [BlockerItem]) -> some View {
        VStack(spacing: 0) {
            // Header — always visible, tappable
            Button {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                    blockersExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 12))
                        .foregroundColor(Color(hex: "#FF3B30"))
                    Text("\(blockers.count) Blocker\(blockers.count == 1 ? "" : "s")")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(Color(hex: "#FF3B30"))
                    Spacer()
                    // Preview: first blocker text
                    if !blockersExpanded {
                        Text(blockers.first?.text ?? "")
                            .font(.system(size: 12))
                            .foregroundColor(.white.opacity(0.4))
                            .lineLimit(1)
                            .frame(maxWidth: 160, alignment: .trailing)
                    }
                    Image(systemName: blockersExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(.white.opacity(0.3))
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .buttonStyle(.plain)

            // Expanded: show all blockers
            if blockersExpanded {
                VStack(spacing: 1) {
                    ForEach(blockers) { blocker in
                        Button { openMemory(blocker.memoryId, title: blocker.memoryTitle) } label: {
                            HStack(spacing: 10) {
                                Circle()
                                    .fill(Color(hex: blocker.severityColor))
                                    .frame(width: 6, height: 6)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(blocker.text)
                                        .font(.system(size: 13))
                                        .foregroundColor(.white)
                                        .lineLimit(2)
                                        .multilineTextAlignment(.leading)
                                    Text(displayLabel(project: blocker.projectName, memoryTitle: blocker.memoryTitle))
                                        .font(.system(size: 11))
                                        .foregroundColor(.white.opacity(0.3))
                                        .lineLimit(1)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 10))
                                    .foregroundColor(.white.opacity(0.15))
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .background(Color(hex: "#1a1a1a"))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color(hex: "#FF3B30").opacity(0.2), lineWidth: 1)
        )
        // Stacked card effect — show cards peeking behind when collapsed
        .background(
            Group {
                if !blockersExpanded && blockers.count > 1 {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(Color(hex: "#1a1a1a").opacity(0.6))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12)
                                .stroke(Color(hex: "#FF3B30").opacity(0.1), lineWidth: 1)
                        )
                        .offset(y: 6)
                        .padding(.horizontal, 6)
                }
            }
        )
        .background(
            Group {
                if !blockersExpanded && blockers.count > 2 {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(Color(hex: "#1a1a1a").opacity(0.3))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12)
                                .stroke(Color(hex: "#FF3B30").opacity(0.05), lineWidth: 1)
                        )
                        .offset(y: 12)
                        .padding(.horizontal, 12)
                }
            }
        )
        .padding(.bottom, blockersExpanded ? 0 : (blockers.count > 2 ? 12 : blockers.count > 1 ? 6 : 0))
    }

    // MARK: - Work Items List

    private func workItemsList(_ summary: ProjectsSummary) -> some View {
        ScrollView {
            LazyVStack(spacing: 6) {
                ForEach(summary.workItems) { item in
                    Button { openMemory(item.memoryId, title: item.memoryTitle) } label: {
                        workItemRow(item)
                    }
                    .buttonStyle(.plain)
                }
                if summary.workItems.isEmpty {
                    emptySection("No open work items", icon: "checkmark.circle")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .padding(.bottom, 60)
        }
        .refreshable { await loadData() }
    }

    private func workItemRow(_ item: WorkItem) -> some View {
        HStack(spacing: 10) {
            Image(systemName: item.typeIcon)
                .font(.system(size: 13))
                .foregroundColor(Color(hex: item.priorityColor))
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 3) {
                Text(item.text)
                    .font(.system(size: 14))
                    .foregroundColor(.white)
                    .lineLimit(2)
                HStack(spacing: 8) {
                    Text(displayLabel(project: item.projectName, memoryTitle: item.memoryTitle))
                        .font(.system(size: 11))
                        .foregroundColor(.white.opacity(0.3))
                        .lineLimit(1)
                    Text(item.type)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(.white.opacity(0.4))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Color.white.opacity(0.06))
                        .clipShape(Capsule())
                }
            }

            Spacer(minLength: 4)

            addTodoButton(text: item.text, memoryId: item.memoryId, field: "work_item", project: item.projectName, priority: item.priority, sourceIndex: item.sourceIndex)
        }
        .padding(12)
        .background(Color(hex: "#1a1a1a"))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.white.opacity(0.04), lineWidth: 1)
        )
    }

    // MARK: - Completions List

    private func completionsList(_ summary: ProjectsSummary) -> some View {
        ScrollView {
            LazyVStack(spacing: 6) {
                let grouped = groupCompletionsByTimeline(summary.completions)
                ForEach(grouped, id: \.title) { group in
                    timelineHeader(group.title)
                    ForEach(group.completions) { item in
                        Button { openMemory(item.memoryId, title: item.memoryTitle) } label: {
                            completionRow(item)
                        }
                        .buttonStyle(.plain)
                    }
                }
                if summary.completions.isEmpty {
                    emptySection("No recent completions", icon: "tray")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .padding(.bottom, 60)
        }
        .refreshable { await loadData() }
    }

    private func completionRow(_ item: CompletionItem) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 14))
                .foregroundColor(Color(hex: "#E7FC44"))

            VStack(alignment: .leading, spacing: 3) {
                Text(item.text)
                    .font(.system(size: 14))
                    .foregroundColor(.white)
                    .lineLimit(2)
                HStack(spacing: 8) {
                    Text(displayLabel(project: item.projectName, memoryTitle: item.memoryTitle))
                        .font(.system(size: 11))
                        .foregroundColor(.white.opacity(0.3))
                        .lineLimit(1)
                    if let date = item.createdAt {
                        Text(formatRelative(date))
                            .font(.system(size: 11))
                            .foregroundColor(.white.opacity(0.2))
                    }
                }
            }
            Spacer()
        }
        .padding(12)
        .background(Color(hex: "#1a1a1a"))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Add to Todos

    private func addTodoButton(text: String, memoryId: String, field: String, project: String?, priority: String, sourceIndex: Int? = nil) -> some View {
        let itemKey = "\(memoryId)-\(text.prefix(20))"
        let added = addedTodoIds.contains(itemKey)

        return Button {
            guard !added else { return }
            Task { await addToTodos(text: text, memoryId: memoryId, field: field, project: project, priority: priority, sourceIndex: sourceIndex, key: itemKey) }
        } label: {
            Image(systemName: added ? "checkmark.circle.fill" : "plus.circle")
                .font(.system(size: 18))
                .foregroundColor(added ? Color(hex: "#E7FC44") : .white.opacity(0.25))
        }
        .buttonStyle(.plain)
    }

    private func addToTodos(text: String, memoryId: String, field: String, project: String?, priority: String, sourceIndex: Int?, key: String) async {
        let api = PurmemoAPI(authService: authService)
        do {
            _ = try await api.createTodo(
                text: text,
                priority: priority,
                sourceType: "extracted",
                sourceMemoryId: memoryId,
                sourceField: field,
                sourceIndex: sourceIndex,
                projectName: project
            )
            _ = withAnimation { addedTodoIds.insert(key) }
        } catch {}
    }

    // MARK: - Helpers

    private func sectionHeader(_ title: String, icon: String, color: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundColor(Color(hex: color))
            Text(title.uppercased())
                .font(.system(size: 11, weight: .bold))
                .foregroundColor(Color(hex: color))
                .tracking(0.8)
            Spacer()
        }
        .padding(.top, 4)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "chart.bar.doc.horizontal")
                .font(.system(size: 36))
                .foregroundColor(.white.opacity(0.15))
            Text("No project data yet")
                .font(.system(size: 15))
                .foregroundColor(.white.opacity(0.3))
            Text("Save conversations to see projects here")
                .font(.system(size: 13))
                .foregroundColor(.white.opacity(0.2))
            Spacer()
        }
    }

    private func emptySection(_ text: String, icon: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 24))
                .foregroundColor(.white.opacity(0.15))
            Text(text)
                .font(.system(size: 13))
                .foregroundColor(.white.opacity(0.3))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }

    /// Shows project name if resolved, otherwise falls back to memory title
    private func displayLabel(project: String?, memoryTitle: String?) -> String {
        if let project, project != "Other", !project.isEmpty {
            return project
        }
        if let title = memoryTitle, !title.isEmpty {
            return String(title.prefix(40))
        }
        return "Uncategorized"
    }

    private func formatRelative(_ dateString: String) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: dateString) {
            let rel = RelativeDateTimeFormatter()
            rel.unitsStyle = .abbreviated
            return rel.localizedString(for: date, relativeTo: Date())
        }
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: dateString) {
            let rel = RelativeDateTimeFormatter()
            rel.unitsStyle = .abbreviated
            return rel.localizedString(for: date, relativeTo: Date())
        }
        return String(dateString.prefix(10))
    }

    // MARK: - Timeline Grouping

    private func parseDate(_ dateString: String?) -> Date? {
        guard let dateString else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: dateString) { return d }
        f.formatOptions = [.withInternetDateTime]
        if let d = f.date(from: dateString) { return d }
        // Try plain date
        let df = DateFormatter()
        df.dateFormat = "yyyy-MM-dd"
        return df.date(from: String(dateString.prefix(10)))
    }

    private struct CompletionTimelineGroup {
        let title: String
        let completions: [CompletionItem]
    }

    private func groupCompletionsByTimeline(_ items: [CompletionItem]) -> [CompletionTimelineGroup] {
        let calendar = Calendar.current
        let now = Date()
        var today: [CompletionItem] = []
        var yesterday: [CompletionItem] = []
        var thisWeek: [CompletionItem] = []
        var thisMonth: [CompletionItem] = []
        var older: [CompletionItem] = []

        for item in items {
            guard let date = parseDate(item.createdAt) else {
                older.append(item)
                continue
            }
            if calendar.isDateInToday(date) {
                today.append(item)
            } else if calendar.isDateInYesterday(date) {
                yesterday.append(item)
            } else if let weekAgo = calendar.date(byAdding: .day, value: -7, to: now), date >= weekAgo {
                thisWeek.append(item)
            } else if let monthAgo = calendar.date(byAdding: .month, value: -1, to: now), date >= monthAgo {
                thisMonth.append(item)
            } else {
                older.append(item)
            }
        }

        var groups: [CompletionTimelineGroup] = []
        if !today.isEmpty { groups.append(CompletionTimelineGroup(title: "Today", completions: today)) }
        if !yesterday.isEmpty { groups.append(CompletionTimelineGroup(title: "Yesterday", completions: yesterday)) }
        if !thisWeek.isEmpty { groups.append(CompletionTimelineGroup(title: "This Week", completions: thisWeek)) }
        if !thisMonth.isEmpty { groups.append(CompletionTimelineGroup(title: "This Month", completions: thisMonth)) }
        if !older.isEmpty { groups.append(CompletionTimelineGroup(title: "Earlier", completions: older)) }
        return groups
    }

    private func timelineHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(.system(size: 11, weight: .bold))
            .foregroundColor(.white.opacity(0.3))
            .tracking(0.8)
            .padding(.top, 8)
    }

    private func loadData() async {
        isLoading = true
        let api = PurmemoAPI(authService: authService)
        do {
            summary = try await api.getProjectsSummary()
            // Load existing todos to know which items are already promoted
            let existingTodos = try await api.getTodos()
            var ids = Set<String>()
            for todo in existingTodos {
                if todo.sourceType == "extracted", let memId = todo.sourceMemoryId {
                    ids.insert("\(memId)-\(todo.text.prefix(20))")
                }
            }
            addedTodoIds = ids
        } catch {
            summary = nil
        }
        isLoading = false
    }
}
