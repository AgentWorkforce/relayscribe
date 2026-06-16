import Foundation
import Observation

enum RecorderMode: String, Codable, CaseIterable, Identifiable {
    case brainstorm
    case meeting

    var id: String { rawValue }

    var title: String {
        switch self {
        case .brainstorm: return "Brainstorm"
        case .meeting: return "Meeting"
        }
    }

    var symbolName: String {
        switch self {
        case .brainstorm: return "brain.head.profile"
        case .meeting: return "person.2"
        }
    }
}

struct AutomationSettingsSnapshot: Codable, Equatable {
    var createLinearIssues: Bool
    var createGithubIssues: Bool
    var dispatchEnabled: Bool

    enum CodingKeys: String, CodingKey {
        case createLinearIssues = "create_linear_issues"
        case createGithubIssues = "create_github_issues"
        case dispatchEnabled = "dispatch_enabled"
    }
}

struct RecorderSettingsSnapshot: Codable, Equatable {
    var mode: RecorderMode
    var automationSettings: AutomationSettingsSnapshot

    enum CodingKeys: String, CodingKey {
        case mode
        case automationSettings = "automation_settings"
    }

    static let defaults = RecorderSettingsSnapshot(
        mode: .brainstorm,
        automationSettings: AutomationSettingsSnapshot(
            createLinearIssues: false,
            createGithubIssues: false,
            dispatchEnabled: false
        )
    )

    static func currentFromDefaults(_ defaults: UserDefaults = .standard) -> RecorderSettingsSnapshot {
        let mode = RecorderMode(rawValue: defaults.string(forKey: RecorderSettingsKeys.mode) ?? "") ?? .brainstorm
        return RecorderSettingsSnapshot(
            mode: mode,
            automationSettings: AutomationSettingsSnapshot(
                createLinearIssues: defaults.bool(forKey: RecorderSettingsKeys.createLinearIssues),
                createGithubIssues: defaults.bool(forKey: RecorderSettingsKeys.createGithubIssues),
                dispatchEnabled: defaults.bool(forKey: RecorderSettingsKeys.dispatchEnabled)
            )
        )
    }
}

@Observable
@MainActor
final class RecorderSettings {
    var mode: RecorderMode {
        didSet { defaults.set(mode.rawValue, forKey: RecorderSettingsKeys.mode) }
    }
    var createLinearIssues: Bool {
        didSet { defaults.set(createLinearIssues, forKey: RecorderSettingsKeys.createLinearIssues) }
    }
    var createGithubIssues: Bool {
        didSet { defaults.set(createGithubIssues, forKey: RecorderSettingsKeys.createGithubIssues) }
    }
    var dispatchEnabled: Bool {
        didSet { defaults.set(dispatchEnabled, forKey: RecorderSettingsKeys.dispatchEnabled) }
    }

    /// Opt-in, Beta: when ON, the app's main surface becomes a fully malleable
    /// WebView UI authored from plain English. Default OFF → the normal native
    /// recorder UI. This is a local UI-mode flag and is NOT synced to the
    /// sidecar settings payload.
    var generativeUIEnabled: Bool {
        didSet { defaults.set(generativeUIEnabled, forKey: RecorderSettingsKeys.generativeUIEnabled) }
    }

    var snapshot: RecorderSettingsSnapshot {
        RecorderSettingsSnapshot(
            mode: mode,
            automationSettings: AutomationSettingsSnapshot(
                createLinearIssues: createLinearIssues,
                createGithubIssues: createGithubIssues,
                dispatchEnabled: dispatchEnabled
            )
        )
    }

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        let stored = RecorderSettingsSnapshot.currentFromDefaults(defaults)
        self.mode = stored.mode
        self.createLinearIssues = stored.automationSettings.createLinearIssues
        self.createGithubIssues = stored.automationSettings.createGithubIssues
        self.dispatchEnabled = stored.automationSettings.dispatchEnabled
        self.generativeUIEnabled = defaults.bool(forKey: RecorderSettingsKeys.generativeUIEnabled)
    }
}

enum RelayIntegrationProvider: String, CaseIterable, Identifiable {
    case slack
    case linear
    case github

    var id: String { rawValue }

    var title: String {
        switch self {
        case .slack: return "Slack"
        case .linear: return "Linear"
        case .github: return "GitHub"
        }
    }
}

enum RelayIntegrationState: Equatable {
    case idle
    case connecting
    case succeeded(String)
    case failed(String)

    var isConnecting: Bool {
        if case .connecting = self { return true }
        return false
    }
}

enum RecorderSettingsKeys {
    static let mode = "relayscribe.mode"
    static let createLinearIssues = "relayscribe.automation.createLinearIssues"
    static let createGithubIssues = "relayscribe.automation.createGithubIssues"
    static let dispatchEnabled = "relayscribe.automation.dispatchEnabled"
    static let generativeUIEnabled = "relayscribe.generativeUI.enabled"
}
