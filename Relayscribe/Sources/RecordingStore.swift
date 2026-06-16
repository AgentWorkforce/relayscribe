import Foundation
import Observation

// ── Domain types ──────────────────────────────────────────────────────────────

enum RecordingStatus: String, Codable, Equatable {
    case idle              = "idle"
    case meetingDetected   = "meeting-detected"
    case recording         = "recording"
    case uploading         = "uploading"
    case error             = "error"
}

enum BrainstormRecordingStatus: Equatable {
    case idle
    case starting
    case recording
    case uploading
    case completed
    case error(String)
}

struct SidecarState: Decodable, Equatable {
    var status: RecordingStatus
    var windowId: String?
    var meetingTitle: String?
    var uploadId: String?
    var startedAt: Double?          // ms since epoch
    var errorMessage: String?

    enum CodingKeys: String, CodingKey {
        case status, windowId, meetingTitle, uploadId, startedAt, errorMessage
    }
}

// ── Store ─────────────────────────────────────────────────────────────────────

@Observable
@MainActor
final class RecordingStore {

    var sidecarState: SidecarState = SidecarState(status: .idle)
    var sidecarAvailable: Bool = false
    var configWarning: String? = nil
    var brainstormStatus: BrainstormRecordingStatus = .idle
    var brainstormStartedAt: Date?
    var brainstormTranscript: String?

    private var pollTask: Task<Void, Never>?
    private let brainstormRecorder = BrainstormAudioRecorder()

    func effectiveMenuStatus(mode: RecorderMode) -> RecordingStatus {
        guard mode == .brainstorm else { return sidecarState.status }
        switch brainstormStatus {
        case .recording:
            return .recording
        case .starting:
            return .recording
        case .uploading:
            return .uploading
        case .error:
            return .error
        case .idle, .completed:
            return sidecarState.status
        }
    }

    // MARK: - Public

    func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.fetchState()
                try? await Task.sleep(for: .seconds(AppConfiguration.statePollInterval))
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    func stopRecording() {
        Task { await postCommand("/recording/stop") }
    }

    func startBrainstormRecording(isSignedIn: Bool) {
        guard brainstormStatus != .starting && brainstormStatus != .recording && brainstormStatus != .uploading else {
            return
        }
        guard isSignedIn else {
            brainstormStatus = .error("Sign in to Relay before recording a brainstorm.")
            return
        }
        guard sidecarAvailable else {
            brainstormStatus = .error("Sidecar is not ready yet.")
            return
        }
        brainstormTranscript = nil
        brainstormStartedAt = nil
        brainstormStatus = .starting
        Task {
            do {
                _ = try await brainstormRecorder.start()
                brainstormStartedAt = Date()
                brainstormStatus = .recording
            } catch {
                brainstormStartedAt = nil
                brainstormStatus = .error(error.localizedDescription)
            }
        }
    }

    func stopBrainstormRecording() {
        guard brainstormStatus == .recording else { return }
        let fileURL: URL
        do {
            fileURL = try brainstormRecorder.stop()
            brainstormStatus = .uploading
        } catch {
            brainstormStartedAt = nil
            brainstormStatus = .error(error.localizedDescription)
            return
        }
        Task {
            do {
                defer { try? FileManager.default.removeItem(at: fileURL) }
                let response = try await uploadBrainstormAudio(fileURL: fileURL)
                brainstormTranscript = response.transcript
                brainstormStartedAt = nil
                brainstormStatus = .completed
            } catch {
                brainstormStartedAt = nil
                brainstormStatus = .error(error.localizedDescription)
            }
        }
    }

    func resetBrainstormStatus() {
        if case .starting = brainstormStatus {
            brainstormRecorder.cancel()
        }
        if case .recording = brainstormStatus {
            brainstormRecorder.cancel()
        }
        brainstormStartedAt = nil
        brainstormTranscript = nil
        brainstormStatus = .idle
    }

    // MARK: - Private

    private func fetchState() async {
        let url = AppConfiguration.sidecarBaseURL.appendingPathComponent("state")
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        do {
            let (data, response) = try await URLSession.shared.data(for: req)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            let decoded = try JSONDecoder().decode(SidecarState.self, from: data)
            self.sidecarState = decoded
            self.sidecarAvailable = true
        } catch {
            self.sidecarAvailable = false
        }
    }

    private func fetchConfig() async {
        struct ConfigResponse: Decodable {
            var hasWorkerUrl: Bool
            var hasRelayToken: Bool?
            var hasDeprecatedSharedToken: Bool?
            var hasSharedToken: Bool?  // legacy fallback
        }
        let url = AppConfiguration.sidecarBaseURL.appendingPathComponent("config")
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let cfg = try? JSONDecoder().decode(ConfigResponse.self, from: data) else { return }
        let hasAuth = (cfg.hasRelayToken ?? false) || (cfg.hasDeprecatedSharedToken ?? false) || (cfg.hasSharedToken ?? false)
        if !cfg.hasWorkerUrl {
            configWarning = "WORKER_URL not configured — set in .env and restart"
        } else if !hasAuth {
            configWarning = "Sign in to Relay in Settings to authenticate this recorder"
        } else {
            configWarning = nil
        }
    }

    func onSidecarReady(settings: RecorderSettings) {
        Task { await fetchConfig() }
        syncSettings(settings.snapshot)
        syncGenerativeUI(settings.generativeUIEnabled)
        startPolling()
    }

    func syncSettings(_ settings: RecorderSettingsSnapshot) {
        Task { await postJSON("/settings", body: settings) }
    }

    /// Push the Generative UI (Beta) opt-in state so the sidecar only exposes the
    /// /ui* surface when the user enabled it. Kept separate from recorder
    /// settings — it's a local UI-mode flag, not meeting-pipeline config.
    func syncGenerativeUI(_ enabled: Bool) {
        Task { await postJSON("/generative-ui", body: ["enabled": enabled]) }
    }

    @discardableResult
    private func postCommand(_ path: String) async -> Bool {
        let url = AppConfiguration.sidecarBaseURL.appendingPathComponent(path)
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 5
        do {
            let (_, res) = try await URLSession.shared.data(for: req)
            return (res as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    @discardableResult
    private func postJSON<T: Encodable>(_ path: String, body: T) async -> Bool {
        let url = AppConfiguration.sidecarBaseURL.appendingPathComponent(path)
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "content-type")
        req.timeoutInterval = 5
        do {
            req.httpBody = try JSONEncoder().encode(body)
            let (_, res) = try await URLSession.shared.data(for: req)
            return (res as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    private func uploadBrainstormAudio(fileURL: URL) async throws -> BrainstormUploadResponse {
        let boundary = "Boundary-\(UUID().uuidString)"
        let audio = try Data(contentsOf: fileURL)
        var body = Data()
        appendMultipartFile(
            to: &body,
            boundary: boundary,
            fieldName: "file",
            filename: fileURL.lastPathComponent,
            contentType: "audio/mp4",
            data: audio
        )
        appendMultipartField(to: &body, boundary: boundary, name: "source", value: "native-brainstorm")
        body.appendString("--\(boundary)--\r\n")

        let url = AppConfiguration.sidecarBaseURL.appendingPathComponent("brainstorm/upload")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        req.timeoutInterval = 120

        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let decoded = try? JSONDecoder().decode(BrainstormUploadResponse.self, from: data)
        guard (200..<300).contains(status), let decoded else {
            let message = decoded?.error ?? String(data: data, encoding: .utf8) ?? "Brainstorm upload failed."
            throw BrainstormUploadError.message(message)
        }
        return decoded
    }

    private func appendMultipartField(to body: inout Data, boundary: String, name: String, value: String) {
        body.appendString("--\(boundary)\r\n")
        body.appendString("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
        body.appendString("\(value)\r\n")
    }

    private func appendMultipartFile(
        to body: inout Data,
        boundary: String,
        fieldName: String,
        filename: String,
        contentType: String,
        data: Data
    ) {
        body.appendString("--\(boundary)\r\n")
        body.appendString("Content-Disposition: form-data; name=\"\(fieldName)\"; filename=\"\(filename)\"\r\n")
        body.appendString("Content-Type: \(contentType)\r\n\r\n")
        body.append(data)
        body.appendString("\r\n")
    }
}

private struct BrainstormUploadResponse: Decodable {
    var ok: Bool?
    var id: String?
    var transcript: String?
    var error: String?
}

private enum BrainstormUploadError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let message): return message
        }
    }
}

private extension Data {
    mutating func appendString(_ string: String) {
        append(Data(string.utf8))
    }
}
