import AppKit
import Darwin
import Foundation

/// Manages the lifecycle of the TS sidecar process (relayscribe-sidecar).
/// Mirrors the LocalServerManager pattern from MSDReview.
@Observable
@MainActor
final class SidecarManager {

    enum State: Equatable {
        case idle
        case starting
        case running(pid: Int32)
        case failed(String)
        case stopped
    }

    var state: State = .idle

    private var process: Process?
    private var monitorTask: Task<Void, Never>?
    private var workspaceCredential: WorkspaceCredential?

    // MARK: - Public

    func ensureRunning() async {
        guard case .idle = state else { return }
        await start()
    }

    func setWorkspaceCredential(_ credential: WorkspaceCredential?) {
        workspaceCredential = credential
        if case .running = state {
            Task { await syncRelayAuthToken() }
        }
    }

    func stop() {
        monitorTask?.cancel()
        monitorTask = nil
        process?.terminate()
        process = nil
        state = .stopped
    }

    func setRelayWorkspaceId(_ workspaceId: String?) {
        relayWorkspaceId = normalizedNonEmpty(workspaceId)
        if case .running = state {
            Task { await syncRelayWorkspaceContext() }
        }
    }

    // MARK: - Private

    private func start() async {
        state = .starting
        sidecarInstanceId = UUID().uuidString
        AppConfiguration.useSidecarPort(resolveSidecarPort(preferred: AppConfiguration.sidecarPort))

        guard let sidecarRoot = sidecarRoot() else {
            state = .failed("sidecar/dist/server.js not found — run 'npm run build' in sidecar/")
            return
        }
        guard let node = resolveNode(in: sidecarRoot) else {
            state = .failed("Node.js not found — install via https://nodejs.org")
            return
        }
        guard let script = resolveSidecarScript(in: sidecarRoot) else {
            state = .failed("sidecar/dist/server.js not found in \(sidecarRoot.path)")
            return
        }

        let proc = Process()
        proc.executableURL = node
        proc.arguments = [script.path]
        proc.currentDirectoryURL = sidecarRoot
        proc.environment = buildEnvironment(sidecarRoot: sidecarRoot)

        // Pipe stdout/stderr to our own output for debugging
        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe
        logPipe(outPipe, prefix: "[sidecar]")
        logPipe(errPipe, prefix: "[sidecar:err]")

        do {
            try proc.run()
        } catch {
            state = .failed("Failed to launch sidecar: \(error.localizedDescription)")
            return
        }

        process = proc

        let healthy = await waitForHealth(timeout: AppConfiguration.sidecarStartupTimeout)
        if healthy {
            state = .running(pid: proc.processIdentifier)
            startMonitor()
        } else {
            proc.terminate()
            process = nil
            state = .failed("Sidecar did not respond on port \(AppConfiguration.sidecarPort) within \(Int(AppConfiguration.sidecarStartupTimeout))s")
        }
    }

    private func waitForHealth(timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await isHealthy() { return true }
            try? await Task.sleep(for: .milliseconds(500))
        }
        return false
    }

    private func isHealthy() async -> Bool {
        let url = AppConfiguration.sidecarBaseURL.appendingPathComponent("health")
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        do {
            let (data, res) = try await URLSession.shared.data(for: req)
            guard (res as? HTTPURLResponse)?.statusCode == 200 else { return false }
            let health = try? JSONDecoder().decode(SidecarHealthResponse.self, from: data)
            return health?.app == "relayscribe-sidecar"
                && (health?.sidecarApiVersion ?? 0) >= 2
                && health?.instanceId == sidecarInstanceId
        } catch {
            return false
        }
    }

    private func startMonitor() {
        monitorTask?.cancel()
        monitorTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled else { break }
                guard let self else { break }
                if let proc = self.process, proc.isRunning { continue }
                // Process died — restart
                await MainActor.run { self.state = .starting }
                await self.start()
            }
        }
    }

    // MARK: - Path resolution

    private func resolveNode(in sidecarRoot: URL) -> URL? {
        let packagedExecutableDirectory = Bundle.main.executableURL?.deletingLastPathComponent()
        let candidates = [
            // packaged app bundle: keep executable code under Contents/MacOS so
            // Gatekeeper treats it as nested code, not a quarantined resource.
            packagedExecutableDirectory?.appendingPathComponent("sidecar-node"),
            // legacy packaged app bundle fallback
            sidecarRoot.appendingPathComponent("node"),
            // project-local (preferred)
            sidecarRoot.appendingPathComponent("node_modules/.bin/node"),
            // homebrew Apple Silicon
            URL(fileURLWithPath: "/opt/homebrew/bin/node"),
            // homebrew Intel
            URL(fileURLWithPath: "/usr/local/bin/node"),
            // system
            URL(fileURLWithPath: "/usr/bin/node"),
        ]
        return candidates.compactMap { $0 }.first { fm.fileExists(atPath: $0.path) }
    }

    private func resolveSidecarScript(in sidecarRoot: URL) -> URL? {
        let script = sidecarRoot.appendingPathComponent("dist/server.js")
        return fm.fileExists(atPath: script.path) ? script : nil
    }

    /// Finds the embedded sidecar in a packaged app or the repo sidecar in development.
    private func sidecarRoot() -> URL? {
        var candidates: [URL] = []

        if let resourceURL = Bundle.main.resourceURL {
            candidates.append(resourceURL.appendingPathComponent("sidecar"))
        }
        candidates.append(Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/sidecar"))

        let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
        candidates.append(contentsOf: sidecarCandidates(startingAt: executable.deletingLastPathComponent()))
        candidates.append(contentsOf: sidecarCandidates(startingAt: Bundle.main.bundleURL))
        candidates.append(contentsOf: sidecarCandidates(startingAt: URL(fileURLWithPath: fm.currentDirectoryPath)))

        var seen = Set<String>()
        return candidates
            .map { $0.standardizedFileURL }
            .first { candidate in
                guard seen.insert(candidate.path).inserted else { return false }
                return isValidSidecarRoot(candidate)
            }
    }

    private func sidecarCandidates(startingAt start: URL) -> [URL] {
        var candidates: [URL] = []
        var dir = start
        for _ in 0..<10 {
            if dir.lastPathComponent == "sidecar" {
                candidates.append(dir)
            } else {
                candidates.append(dir.appendingPathComponent("sidecar"))
            }
            dir = dir.deletingLastPathComponent()
        }
        return candidates
    }

    private func isValidSidecarRoot(_ url: URL) -> Bool {
        let packageJson = url.appendingPathComponent("package.json")
        let serverScript = url.appendingPathComponent("dist/server.js")
        return fm.fileExists(atPath: packageJson.path) && fm.fileExists(atPath: serverScript.path)
    }

    private func buildEnvironment(sidecarRoot: URL) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["SIDECAR_PORT"] = String(AppConfiguration.sidecarPort)
        env["RELAYSCRIBE_SIDECAR_INSTANCE_ID"] = UUID().uuidString
        let binPath = sidecarRoot.appendingPathComponent("node_modules/.bin").path
        let current = env["PATH"] ?? "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
        env["PATH"] = "\(binPath):\(current)"
        if let cred = workspaceCredential {
            env["RELAY_ACCESS_TOKEN"] = cred.accessToken
            env["RELAY_WORKSPACE_ID"] = cred.workspaceId
            if let apiURL = cred.apiURL { env["RELAY_API_URL"] = apiURL }
        }
        // The sidecar is launched with currentDirectoryURL=sidecarRoot so dotenv can
        // read a sidecar-local .env during stage/demo runs without bundling secrets.
        return env
    }

    private func syncRelayAuthToken() async {
        guard let cred = workspaceCredential else { return }
        let url = AppConfiguration.sidecarBaseURL.appendingPathComponent("relay/auth-token")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 5
        var body: [String: String] = ["access_token": cred.accessToken, "workspace_id": cred.workspaceId]
        if let apiURL = cred.apiURL { body["api_url"] = apiURL }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        _ = try? await URLSession.shared.data(for: req)
    }

    private func normalizedNonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private func syncRelayWorkspaceContext() async {
        let url = AppConfiguration.sidecarBaseURL.appendingPathComponent("relay/workspace")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let payload: [String: String] = relayWorkspaceId.map { ["relay_workspace_id": $0] } ?? [:]
        req.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        req.timeoutInterval = 5

        do {
            let (_, res) = try await URLSession.shared.data(for: req)
            if (res as? HTTPURLResponse)?.statusCode != 200 {
                print("[sidecar] relay workspace sync failed")
            }
        } catch {
            print("[sidecar] relay workspace sync failed: \(error.localizedDescription)")
        }
    }

    private func logPipe(_ pipe: Pipe, prefix: String) {
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let line = String(data: data, encoding: .utf8) else { return }
            for l in line.components(separatedBy: "\n") where !l.isEmpty {
                print("\(prefix) \(l)")
            }
        }
    }

    private let fm = FileManager.default
}

private struct SidecarHealthResponse: Decodable {
    var app: String?
    var sidecarApiVersion: Int?
    var instanceId: String?
}
