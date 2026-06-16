import AppKit
import Foundation
import Observation

/// Owns the customer's Relay/cloud login and drives integration connects.
///
/// Sign-in replicates `relayfile login` (loopback browser callback against the
/// existing `GET /api/v1/cli/login` endpoint) and stores the resulting cli:auth
/// token bundle in the macOS Keychain — the token never touches UserDefaults,
/// env, disk, or the TS sidecar. Connecting an integration calls the canonical
/// `POST /api/v1/workspaces/{workspaceId}/integrations/connect-session` with the
/// stored token and opens the returned connect link in the browser.
@Observable
@MainActor
final class RelayAccount {

    /// Persisted credential bundle. Mirrors what the cli-login callback and the
    /// token-refresh endpoint return, plus the resolved workspace.
    struct Credential: Codable, Equatable {
        var accessToken: String
        var refreshToken: String
        var accessTokenExpiresAt: Date
        var refreshTokenExpiresAt: Date?
        /// Normalized cloud API base (no trailing slash), e.g. https://agentrelay.com/cloud
        var apiURL: String
        var workspaceId: String
        var workspaceName: String?
    }

    /// Whether a provider already has a usable connection in the workspace.
    enum ProviderConnectivity: Equatable {
        case unknown
        case connected
        case notConnected
    }

    enum SignInStatus: Equatable {
        case idle
        case signingIn
        case failed(String)

        var isSigningIn: Bool {
            if case .signingIn = self { return true }
            return false
        }
    }

    private(set) var credential: Credential?
    var signInStatus: SignInStatus = .idle
    /// Transient result of a user-initiated connect action (per provider).
    var integrationStates: [RelayIntegrationProvider: RelayIntegrationState] = [:]
    /// Existing connection status read from the workspace (per provider).
    var connectionStatuses: [RelayIntegrationProvider: ProviderConnectivity] = [:]
    var isRefreshingConnectivity = false

    private static let keychainAccount = "relay-auth"

    var isSignedIn: Bool { credential != nil }

    /// Human-friendly label for the signed-in account (workspace name or id).
    var accountLabel: String? {
        guard let credential else { return nil }
        return credential.workspaceName ?? credential.workspaceId
    }

    init() {
        load()
    }

    // MARK: - Persistence

    private func load() {
        guard let data = KeychainStore.get(account: Self.keychainAccount) else { return }
        credential = try? Self.decoder.decode(Credential.self, from: data)
    }

    private func persist() {
        guard let credential else {
            KeychainStore.delete(account: Self.keychainAccount)
            return
        }
        guard let data = try? Self.encoder.encode(credential) else { return }
        try? KeychainStore.set(data, account: Self.keychainAccount)
    }

    // MARK: - Sign in / out

    func signIn() async {
        guard !signInStatus.isSigningIn else { return }
        signInStatus = .signingIn
        do {
            let credential = try await performSignIn()
            self.credential = credential
            persist()
            signInStatus = .idle
            await refreshIntegrationStatuses()
        } catch {
            signInStatus = .failed(error.relayMessage)
        }
    }

    func signOut() {
        credential = nil
        KeychainStore.delete(account: Self.keychainAccount)
        integrationStates = [:]
        connectionStatuses = [:]
        signInStatus = .idle
    }

    private func performSignIn() async throws -> Credential {
        let server = try RelayLoopbackServer()
        defer { server.stop() }

        let port = try await server.start()
        let state = UUID().uuidString
        let callback = "http://127.0.0.1:\(port)/callback"

        guard
            var login = URLComponents(
                url: AppConfiguration.relayCloudBaseURL.appendingPathComponent("api/v1/cli/login"),
                resolvingAgainstBaseURL: false
            )
        else {
            throw RelayAuthError.message("Could not build the Relay sign-in URL.")
        }
        login.queryItems = [
            URLQueryItem(name: "redirect_uri", value: callback),
            URLQueryItem(name: "state", value: state),
        ]
        guard let loginURL = login.url else {
            throw RelayAuthError.message("Could not build the Relay sign-in URL.")
        }
        NSWorkspace.shared.open(loginURL)

        let params = try await server.waitForCallback()
        if let error = params["error"], !error.isEmpty {
            throw RelayAuthError.message("Relay sign-in failed: \(error)")
        }
        guard params["state"] == state else {
            throw RelayAuthError.message("Relay sign-in failed: state mismatch.")
        }
        guard
            let accessToken = params["access_token"], !accessToken.isEmpty,
            let refreshToken = params["refresh_token"], !refreshToken.isEmpty
        else {
            throw RelayAuthError.message("Relay sign-in did not return a token.")
        }

        let apiURL = Self.normalizedAPIURL(params["api_url"])
            ?? AppConfiguration.relayCloudBaseURL.absoluteString
        let expiresAt = Self.parseDate(params["access_token_expires_at"])
            ?? Date().addingTimeInterval(60 * 60 * 24)
        let refreshExpiresAt = Self.parseDate(params["refresh_token_expires_at"])

        // Resolve the active workspace so connect-session targets the right one.
        let workspace = try await fetchPrimaryWorkspace(apiURL: apiURL, accessToken: accessToken)

        return Credential(
            accessToken: accessToken,
            refreshToken: refreshToken,
            accessTokenExpiresAt: expiresAt,
            refreshTokenExpiresAt: refreshExpiresAt,
            apiURL: apiURL,
            workspaceId: workspace.id,
            workspaceName: workspace.name
        )
    }

    // MARK: - Integration connect

    func integrationState(for provider: RelayIntegrationProvider) -> RelayIntegrationState {
        integrationStates[provider] ?? .idle
    }

    func connect(_ provider: RelayIntegrationProvider) async {
        if integrationState(for: provider).isConnecting { return }
        guard isSignedIn else {
            integrationStates[provider] = .failed("Sign in to Relay first.")
            return
        }
        integrationStates[provider] = .connecting
        do {
            let credential = try await validCredential()
            let link = try await createConnectLink(provider: provider, credential: credential)
            NSWorkspace.shared.open(link)
            integrationStates[provider] = .succeeded("Opened \(provider.title) authorization in your browser.")
        } catch {
            integrationStates[provider] = .failed(error.relayMessage)
        }
    }

    // MARK: - Existing connection status (read)

    func connectionStatus(for provider: RelayIntegrationProvider) -> ProviderConnectivity {
        connectionStatuses[provider] ?? .unknown
    }

    /// Refreshes connection status only when signed in (safe to call on view appear).
    func refreshIntegrationStatusesIfSignedIn() async {
        guard isSignedIn else { return }
        await refreshIntegrationStatuses()
    }

    /// Reads the workspace's existing integrations and marks each row connected
    /// vs not. Uses the canonical READ endpoint — never connect-session, which
    /// is a write that pre-creates pending rows.
    func refreshIntegrationStatuses() async {
        guard isSignedIn else { return }
        isRefreshingConnectivity = true
        defer { isRefreshingConnectivity = false }
        do {
            let credential = try await validCredential()
            let entries = try await fetchIntegrationList(credential: credential)
            var next: [RelayIntegrationProvider: ProviderConnectivity] = [:]
            for provider in RelayIntegrationProvider.allCases {
                next[provider] = Self.connectivity(for: provider, in: entries)
            }
            connectionStatuses = next
        } catch {
            // Keep any prior status; a transient read failure shouldn't blank the UI.
        }
    }

    private func fetchIntegrationList(credential: Credential) async throws -> [IntegrationListEntry] {
        let workspaceSegment = credential.workspaceId
            .addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? credential.workspaceId
        guard let url = URL(string: "\(credential.apiURL)/api/v1/workspaces/\(workspaceSegment)/integrations") else {
            throw RelayAuthError.message("Invalid integrations URL.")
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            throw RelayAuthError.message("Could not load integration status (status \(status)).")
        }
        return try JSONDecoder().decode([IntegrationListEntry].self, from: data)
    }

    /// A provider is "connected" when an integration row exists whose readiness
    /// state means OAuth completed. `pending` (pre-created, awaiting OAuth) and
    /// `error` are treated as not-connected so the row still offers Connect.
    private static let connectedStates: Set<String> = ["ready", "syncing", "cataloging", "degraded"]

    private static func connectivity(
        for provider: RelayIntegrationProvider,
        in entries: [IntegrationListEntry]
    ) -> ProviderConnectivity {
        let configKey = "\(provider.rawValue)-relay"
        let matches = entries.filter { entry in
            let name = entry.provider.lowercased()
            return name == provider.rawValue
                || name.hasPrefix("\(provider.rawValue)-")
                || entry.providerConfigKey?.lowercased() == configKey
        }
        if matches.isEmpty { return .notConnected }
        return matches.contains { connectedStates.contains($0.status.lowercased()) }
            ? .connected
            : .notConnected
    }

    // MARK: - Token validity

    /// Returns a credential whose access token is valid, refreshing if it is
    /// within two minutes of expiry. Signs out if the refresh is rejected.
    private func validCredential() async throws -> Credential {
        guard let current = credential else {
            throw RelayAuthError.message("Not signed in.")
        }
        if current.accessTokenExpiresAt.timeIntervalSinceNow > 120 {
            return current
        }

        let refreshed: RefreshedTokens
        do {
            refreshed = try await refresh(current)
        } catch {
            signOut()
            throw RelayAuthError.message("Your Relay session expired. Please sign in again.")
        }

        var updated = current
        updated.accessToken = refreshed.accessToken
        updated.refreshToken = refreshed.refreshToken
        updated.accessTokenExpiresAt = refreshed.accessTokenExpiresAt
        updated.refreshTokenExpiresAt = refreshed.refreshTokenExpiresAt
        if let apiURL = refreshed.apiURL { updated.apiURL = apiURL }
        credential = updated
        persist()
        return updated
    }

    // MARK: - Networking

    private func fetchPrimaryWorkspace(apiURL: String, accessToken: String) async throws -> WorkspacesResponse.Workspace {
        guard let url = URL(string: "\(apiURL)/api/v1/workspaces") else {
            throw RelayAuthError.message("Invalid Relay workspaces URL.")
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 30
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            throw RelayAuthError.message("Could not load your Relay workspace (status \(status)).")
        }
        let decoded = try JSONDecoder().decode(WorkspacesResponse.self, from: data)
        guard let workspace = decoded.workspaces.first else {
            throw RelayAuthError.message("No Relay workspace is available for this account.")
        }
        return workspace
    }

    private func createConnectLink(provider: RelayIntegrationProvider, credential: Credential) async throws -> URL {
        let workspaceSegment = credential.workspaceId
            .addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? credential.workspaceId
        guard
            let url = URL(string: "\(credential.apiURL)/api/v1/workspaces/\(workspaceSegment)/integrations/connect-session")
        else {
            throw RelayAuthError.message("Invalid connect URL.")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("Bearer \(credential.accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "allowedIntegrations": ["\(provider.rawValue)-relay"],
            "requestedBackend": "nango",
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            if status == 401 || status == 403 {
                throw RelayAuthError.message("Relay rejected the request — your session may have expired. Sign in again.")
            }
            throw RelayAuthError.message(Self.connectErrorMessage(data: data, status: status))
        }
        let decoded = try JSONDecoder().decode(ConnectSessionResponse.self, from: data)
        guard let link = decoded.browserURL else {
            throw RelayAuthError.message("Relay did not return a connect link.")
        }
        return link
    }

    private struct RefreshedTokens {
        var accessToken: String
        var refreshToken: String
        var accessTokenExpiresAt: Date
        var refreshTokenExpiresAt: Date?
        var apiURL: String?
    }

    private func refresh(_ credential: Credential) async throws -> RefreshedTokens {
        guard let url = URL(string: "\(credential.apiURL)/api/v1/auth/token/refresh") else {
            throw RelayAuthError.message("Invalid refresh URL.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["refreshToken": credential.refreshToken])

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            throw RelayAuthError.message("Token refresh failed (status \(status)).")
        }
        let decoded = try JSONDecoder().decode(RefreshResponse.self, from: data)
        return RefreshedTokens(
            accessToken: decoded.accessToken,
            refreshToken: decoded.refreshToken,
            accessTokenExpiresAt: Self.parseDate(decoded.accessTokenExpiresAt)
                ?? Date().addingTimeInterval(60 * 60 * 24),
            refreshTokenExpiresAt: Self.parseDate(decoded.refreshTokenExpiresAt),
            apiURL: Self.normalizedAPIURL(decoded.apiUrl)
        )
    }

    // MARK: - Helpers

    private static func connectErrorMessage(data: Data, status: Int) -> String {
        if let decoded = try? JSONDecoder().decode(ErrorResponse.self, from: data) {
            if let message = decoded.message, !message.isEmpty { return message }
            if let error = decoded.error, !error.isEmpty { return error }
        }
        return "Connect failed (status \(status))."
    }

    private static func normalizedAPIURL(_ raw: String?) -> String? {
        guard var value = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        while value.hasSuffix("/") { value.removeLast() }
        guard let url = URL(string: value), let scheme = url.scheme,
              scheme == "https" || scheme == "http" else {
            return nil
        }
        return value
    }

    private static func parseDate(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        return isoFractional.date(from: raw) ?? iso.date(from: raw)
    }

    private static let isoFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}

// MARK: - Wire formats

private struct WorkspacesResponse: Decodable {
    struct Workspace: Decodable {
        var id: String
        var name: String?
        var slug: String?
    }
    var workspaces: [Workspace]
}

private struct IntegrationListEntry: Decodable {
    var provider: String
    var providerConfigKey: String?
    var status: String
}

private struct RefreshResponse: Decodable {
    var accessToken: String
    var accessTokenExpiresAt: String
    var refreshToken: String
    var refreshTokenExpiresAt: String?
    var apiUrl: String?
}

private struct ErrorResponse: Decodable {
    var error: String?
    var message: String?
}

/// Response of the canonical connect-session endpoint. It returns `connectLink`;
/// the other keys are accepted defensively to match the recorder's existing
/// browser-open contract.
private struct ConnectSessionResponse: Decodable {
    var connectLink: String?
    var authUrl: String?
    var connectUrl: String?
    var url: String?

    var browserURL: URL? {
        [connectLink, authUrl, connectUrl, url]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .compactMap(URL.init(string:))
            .first { $0.scheme == "https" || $0.scheme == "http" }
    }
}

enum RelayAuthError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let message): return message
        }
    }
}

private extension Error {
    /// User-facing message, preferring our own descriptions over opaque
    /// URLSession/NSError text.
    var relayMessage: String {
        if let relay = self as? RelayAuthError { return relay.errorDescription ?? "Relay error." }
        return localizedDescription
    }
}
