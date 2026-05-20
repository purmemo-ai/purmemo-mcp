import Foundation
import UIKit

class PurmemoAPI {
    private let baseURL = "https://api.purmemo.ai"
    private let authService: AuthService

    init(authService: AuthService) {
        self.authService = authService
    }

    // MARK: - Save Memory

    func saveMemory(content: String) async throws -> SaveMemoryResponse {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/memories/")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let body = ["content": content, "source_type": "mobile_ios"]
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await perform(request)

        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, _) = try await perform(request)
            return try JSONDecoder().decode(SaveMemoryResponse.self, from: retryData)
        }

        return try JSONDecoder().decode(SaveMemoryResponse.self, from: data)
    }

    // MARK: - Save Screenshot Memory

    func saveScreenshotMemory(imageData: Data, context: String) async throws -> SaveMemoryResponse {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/memories/")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        // Compress to JPEG and base64-encode
        let jpeg = UIImage(data: imageData)?.jpegData(compressionQuality: 0.5) ?? imageData
        let base64 = jpeg.base64EncodedString()

        let body: [String: Any] = [
            "title": String(context.prefix(60)),
            "content": "\(context)\n\n[Image attached]",
            "source_type": "ios_image_capture",
            "metadata": [
                "image_base64": base64,
                "image_mime": "image/jpeg"
            ]
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await perform(request)

        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, _) = try await perform(request)
            return try JSONDecoder().decode(SaveMemoryResponse.self, from: retryData)
        }

        return try JSONDecoder().decode(SaveMemoryResponse.self, from: data)
    }

    // MARK: - Create Memory (returns ID, no images)

    func createMemory(content: String, title: String, sourceType: String) async throws -> String {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/memories/")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15

        let body: [String: Any] = [
            "content": content,
            "title": title,
            "source_type": sourceType
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await perform(request)

        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, _) = try await perform(request)
            return try parseMemoryId(retryData)
        }

        return try parseMemoryId(data)
    }

    private func parseMemoryId(_ data: Data) throws -> String {
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = json["id"] as? String ?? json["memory_id"] as? String else {
            throw APIError.decodingError
        }
        return id
    }

    // MARK: - Upload Image (multipart, one at a time)

    func uploadImage(memoryId: String, imageData: Data, position: Int, isPrivate: Bool, ocrText: String?) async throws {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/memories/\(memoryId)/images")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 30

        let boundary = UUID().uuidString
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()

        // Image file
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"image\"; filename=\"image_\(position).jpg\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: image/jpeg\r\n\r\n".data(using: .utf8)!)
        body.append(imageData)
        body.append("\r\n".data(using: .utf8)!)

        // Position
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"position\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(position)\r\n".data(using: .utf8)!)

        // Private flag
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"private\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(isPrivate)\r\n".data(using: .utf8)!)

        // OCR text
        if let ocr = ocrText, !ocr.isEmpty {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"ocr_text\"\r\n\r\n".data(using: .utf8)!)
            body.append(ocr.data(using: .utf8)!)
            body.append("\r\n".data(using: .utf8)!)
        }

        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body

        let (_, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw APIError.serverError(http.statusCode)
        }
    }

    // MARK: - Upload Voice Note (multipart audio)

    func uploadVoiceNote(memoryId: String, fileURL: URL, durationSeconds: Int) async throws {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/memories/\(memoryId)/audio")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        // Audio transcription can take 30+ seconds for long voice notes.
        request.timeoutInterval = 300

        let boundary = UUID().uuidString
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        let audioData = try Data(contentsOf: fileURL)

        var body = Data()

        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"audio\"; filename=\"voice-note.m4a\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: audio/mp4\r\n\r\n".data(using: .utf8)!)
        body.append(audioData)
        body.append("\r\n".data(using: .utf8)!)

        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"duration_seconds\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(durationSeconds)\r\n".data(using: .utf8)!)

        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body

        do {
            let (_, response) = try await perform(request)
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                throw APIError.serverError(http.statusCode)
            }
        } catch let error as URLError where error.code == .cancelled || error.code == .networkConnectionLost || error.code == .timedOut {
            print("[audio-upload] tolerated client abort for memory=\(memoryId): \(error.code.rawValue)")
            throw APIError.clientAborted
        }
    }

    // MARK: - Retry Audio Transcription

    /// Re-enqueue a failed transcription job. Uses the storage_path the
    /// original upload stashed on the memory's metadata, so no audio is
    /// re-uploaded — only the job row is recreated and the worker kicked.
    func retryAudioTranscription(memoryId: String) async throws {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/memories/\(memoryId)/audio/retry")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 30

        let (_, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (_, retryResp) = try await perform(request)
            if let http = retryResp as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                throw APIError.serverError(http.statusCode)
            }
            return
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw APIError.serverError(http.statusCode)
        }
    }

    // MARK: - Trash (list + restore)

    struct TrashedMemory: Identifiable {
        let id: String
        let title: String?
        let deletedAt: String?
        let createdAt: String?
        let hasAudio: Bool
        let hasImages: Bool
    }

    func listTrashed(limit: Int = 100) async throws -> [TrashedMemory] {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/memories/trash?limit=\(limit)")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15

        let (data, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw APIError.serverError(http.statusCode)
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw APIError.decodingError
        }
        let rows = (json["memories"] as? [[String: Any]]) ?? (json["items"] as? [[String: Any]]) ?? []
        return rows.compactMap { m -> TrashedMemory? in
            guard let id = m["id"] as? String else { return nil }
            let metadata = m["metadata"] as? [String: Any]
            return TrashedMemory(
                id: id,
                title: m["title"] as? String,
                deletedAt: m["deleted_at"] as? String,
                createdAt: m["created_at"] as? String,
                hasAudio: (m["has_audio"] as? Bool) ?? (metadata?["audio_storage_path"] is String),
                hasImages: (m["has_images"] as? Bool) ?? ((m["image_count"] as? Int ?? 0) > 0)
            )
        }
    }

    func restoreMemory(memoryId: String) async throws {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/memories/\(memoryId)/restore")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15

        let (_, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw APIError.serverError(http.statusCode)
        }
    }

    // MARK: - Delete Memory (soft delete)

    func deleteMemory(memoryId: String) async throws {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/memories/\(memoryId)")!
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15

        let (_, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw APIError.serverError(http.statusCode)
        }
    }

    // MARK: - Voice Note Signed URL

    func getVoiceNoteSignedURL(memoryId: String) async throws -> URL {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/memories/\(memoryId)/audio/url")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15

        let (data, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw APIError.serverError(http.statusCode)
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let urlString = json["url"] as? String,
              let signed = URL(string: urlString) else {
            throw APIError.decodingError
        }
        return signed
    }

    // MARK: - Get Memory Images

    func getMemoryImages(memoryId: String) async throws -> [String] {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/memories/\(memoryId)/images")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await perform(request)
        let httpStatus = (response as? HTTPURLResponse)?.statusCode ?? 0

        if httpStatus == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, _) = try await perform(request)
            return Self.parseImageUrls(retryData)
        }

        return Self.parseImageUrls(data)
    }

    private static func parseImageUrls(_ data: Data) -> [String] {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let images = json["images"] as? [[String: Any]] else { return [] }
        return images.compactMap { $0["url"] as? String }
    }

    // MARK: - Update Entities

    func updateEntities(memoryId: String, entities: [Entity]) async throws {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/memories/\(memoryId)")!
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let entityDicts = entities.map { e -> [String: String] in
            var d = ["name": e.name]
            if let type = e.type { d["type"] = type }
            return d
        }
        let body: [String: Any] = ["entities": entityDicts]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            _ = try await perform(request)
        }
    }

    // MARK: - Media List

    func getMediaItems(page: Int = 1, pageSize: Int = 40) async throws -> MediaListResponse {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/memories/?has_media=true&page=\(page)&page_size=\(pageSize)&sort=created_at&order=desc")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await perform(request)
        let httpStatus = (response as? HTTPURLResponse)?.statusCode ?? 0

        if httpStatus == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, _) = try await perform(request)
            return try Self.parseMediaList(retryData)
        }

        return try Self.parseMediaList(data)
    }

    private static func parseMediaList(_ data: Data) throws -> MediaListResponse {
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw APIError.decodingError
        }

        let total = json["total"] as? Int ?? 0
        let hasMore = json["has_more"] as? Bool ?? false

        var items: [MediaItem] = []
        if let memories = json["memories"] as? [[String: Any]] {
            for m in memories {
                let metadata = m["metadata"] as? [String: Any]
                let hasAudio = (m["has_audio"] as? Bool)
                    ?? (metadata?["audio_storage_path"] is String)
                items.append(MediaItem(
                    id: m["id"] as? String ?? "",
                    title: m["title"] as? String,
                    sourceUrl: m["source_url"] as? String,
                    sourceType: m["source_type"] as? String,
                    platform: m["platform"] as? String,
                    thumbnailUrl: m["thumbnail_url"] as? String,
                    imageCount: m["image_count"] as? Int ?? 0,
                    hasImages: m["has_images"] as? Bool ?? false,
                    hasAudio: hasAudio,
                    audioDurationSeconds: metadata?["audio_duration_seconds"] as? Int,
                    audioHasTranscript: (metadata?["audio_has_transcript"] as? Bool) ?? false,
                    audioPending: (metadata?["audio_pending"] as? Bool) ?? false,
                    createdAt: m["created_at"] as? String,
                    category: m["category"] as? String
                ))
            }
        }

        return MediaListResponse(items: items, total: total, hasMore: hasMore)
    }

    // MARK: - Projects Summary

    func getProjectsSummary() async throws -> ProjectsSummary {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/projects/summary")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await perform(request)
        let httpStatus = (response as? HTTPURLResponse)?.statusCode ?? 0

        if httpStatus == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, _) = try await perform(request)
            return try Self.parseProjectsSummary(retryData)
        }

        return try Self.parseProjectsSummary(data)
    }

    private static func parseProjectsSummary(_ data: Data) throws -> ProjectsSummary {
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw APIError.decodingError
        }

        var projects: [ProjectItem] = []
        if let items = json["projects"] as? [[String: Any]] {
            for item in items {
                projects.append(ProjectItem(
                    name: item["project_name"] as? String ?? "Untitled",
                    memoryCount: (item["memory_count"] as? Int) ?? Int(item["memory_count"] as? String ?? "0") ?? 0,
                    openItems: (item["open_items"] as? Int) ?? Int(item["open_items"] as? String ?? "0") ?? 0,
                    blockerCount: (item["blocker_count"] as? Int) ?? Int(item["blocker_count"] as? String ?? "0") ?? 0,
                    lastActivity: (item["latest_memory"] as? String) ?? (item["last_activity"] as? String)
                ))
            }
        }

        var workItems: [WorkItem] = []
        if let items = json["work_items"] as? [[String: Any]] {
            for item in items {
                workItems.append(WorkItem(
                    memoryId: item["memory_id"] as? String ?? "",
                    memoryTitle: item["memory_title"] as? String,
                    projectName: item["project_name"] as? String,
                    text: item["item_text"] as? String ?? "",
                    type: item["item_type"] as? String ?? "task",
                    priority: item["item_priority"] as? String ?? "medium",
                    deadline: item["item_deadline"] as? String,
                    sourceIndex: (item["source_index"] as? Int) ?? (item["source_index"] as? String).flatMap { Int($0) }
                ))
            }
        }

        var completions: [CompletionItem] = []
        if let items = json["completions"] as? [[String: Any]] {
            for item in items {
                completions.append(CompletionItem(
                    memoryId: item["memory_id"] as? String ?? "",
                    memoryTitle: item["memory_title"] as? String,
                    projectName: item["project_name"] as? String,
                    text: item["completion_text"] as? String ?? item["completed_item"] as? String ?? "",
                    createdAt: item["created_at"] as? String
                ))
            }
        }

        var blockers: [BlockerItem] = []
        if let items = json["blockers"] as? [[String: Any]] {
            for item in items {
                blockers.append(BlockerItem(
                    memoryId: item["memory_id"] as? String ?? "",
                    memoryTitle: item["memory_title"] as? String,
                    projectName: item["project_name"] as? String,
                    text: item["blocker_text"] as? String ?? "",
                    severity: item["severity"] as? String ?? "minor",
                    blockingCause: item["blocking_cause"] as? String,
                    sourceIndex: (item["source_index"] as? Int) ?? (item["source_index"] as? String).flatMap { Int($0) }
                ))
            }
        }

        return ProjectsSummary(projects: projects, workItems: workItems, completions: completions, blockers: blockers)
    }

    // MARK: - Get Full Memory

    func getMemory(id: String) async throws -> FullMemory {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/memories/\(id)")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await perform(request)
        let httpStatus = (response as? HTTPURLResponse)?.statusCode ?? 0

        if httpStatus == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, _) = try await perform(request)
            return try Self.parseFullMemory(retryData)
        }

        return try Self.parseFullMemory(data)
    }

    private static func parseFullMemory(_ data: Data) throws -> FullMemory {
        guard let m = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw APIError.decodingError
        }

        let observations: [MemoryObservation] = (m["observations"] as? [[String: Any]] ?? []).compactMap { o in
            guard let text = o["text"] as? String, !text.isEmpty else { return nil }
            return MemoryObservation(text: text, confidence: o["confidence"] as? Double, type: o["type"] as? String)
        }

        let entities: [Entity] = (m["entities"] as? [[String: Any]] ?? []).compactMap { e in
            guard let name = e["name"] as? String, !name.isEmpty else { return nil }
            return Entity(name: name, type: e["type"] as? String)
        }

        let workItems: [MemoryWorkItem] = (m["work_items"] as? [[String: Any]] ?? []).compactMap { w in
            guard let text = w["text"] as? String, !text.isEmpty else { return nil }
            return MemoryWorkItem(text: text, type: w["type"] as? String, priority: w["priority"] as? String, status: w["status"] as? String)
        }

        let blockers: [MemoryBlocker] = (m["blockers"] as? [[String: Any]] ?? []).compactMap { b in
            guard let text = b["text"] as? String, !text.isEmpty else { return nil }
            return MemoryBlocker(text: text, severity: b["severity"] as? String)
        }

        let completions: [MemoryCompletion] = (m["completions"] as? [[String: Any]] ?? []).compactMap { c in
            guard let text = c["text"] as? String, !text.isEmpty else { return nil }
            return MemoryCompletion(text: text)
        }

        // Voice-note state pulled from the memory's metadata jsonb.
        let metadata = m["metadata"] as? [String: Any] ?? [:]
        let audioPending = metadata["audio_pending"] as? Bool ?? false
        let audioHasTranscript = metadata["audio_has_transcript"] as? Bool ?? false
        let audioTranscriptError = metadata["audio_transcript_error"] as? String

        return FullMemory(
            id: m["id"] as? String ?? "",
            title: m["title"] as? String,
            content: m["content"] as? String,
            created_at: m["created_at"] as? String,
            updated_at: m["updated_at"] as? String,
            source_type: m["source_type"] as? String,
            platform: m["platform"] as? String,
            tags: m["tags"] as? [String],
            summary: m["summary"] as? String,
            category: m["category"] as? String,
            intent: m["intent"] as? String,
            status: m["status"] as? String,
            project_name: m["project_name"] as? String,
            technologies: m["technologies"] as? [String] ?? [],
            observations: observations,
            entities: entities,
            workItems: workItems,
            blockers: blockers,
            completions: completions,
            image_count: m["image_count"] as? Int ?? 0,
            has_images: m["has_images"] as? Bool ?? false,
            word_count: m["word_count"] as? Int,
            read_time_minutes: m["read_time_minutes"] as? Int,
            audioPending: audioPending,
            audioHasTranscript: audioHasTranscript,
            audioTranscriptError: audioTranscriptError
        )
    }

    // MARK: - Todos

    func getTodos() async throws -> [TodoItem] {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/todos")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, _) = try await perform(request)
            return Self.parseTodos(retryData)
        }
        return Self.parseTodos(data)
    }

    func getAllTodos(limit: Int = 50) async throws -> [TodoItem] {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/todos/all?limit=\(limit)")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, _) = try await perform(request)
            return Self.parseTodos(retryData)
        }
        return Self.parseTodos(data)
    }

    func createTodo(text: String, priority: String = "medium", sourceType: String = "manual", sourceMemoryId: String? = nil, sourceField: String? = nil, sourceIndex: Int? = nil, projectName: String? = nil) async throws -> TodoItem {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/todos")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        var body: [String: Any] = [
            "text": text,
            "priority": priority,
            "source_type": sourceType
        ]
        if let id = sourceMemoryId { body["source_memory_id"] = id }
        if let field = sourceField { body["source_field"] = field }
        if let idx = sourceIndex { body["source_index"] = idx }
        if let proj = projectName { body["project_name"] = proj }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, _) = try await perform(request)
            return try Self.parseSingleTodo(retryData)
        }
        return try Self.parseSingleTodo(data)
    }

    func updateTodo(id: String, status: String? = nil, priority: String? = nil, snoozedUntil: String? = nil) async throws {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/todos/\(id)")!
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        var body: [String: Any] = [:]
        if let s = status { body["status"] = s }
        if let p = priority { body["priority"] = p }
        if let snz = snoozedUntil { body["snoozed_until"] = snz }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            _ = try await perform(request)
        }
    }

    func deleteTodo(id: String) async throws {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/todos/\(id)")!
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (_, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            _ = try await perform(request)
        }
    }

    private static func parseTodos(_ data: Data) -> [TodoItem] {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["todos"] as? [[String: Any]] else { return [] }
        return items.compactMap { parseTodoDict($0) }
    }

    private static func parseSingleTodo(_ data: Data) throws -> TodoItem {
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let todo = parseTodoDict(dict) else { throw APIError.decodingError }
        return todo
    }

    private static func parseTodoDict(_ t: [String: Any]) -> TodoItem? {
        guard let id = t["id"] as? String, let text = t["text"] as? String else { return nil }
        return TodoItem(
            id: id,
            text: text,
            status: t["status"] as? String ?? "pending",
            priority: t["priority"] as? String ?? "medium",
            sourceType: t["source_type"] as? String ?? t["sourceType"] as? String ?? "manual",
            sourceMemoryId: t["source_memory_id"] as? String ?? t["sourceMemoryId"] as? String,
            projectName: t["project_name"] as? String ?? t["projectName"] as? String,
            notes: t["notes"] as? String,
            deadline: t["deadline"] as? String,
            snoozedUntil: t["snoozed_until"] as? String ?? t["snoozedUntil"] as? String,
            completedAt: t["completed_at"] as? String ?? t["completedAt"] as? String,
            createdAt: t["created_at"] as? String ?? t["createdAt"] as? String,
            updatedAt: t["updated_at"] as? String ?? t["updatedAt"] as? String
        )
    }

    // MARK: - Claude Channel (v2/v3)

    func getClaudeChannelMessages(limit: Int = 50) async throws -> [ClaudeChannelMessage] {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/claude-channel/messages?limit=\(limit)")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, _) = try await perform(request)
            return Self.parseCCMessages(retryData)
        }
        return Self.parseCCMessages(data)
    }

    func sendClaudeChannelMessage(content: String, projectName: String? = nil, targetSessionId: String? = nil) async throws -> ClaudeChannelMessage {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/claude-channel/messages")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        var body: [String: Any] = ["content": content]
        if let proj = projectName { body["project_name"] = proj }
        if let target = targetSessionId { body["target_session_id"] = target }
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, _) = try await perform(request)
            return try Self.parseSingleCCMessage(retryData)
        }
        return try Self.parseSingleCCMessage(data)
    }

    func deleteClaudeChannelMessage(id: String) async throws {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/claude-channel/messages/\(id)")!
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (_, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            _ = try await perform(request)
        }
    }

    // MARK: - Claude Channel Sessions (v3)

    func getClaudeProjects() async throws -> [ClaudeProject] {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/claude-channel/projects")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, _) = try await perform(request)
            return Self.parseProjects(retryData)
        }
        return Self.parseProjects(data)
    }

    func getSessionMessages(sessionId: String, limit: Int = 50, offset: Int = 0) async throws -> [ClaudeChannelMessage] {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/claude-channel/sessions/\(sessionId)/messages?limit=\(limit)&offset=\(offset)")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, _) = try await perform(request)
            return Self.parseCCMessages(retryData)
        }
        return Self.parseCCMessages(data)
    }

    // MARK: - Claude Channel Parsers

    private static func parseCCMessages(_ data: Data) -> [ClaudeChannelMessage] {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["messages"] as? [[String: Any]] else { return [] }
        return items.compactMap { parseCCMessageDict($0) }
    }

    private static func parseSingleCCMessage(_ data: Data) throws -> ClaudeChannelMessage {
        guard let dict = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let msg = parseCCMessageDict(dict) else { throw APIError.decodingError }
        return msg
    }

    static func parseCCMessageDict(_ m: [String: Any]) -> ClaudeChannelMessage? {
        guard let id = m["id"] as? String,
              let content = m["content"] as? String else { return nil }
        return ClaudeChannelMessage(
            id: id,
            content: content,
            contentPreview: m["contentPreview"] as? String ?? m["content_preview"] as? String,
            direction: m["direction"] as? String ?? "inbound",
            parentMessageId: m["parentMessageId"] as? String ?? m["parent_message_id"] as? String,
            projectName: m["projectName"] as? String ?? m["project_name"] as? String,
            sessionId: m["sessionId"] as? String ?? m["session_id"] as? String,
            targetSessionId: m["targetSessionId"] as? String ?? m["target_session_id"] as? String,
            createdAt: m["createdAt"] as? String ?? m["created_at"] as? String,
            updatedAt: m["updatedAt"] as? String ?? m["updated_at"] as? String
        )
    }

    private static func parseProjects(_ data: Data) -> [ClaudeProject] {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["projects"] as? [[String: Any]] else { return [] }
        return items.compactMap { parseProjectDict($0) }
    }

    private static func parseProjectDict(_ p: [String: Any]) -> ClaudeProject? {
        guard let projectName = p["projectName"] as? String ?? p["project_name"] as? String,
              let sessionId = p["sessionId"] as? String ?? p["session_id"] as? String else { return nil }

        var lastMessage: ClaudeChannelMessage? = nil
        if let lm = p["lastMessage"] as? [String: Any], let _ = lm["contentPreview"] as? String ?? lm["content_preview"] as? String {
            lastMessage = ClaudeChannelMessage(
                id: "",
                content: lm["contentPreview"] as? String ?? lm["content_preview"] as? String ?? "",
                contentPreview: lm["contentPreview"] as? String ?? lm["content_preview"] as? String,
                direction: lm["direction"] as? String ?? "outbound",
                parentMessageId: nil,
                projectName: nil,
                sessionId: nil,
                targetSessionId: nil,
                createdAt: lm["createdAt"] as? String ?? lm["created_at"] as? String,
                updatedAt: nil
            )
        }

        return ClaudeProject(
            projectName: projectName,
            sessionId: sessionId,
            model: p["model"] as? String,
            cwd: p["cwd"] as? String,
            status: p["status"] as? String ?? "active",
            lastHeartbeatAt: p["lastHeartbeatAt"] as? String ?? p["last_heartbeat_at"] as? String,
            activeSessionCount: p["activeSessionCount"] as? Int ?? p["active_session_count"] as? Int ?? 0,
            totalSessionCount: p["totalSessionCount"] as? Int ?? p["total_session_count"] as? Int ?? 0,
            lastMessage: lastMessage,
            unreadCount: p["unreadCount"] as? Int ?? p["unread_count"] as? Int ?? 0
        )
    }

    // MARK: - Todo Suggestions

    func getTodoSuggestions() async throws -> [TodoSuggestion] {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/todos/suggestions")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, _) = try await perform(request)
            return Self.parseSuggestions(retryData)
        }
        return Self.parseSuggestions(data)
    }

    func resolveSuggestion(id: String, accept: Bool) async throws {
        let token = try await authService.validToken()
        let url = URL(string: "\(baseURL)/api/v1/todos/suggestions/\(id)")!
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["status": accept ? "accepted" : "dismissed"])

        let (_, response) = try await perform(request)
        if let http = response as? HTTPURLResponse, http.statusCode == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            _ = try await perform(request)
        }
    }

    private static func parseSuggestions(_ data: Data) -> [TodoSuggestion] {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["suggestions"] as? [[String: Any]] else { return [] }
        return items.compactMap { s in
            guard let id = s["id"] as? String,
                  let todoId = s["todoId"] as? String ?? s["todo_id"] as? String,
                  let memoryId = s["memoryId"] as? String ?? s["memory_id"] as? String,
                  let text = s["completionText"] as? String ?? s["completion_text"] as? String
            else { return nil }
            return TodoSuggestion(
                id: id,
                todoId: todoId,
                memoryId: memoryId,
                completionText: text,
                matchReason: s["matchReason"] as? String ?? s["match_reason"] as? String ?? "",
                confidence: s["confidence"] as? Double ?? 0,
                todoText: s["todoText"] as? String ?? s["todo_text"] as? String,
                memoryTitle: s["memoryTitle"] as? String ?? s["memory_title"] as? String
            )
        }
    }

    // MARK: - Recall Memories

    func recall(query: String) async throws -> RecallResponse {
        let token = try await authService.validToken()
        let encoded = query.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? query
        let url = URL(string: "\(baseURL)/api/v9/recall-memories?query=\(encoded)")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await perform(request)
        let httpStatus = (response as? HTTPURLResponse)?.statusCode ?? 0

        if httpStatus == 401 {
            let newToken = try await authService.refreshToken()
            request.setValue("Bearer \(newToken)", forHTTPHeaderField: "Authorization")
            let (retryData, _) = try await perform(request)
            return try Self.parseRecallResponse(retryData)
        }

        return try Self.parseRecallResponse(data)
    }

    /// Parse the recall response — handles both v9 flat results and tiered formats
    private static func parseRecallResponse(_ data: Data) throws -> RecallResponse {
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw APIError.decodingError
        }

        if json["detail"] is String {
            throw APIError.serverError(0)
        }

        let query = json["query"] as? String ?? ""
        var memories: [RecallMemory] = []

        // v9 endpoint returns { results: [...] }
        if let results = json["results"] as? [[String: Any]] {
            for item in results {
                let memory = parseMemoryItem(item)
                if memory != nil { memories.append(memory!) }
            }
        }
        // Tiered format returns { tiers: { summary: [...], full: [...] } }
        else if let tiers = json["tiers"] as? [String: Any] {
            let preferredTier = (tiers["summary"] as? [[String: Any]])?.isEmpty == false ? "summary" : "full"
            if let items = tiers[preferredTier] as? [[String: Any]] {
                for item in items {
                    let memory = parseMemoryItem(item)
                    if memory != nil { memories.append(memory!) }
                }
            }
        }

        return RecallResponse(memories: memories, query: query)
    }

    private static func parseMemoryItem(_ item: [String: Any]) -> RecallMemory? {
        let id = (item["id"] as? String) ?? UUID().uuidString
        let title = item["title"] as? String
        let content = (item["summary"] as? String)
            ?? (item["content"] as? String)
            ?? (item["title"] as? String)
            ?? ""
        let score = item["relevance_score"] as? Double
        let createdAt = item["created_at"] as? String
        guard !content.isEmpty else { return nil }
        return RecallMemory(id: id, title: title, content: content, score: score, created_at: createdAt)
    }

    // MARK: - Private

    private func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await URLSession.shared.data(for: request)
        } catch {
            throw APIError.networkError(error.localizedDescription)
        }
    }
}

enum APIError: LocalizedError {
    case networkError(String)
    case decodingError
    case serverError(Int)
    case clientAborted

    var errorDescription: String? {
        switch self {
        case .networkError(let msg): return "Network error: \(msg)"
        case .decodingError:         return "Failed to parse response"
        case .serverError(let code): return "Server error (\(code))"
        case .clientAborted:         return "Upload interrupted — will retry"
        }
    }
}
