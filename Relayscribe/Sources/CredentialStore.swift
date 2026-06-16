import Foundation
import Security

/// Per-customer auth credential passed from the native app to the TS sidecar.
/// Replaces the baked-in shared DESKTOP_SHARED_TOKEN with a workspace-scoped token
/// so each customer authenticates independently.
struct WorkspaceCredential: Codable, Equatable {
    /// Relay access token (OAuth Bearer) or workspace-scoped API key.
    var accessToken: String
    /// Relay workspace identifier used for source attribution.
    var workspaceId: String
    /// Relay cloud API base URL (no trailing slash), e.g. https://agentrelay.com/cloud
    var apiURL: String?
}

/// Stores and retrieves the per-customer `WorkspaceCredential` in the macOS Keychain
/// so the token never lives in UserDefaults, env vars, or plain-text disk files.
enum CredentialStore {

    private static let service = "com.agentrelay.relayscribe"
    private static let account = "workspace-credential"

    /// Persists `credential` to the Keychain, replacing any existing entry.
    static func save(_ credential: WorkspaceCredential) throws {
        guard let data = try? JSONEncoder().encode(credential) else { return }

        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)

        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw CredentialStoreError.keychainError(status)
        }
    }

    /// Loads the stored credential, or `nil` if none has been saved yet.
    static func load() -> WorkspaceCredential? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(WorkspaceCredential.self, from: data)
    }

    /// Removes the stored credential (no-op when absent).
    static func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    enum CredentialStoreError: LocalizedError {
        case keychainError(OSStatus)

        var errorDescription: String? {
            switch self {
            case .keychainError(let status):
                return SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error (\(status))."
            }
        }
    }
}
