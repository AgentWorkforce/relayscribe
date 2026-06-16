import SwiftUI

@MainActor
struct SettingsView: View {
    @Environment(RecorderSettings.self) var settings
    @Environment(RecordingStore.self) var store
    @Environment(RelayAccount.self) var account

    var body: some View {
        @Bindable var settings = settings

        VStack(alignment: .leading, spacing: 18) {
            Text(Brand.productName)
                .font(.title3)
                .fontWeight(.semibold)

            modeSection(settings: $settings)

            Divider()

            automationSection(settings: $settings)

            Divider()

            RelayAccountView()

            Divider()

            integrationsSection

            Divider()

            generativeUISection(settings: $settings)
        }
        .onChange(of: self.settings.snapshot) {
            store.syncSettings(self.settings.snapshot)
            if self.settings.mode == .meeting {
                store.resetBrainstormStatus()
            }
        }
        .task {
            await account.refreshIntegrationStatusesIfSignedIn()
        }
        .onChange(of: self.settings.generativeUIEnabled) {
            store.syncGenerativeUI(self.settings.generativeUIEnabled)
        }
    }

    private func generativeUISection(settings: Bindable<RecorderSettings>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text("Generative UI")
                    .font(.headline)
                Text("BETA")
                    .font(.caption2)
                    .fontWeight(.bold)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color.accentColor.opacity(0.18))
                    .foregroundStyle(Color.accentColor)
                    .clipShape(Capsule())
            }
            Toggle("Generative UI (Beta)", isOn: settings.generativeUIEnabled)
            Text("Author the entire app interface in plain English — regeneratable anytime. "
                 + "When off, the normal native recorder UI is used. Opt-in & experimental.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func modeSection(settings: Bindable<RecorderSettings>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Mode")
                .font(.headline)
            Picker("Mode", selection: settings.mode) {
                ForEach(RecorderMode.allCases) { mode in
                    Label(mode.title, systemImage: mode.symbolName).tag(mode)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    private func automationSection(settings: Bindable<RecorderSettings>) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Automation")
                .font(.headline)
            Toggle("Auto-create Linear issues", isOn: settings.createLinearIssues)
            Toggle("Auto-create GitHub issues", isOn: settings.createGithubIssues)
            Toggle("Auto-dispatch PRs", isOn: settings.dispatchEnabled)
        }
    }

    private var integrationsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Connect")
                .font(.headline)
            VStack(spacing: 8) {
                ForEach(RelayIntegrationProvider.allCases) { provider in
                    IntegrationConnectRow(provider: provider)
                }
            }
        }
    }
}

@MainActor
struct IntegrationConnectRow: View {
    let provider: RelayIntegrationProvider
    @Environment(RelayAccount.self) var account

    var body: some View {
        HStack(spacing: 6) {
            Text(provider.title)
            if isConnected {
                Label("Connected", systemImage: "checkmark.circle.fill")
                    .labelStyle(.titleAndIcon)
                    .font(.caption)
                    .foregroundStyle(.green)
            }
            Spacer()
            Button(buttonTitle) {
                Task { await account.connect(provider) }
            }
            .disabled(!account.isSignedIn || account.integrationState(for: provider).isConnecting)
            .buttonStyle(.bordered)
        }
        if let message = statusMessage {
            Text(message)
                .font(.caption)
                .foregroundStyle(statusColor)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var isConnected: Bool {
        account.connectionStatus(for: provider) == .connected
    }

    private var buttonTitle: String {
        if account.integrationState(for: provider).isConnecting { return "Connecting..." }
        if isConnected { return "Reconnect" }
        return "Connect \(provider.title)"
    }

    private var statusMessage: String? {
        switch account.integrationState(for: provider) {
        case .idle, .connecting:
            return nil
        case .succeeded(let message), .failed(let message):
            return message
        }
    }

    private var statusColor: Color {
        if case .failed = account.integrationState(for: provider) {
            return .red
        }
        return .secondary
    }
}
