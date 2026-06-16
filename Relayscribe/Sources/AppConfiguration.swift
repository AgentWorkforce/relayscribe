import Foundation

enum AppConfiguration {
    /// Port the TS sidecar listens on. Must match sidecar SIDECAR_PORT env var.
    static var sidecarPort: Int = {
        if let v = ProcessInfo.processInfo.environment["SIDECAR_PORT"], let n = Int(v) { return n }
        return 3700
    }()

    static func useSidecarPort(_ port: Int) {
        sidecarPort = port
    }

    static var sidecarBaseURL: URL {
        URL(string: "http://127.0.0.1:\(sidecarPort)")!
    }

    /// Base URL of the Relay/cloud web app that hosts `/api/v1/cli/login` and the
    /// workspace integration endpoints. Override with `RELAY_CLOUD_URL` for
    /// staging/dev; defaults to production. After sign-in the app uses the
    /// `api_url` the login callback returns, so this only seeds the login start.
    static var relayCloudBaseURL: URL = {
        if let raw = ProcessInfo.processInfo.environment["RELAY_CLOUD_URL"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           let url = URL(string: raw), url.scheme == "https" || url.scheme == "http" {
            return url
        }
        return URL(string: "https://agentrelay.com/cloud")!
    }()

    /// How long to wait for the sidecar health check before giving up.
    static let sidecarStartupTimeout: TimeInterval = 15

    /// How often to poll /state when SSE is not available.
    static let statePollInterval: TimeInterval = 1.5
}
