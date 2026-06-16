import SwiftUI

/// Shared "Relay Account" section used by both the menu-bar popover and the
/// Settings window. Shows the signed-in workspace + Sign Out, or a Sign In
/// button that kicks off the loopback browser-callback login.
@MainActor
struct RelayAccountView: View {
    @Environment(RelayAccount.self) var account

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Relay Account")
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)

            if account.isSignedIn {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.seal.fill")
                        .foregroundStyle(.green)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Signed in")
                            .font(.subheadline)
                        if let label = account.accountLabel {
                            Text(label)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button("Sign Out") { account.signOut() }
                        .buttonStyle(.bordered)
                }
            } else {
                HStack(spacing: 8) {
                    Text("Sign in to connect integrations.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Button(signInTitle) {
                        Task { await account.signIn() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(account.signInStatus.isSigningIn)
                }
            }

            if case .failed(let message) = account.signInStatus {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var signInTitle: String {
        account.signInStatus.isSigningIn ? "Signing in…" : "Sign in to Relay"
    }
}
