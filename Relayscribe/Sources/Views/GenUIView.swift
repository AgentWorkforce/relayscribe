import SwiftUI
import WebKit

/// The malleable (Generative UI Beta) surface. The user describes the entire
/// interface in plain English; the sidecar generates a full HTML document that
/// renders here in a WebView. The bridge (window.relayscribe.*) is injected by the
/// sidecar, so the generated UI can drive real app functions. This native
/// toolbar provides a reliable, always-present way to author / iterate / reset.
@MainActor
struct GenUIView: View {
    @Environment(SidecarManager.self) var sidecar
    @Environment(RecorderSettings.self) var settings
    @State private var prompt: String = ""
    @State private var isGenerating: Bool = false
    @State private var errorMessage: String?
    @State private var reloadID = UUID()
    @State private var elapsedSeconds: Int = 0
    @State private var pollTask: Task<Void, Never>?

    private var uiURL: URL {
        AppConfiguration.sidecarBaseURL.appendingPathComponent("ui")
    }
    private var statusURL: URL {
        AppConfiguration.sidecarBaseURL.appendingPathComponent("ui/status")
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            if let errorMessage {
                errorBanner(errorMessage)
            }
            Divider()
            if !settings.generativeUIEnabled {
                disabledView
            } else if sidecarIsRunning {
                GenUIWebView(
                    url: uiURL,
                    reloadToken: reloadID,
                    onCompose: { text in
                        prompt = text
                        errorMessage = nil
                    },
                    onError: { message in
                        errorMessage = message.isEmpty ? nil : "Couldn't load the UI: \(message)"
                    }
                )
            } else {
                loadingView
            }
        }
        .frame(minWidth: 820, minHeight: 600)
        .task {
            guard settings.generativeUIEnabled else { return }
            await sidecar.ensureRunning()
            if sidecarIsRunning { reloadID = UUID() }
        }
        .onChange(of: sidecar.state) {
            if settings.generativeUIEnabled, sidecarIsRunning { reloadID = UUID() }
        }
        .onDisappear {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    private var disabledView: some View {
        VStack(spacing: 10) {
            Image(systemName: "sparkles.slash")
                .font(.system(size: 30))
                .foregroundStyle(.secondary)
            Text("Generative UI (Beta) is off")
                .font(.headline)
            Text("Enable it in Settings → Generative UI to author a custom interface.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(40)
        .background(Color(nsColor: .textBackgroundColor))
    }

    private var toolbar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .foregroundStyle(Color.accentColor)
                Text("Generative UI")
                    .font(.headline)
                Text("BETA")
                    .font(.caption2).fontWeight(.bold)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Color.accentColor.opacity(0.18))
                    .foregroundStyle(Color.accentColor)
                    .clipShape(Capsule())
                Spacer()
                Button {
                    reloadID = UUID()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .help("Reload generated UI")

                Button(role: .destructive) {
                    Task { await reset() }
                } label: {
                    Text("Reset")
                }
                .buttonStyle(.bordered)
                .disabled(isGenerating || !settings.generativeUIEnabled)
                .help("Discard the generated UI and return to the starter")
            }

            HStack(spacing: 8) {
                TextField("Describe the UI you want — or how to change it…", text: $prompt, axis: .vertical)
                    .lineLimit(1...3)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await generate() } }
                    .disabled(isGenerating || !settings.generativeUIEnabled)
                Button {
                    Task { await generate() }
                } label: {
                    if isGenerating {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text("\(elapsedSeconds)s").monospacedDigit().font(.caption)
                        }
                    } else {
                        Text("Generate")
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isGenerating || !settings.generativeUIEnabled || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(12)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
            Text(message).font(.caption).foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(Color.yellow.opacity(0.08))
    }

    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Starting sidecar…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .textBackgroundColor))
    }

    private var sidecarIsRunning: Bool {
        if case .running = sidecar.state { return true }
        return false
    }

    // MARK: - Actions

    private func generate() async {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isGenerating else { return }
        isGenerating = true
        elapsedSeconds = 0
        errorMessage = nil
        do {
            let jobId = try await postGenerateAsync(request: text)
            prompt = ""
            startPolling(jobId: jobId)
        } catch {
            isGenerating = false
            errorMessage = "Generation failed: \(error.localizedDescription)"
        }
    }

    private func reset() async {
        isGenerating = true
        errorMessage = nil
        defer { isGenerating = false }
        do {
            var req = URLRequest(url: AppConfiguration.sidecarBaseURL.appendingPathComponent("ui"))
            req.httpMethod = "DELETE"
            _ = try await URLSession.shared.data(for: req)
            reloadID = UUID()
        } catch {
            errorMessage = "Reset failed: \(error.localizedDescription)"
        }
    }

    // Posts with async:true — receives 202 + jobId; returns the jobId to poll.
    private func postGenerateAsync(request: String) async throws -> String {
        let url = AppConfiguration.sidecarBaseURL.appendingPathComponent("ui/generate")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["request": request, "async": true])
        req.timeoutInterval = 10
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let detail = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        guard status == 202, let jobId = detail?["jobId"] as? String else {
            if status == 503 {
                let reason = detail?["reason"] as? String ?? detail?["error"] as? String ?? "broker unavailable"
                throw NSError(domain: "GenUI", code: 503, userInfo: [NSLocalizedDescriptionKey: reason])
            }
            let reason = detail?["reason"] as? String ?? detail?["error"] as? String ?? "status \(status)"
            throw NSError(domain: "GenUI", code: status, userInfo: [NSLocalizedDescriptionKey: reason])
        }
        return jobId
    }

    // Polls GET /ui/status every 2.5s. Stops when state is idle or error.
    private func startPolling(jobId: String) {
        pollTask?.cancel()
        let startedAt = Date()
        // GenUIView is a struct; its @State is reference-backed, so capture by
        // value (no weak self — structs can't be weakly captured).
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(2500))
                guard !Task.isCancelled else { break }
                await checkStatus(jobId: jobId, startedAt: startedAt)
            }
        }
    }

    private func checkStatus(jobId: String, startedAt: Date) async {
        var req = URLRequest(url: statusURL)
        req.timeoutInterval = 5
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let state = json["state"] as? String else { return }

        elapsedSeconds = Int(Date().timeIntervalSince(startedAt))

        switch state {
        case "idle":
            pollTask?.cancel()
            pollTask = nil
            isGenerating = false
            reloadID = UUID()
        case "error":
            pollTask?.cancel()
            pollTask = nil
            isGenerating = false
            let reason = json["error"] as? String ?? "Generation failed"
            errorMessage = reason
        default:
            break
        }
    }
}

// MARK: - WebView

private struct GenUIWebView: NSViewRepresentable {
    let url: URL
    let reloadToken: UUID
    /// Called when the page routes an example/prompt into the single native
    /// toolbar via window.relayscribe.compose(text).
    var onCompose: (String) -> Void
    /// Called when navigation fails, so we can surface the real error instead of
    /// WebKit's generic "Load failed."
    var onError: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCompose: onCompose, onError: onError) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        // Native action channel for bridge calls that must reach the Swift shell
        // (openSettings, compose).
        configuration.userContentController.add(context.coordinator, name: "relayscribe")
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsMagnification = true
        webView.navigationDelegate = context.coordinator
        webView.setValue(false, forKey: "drawsBackground")
        context.coordinator.webView = webView
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.onCompose = onCompose
        context.coordinator.onError = onError
        if context.coordinator.lastReloadToken != reloadToken {
            context.coordinator.lastReloadToken = reloadToken
            webView.load(URLRequest(url: url))
        } else if webView.url != url {
            webView.load(URLRequest(url: url))
        }
    }

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        weak var webView: WKWebView?
        var lastReloadToken: UUID?
        var onCompose: (String) -> Void
        var onError: (String) -> Void

        init(onCompose: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
            self.onCompose = onCompose
            self.onError = onError
        }

        nonisolated func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "relayscribe" else { return }
            let body = message.body as? [String: Any]
            let action = body?["action"] as? String ?? (message.body as? String)
            let text = body?["text"] as? String
            Task { @MainActor in
                switch action {
                case "openSettings":
                    NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
                    NSApp.activate(ignoringOtherApps: true)
                case "compose":
                    self.onCompose(text ?? "")
                default:
                    break
                }
            }
        }

        nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            let message = error.localizedDescription
            Task { @MainActor in self.onError(message) }
        }

        nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            let message = error.localizedDescription
            Task { @MainActor in self.onError(message) }
        }

        nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            Task { @MainActor in self.onError("") }
        }
    }
}
