import Foundation
import Security

/// Thin wrapper over the macOS Keychain for a single generic-password item.
/// Used to store the customer's Relay/cloud login credential (the cli:auth
/// token bundle) so it never lives in UserDefaults, env, or on disk in plain
/// text. The recorder app is not sandboxed, so a generic-password item without
/// a keychain-access-group is sufficient.
enum KeychainStore {
    /// Shared service identifier for every Relayscribe keychain item.
    static let service = "com.agentrelay.relayscribe"

    enum KeychainError: LocalizedError {
        case unexpectedStatus(OSStatus)

        var errorDescription: String? {
            switch self {
            case .unexpectedStatus(let status):
                let message = SecCopyErrorMessageString(status, nil) as String?
                return message ?? "Keychain error (\(status))."
            }
        }
    }

    /// Stores `data` under `account`, replacing any existing value.
    static func set(_ data: Data, account: String) throws {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        // Delete any prior item so the add never collides with errSecDuplicateItem.
        SecItemDelete(base as CFDictionary)

        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    /// Returns the stored value for `account`, or nil when absent.
    static func get(account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else { return nil }
        return item as? Data
    }

    /// Removes the stored value for `account` (no-op when absent).
    static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
