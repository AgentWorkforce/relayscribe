import SwiftUI

@MainActor
struct StatusView: View {
    @Environment(RecordingStore.self) var store
    @Environment(RecorderSettings.self) var settings
    @Environment(RelayAccount.self) var account
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        @Bindable var settings = settings

        VStack(alignment: .leading, spacing: 0) {
            headerRow
            Divider().padding(.vertical, 4)
            stateRow
            if shouldShowConsentNotice {
                consentNotice
            }
            if let warn = store.configWarning {
                configWarningRow(warn)
            }
            Divider().padding(.vertical, 4)
            RelayAccountView()
            Divider().padding(.vertical, 4)
            RelayAccountView()
            Divider().padding(.vertical, 4)
            connectControls
            Divider().padding(.vertical, 4)
            modeControls(settings: $settings)
            if self.settings.mode == .brainstorm {
                Divider().padding(.vertical, 4)
                brainstormControls
            }
            Divider().padding(.vertical, 4)
            automationControls(settings: $settings)
            Divider().padding(.vertical, 4)
            footerButtons
        }
        .padding(14)
        .frame(width: 360)
        .background(Color(nsColor: .windowBackgroundColor))
        .onChange(of: self.settings.snapshot) {
            store.syncSettings(self.settings.snapshot)
            if self.settings.mode == .meeting {
                store.resetBrainstormStatus()
            }
        }
        .task {
            await account.refreshIntegrationStatusesIfSignedIn()
        }
    }

    // MARK: - Sections

    private var headerRow: some View {
        HStack(spacing: 8) {
            recordingIcon
            VStack(alignment: .leading, spacing: 2) {
                Text(Brand.productName)
                    .font(.headline)
                Text("Bot-free local capture")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Circle()
                .fill(store.sidecarAvailable ? Color.green : Color.orange)
                .frame(width: 7, height: 7)
                .help(store.sidecarAvailable ? "Sidecar running" : "Sidecar connecting…")
        }
    }

    private var recordingIcon: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(iconBackground)
                .frame(width: 32, height: 32)
            Image(systemName: iconSystemName)
                .foregroundColor(.white)
                .font(.system(size: 14, weight: .semibold))
        }
    }

    private var stateRow: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(stateLabel)
                    .font(.subheadline)
                    .fontWeight(.medium)
                Text(stateDescription)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if self.settings.mode == .brainstorm, let startedAt = store.brainstormStartedAt {
                TimerLabel(startedAt: startedAt.timeIntervalSince1970)
            } else if store.sidecarState.status == .recording, let ts = store.sidecarState.startedAt {
                TimerLabel(startedAt: ts / 1000)
            }
        }
        .padding(.vertical, 6)
    }

    private func modeControls(settings: Bindable<RecorderSettings>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Mode")
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
            Picker("Mode", selection: settings.mode) {
                ForEach(RecorderMode.allCases) { mode in
                    Label(mode.title, systemImage: mode.symbolName).tag(mode)
                }
            }
            .pickerStyle(.segmented)
        }
        .padding(.vertical, 4)
    }

    private func automationControls(settings: Bindable<RecorderSettings>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Automation")
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
            Toggle("Auto-create Linear issues", isOn: settings.createLinearIssues)
            Toggle("Auto-create GitHub issues", isOn: settings.createGithubIssues)
            Toggle("Auto-dispatch PRs", isOn: settings.dispatchEnabled)
        }
        .toggleStyle(.checkbox)
        .padding(.vertical, 4)
    }

    private var brainstormControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Brainstorm")
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button(brainstormButtonTitle) {
                    if case .recording = store.brainstormStatus {
                        store.stopBrainstormRecording()
                    } else {
                        store.startBrainstormRecording(isSignedIn: account.credential != nil)
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(brainstormButtonTint)
                .disabled(isBrainstormButtonDisabled)

                if case .completed = store.brainstormStatus {
                    Button("Clear") { store.resetBrainstormStatus() }
                        .buttonStyle(.bordered)
                }
            }
            if let detail = brainstormDetailText {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(brainstormDetailIsError ? .red : .secondary)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 4)
    }

    private var connectControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Connect")
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
            ForEach(RelayIntegrationProvider.allCases) { provider in
                IntegrationConnectRow(provider: provider)
            }
        }
        .padding(.vertical, 4)
    }

    private var consentNotice: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(.yellow)
                .font(.caption)
                .padding(.top, 1)
            Text(consentNoticeText)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(8)
        .background(Color.yellow.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .padding(.vertical, 4)
    }

    private func configWarningRow(_ warning: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundColor(.red)
                .font(.caption)
                .padding(.top, 1)
            Text(warning)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(8)
        .background(Color.red.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .padding(.vertical, 4)
    }

    private var footerButtons: some View {
        HStack {
            if store.sidecarState.status == .recording && self.settings.mode == .meeting {
                Button("Stop Recording") {
                    Task { @MainActor in store.stopRecording() }
                }
                .buttonStyle(.bordered)
                .tint(.red)
            }
            HStack {
                // Opt-in only: the malleable WebView surface is reachable just
                // when Generative UI (Beta) is enabled. Otherwise this native
                // menu stays the whole UI.
                if settings.generativeUIEnabled {
                    Button("Generative UI (Beta)") {
                        openWindow(id: "generated-ui")
                    }
                    .buttonStyle(.bordered)
                }
                Spacer()
                Button("Settings...") {
                    openSettingsWindow()
                }
                .buttonStyle(.bordered)
                Spacer()
                Button("Settings...") {
                    NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
                }
                .buttonStyle(.bordered)
                Button("Quit") { NSApp.terminate(nil) }
                    .buttonStyle(.bordered)
            }
        }
    }

    /// Opens the SwiftUI Settings scene. Accessory (LSUIElement) apps are not
    /// active, so the window otherwise opens hidden/behind — activating the app
    /// first brings it frontmost. (The macOS 14 `openSettings`/`SettingsLink`
    /// APIs aren't available in the Command Line Tools SwiftUI module used to
    /// build the app, so we drive the documented settings action directly.)
    private func openSettingsWindow() {
        NSApp.activate(ignoringOtherApps: true)
        NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
    }

    // MARK: - Computed display values

    private var stateLabel: String {
        if self.settings.mode == .brainstorm {
            switch store.brainstormStatus {
            case .idle:      return "Brainstorm Ready"
            case .starting:  return "Starting Brainstorm…"
            case .recording: return "Brainstorm Recording"
            case .uploading: return "Uploading Brainstorm…"
            case .completed: return "Brainstorm Sent"
            case .error:     return "Brainstorm Error"
            }
        }
        switch store.sidecarState.status {
        case .idle:            return "Idle"
        case .meetingDetected: return "Meeting Detected"
        case .recording:       return "Recording"
        case .uploading:       return "Uploading…"
        case .error:           return "Error"
        }
    }

    private var stateDescription: String {
        if self.settings.mode == .brainstorm {
            switch store.brainstormStatus {
            case .idle:
                return account.credential == nil ? "Sign in to Relay to record a braindump" : "Record a solo braindump from your microphone"
            case .starting:
                return "Requesting microphone access…"
            case .recording:
                return "Talk through what you want built"
            case .uploading:
                return "Transcribing and routing through \(Brand.shortName)…"
            case .completed:
                return "Sent to \(Brand.shortName)"
            case .error(let message):
                return message
            }
        }
        switch store.sidecarState.status {
        case .idle:
            return "Listening for meetings"
        case .meetingDetected:
            return store.sidecarState.meetingTitle ?? "Starting local capture…"
        case .recording:
            return store.sidecarState.meetingTitle ?? "Local capture in progress"
        case .uploading:
            return "Sending to \(Brand.shortName)…"
        case .error:
            return store.sidecarState.errorMessage ?? "Unknown error"
        }
    }

    private var iconSystemName: String {
        switch store.effectiveMenuStatus(mode: self.settings.mode) {
        case .idle:            return "waveform.circle"
        case .meetingDetected: return "waveform.circle"
        case .recording:       return "record.circle"
        case .uploading:       return "arrow.up.circle"
        case .error:           return "exclamationmark.circle"
        }
    }

    private var iconBackground: Color {
        switch store.effectiveMenuStatus(mode: self.settings.mode) {
        case .idle:            return .accentColor
        case .meetingDetected: return .orange
        case .recording:       return .red
        case .uploading:       return .blue
        case .error:           return .red
        }
    }

    private var shouldShowConsentNotice: Bool {
        if case .recording = store.brainstormStatus, self.settings.mode == .brainstorm {
            return true
        }
        return store.sidecarState.status == .recording || store.sidecarState.status == .meetingDetected
    }

    private var consentNoticeText: String {
        if case .recording = store.brainstormStatus, self.settings.mode == .brainstorm {
            return "This brainstorm is being recorded from your microphone and sent to \(Brand.shortName) after you stop."
        }
        return "This meeting is being recorded by \(Brand.shortName). Audio is captured locally — **no bot joins your call**."
    }

    private var brainstormButtonTitle: String {
        switch store.brainstormStatus {
        case .starting: return "Starting…"
        case .recording: return "Stop Brainstorm Recording"
        case .uploading: return "Uploading…"
        default: return "Start Brainstorm Recording"
        }
    }

    private var brainstormButtonTint: Color {
        if case .recording = store.brainstormStatus {
            return .red
        }
        return .accentColor
    }

    private var isBrainstormButtonDisabled: Bool {
        if case .starting = store.brainstormStatus {
            return true
        }
        if case .uploading = store.brainstormStatus {
            return true
        }
        return false
    }

    private var brainstormDetailText: String? {
        switch store.brainstormStatus {
        case .idle:
            return account.credential == nil ? "Sign in first so routing has a Relay workspace." : nil
        case .starting:
            return "Waiting for microphone permission"
        case .recording:
            return "Recording from microphone"
        case .uploading:
            return "Sending audio for transcription"
        case .completed:
            return store.brainstormTranscript.map { "Transcript: \($0)" } ?? "Done"
        case .error(let message):
            return message
        }
    }

    private var brainstormDetailIsError: Bool {
        if case .error = store.brainstormStatus {
            return true
        }
        return false
    }
}

// MARK: - Timer label

struct TimerLabel: View {
    let startedAt: TimeInterval  // seconds since epoch
    @State private var elapsed: TimeInterval = 0
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        Text(formatted)
            .monospacedDigit()
            .font(.caption)
            .foregroundStyle(.secondary)
            .onReceive(timer) { _ in
                elapsed = max(0, Date().timeIntervalSince1970 - startedAt)
            }
    }

    private var formatted: String {
        let s = Int(elapsed)
        let m = s / 60
        let sec = s % 60
        return String(format: "%02d:%02d", m, sec)
    }
}
