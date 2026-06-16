import SwiftUI

// Entry point is in Main/main.swift (RelayscribeApp.main())
// @main cannot be used in a library target
public struct RelayscribeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @State private var store = RecordingStore()
    @State private var sidecar = SidecarManager()
    @State private var settings = RecorderSettings()
    @State private var account = RelayAccount()

    public init() {}

    public var body: some Scene {
        MenuBarExtra {
            StatusView()
                .environment(store)
                .environment(sidecar)
                .environment(settings)
                .environment(account)
                .onChange(of: account.credential) {
                    sidecar.setWorkspaceCredential(account.workspaceCredential)
                }
                .onChange(of: account.credential?.workspaceId) {
                    sidecar.setRelayWorkspaceId(account.credential?.workspaceId)
                }
        } label: {
            // The label is always rendered (the menu-bar icon), so this runs at
            // launch — start the sidecar here, not on the lazy .window content.
            MenuBarLabel(status: store.effectiveMenuStatus(mode: settings.mode))
                .task(id: "startup", priority: .userInitiated) {
                    await startSidecar()
                }
                .task(id: "connectivity", priority: .userInitiated) {
                    // Load existing workspace integration statuses at launch. The
                    // lazy .window content's .task is unreliable, so run it here.
                    await account.refreshIntegrationStatusesIfSignedIn()
                }
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView()
                .environment(store)
                .environment(sidecar)
                .environment(settings)
                .environment(account)
                .frame(width: 420)
                .padding(20)
                .onChange(of: account.credential?.workspaceId) {
                    sidecar.setRelayWorkspaceId(account.credential?.workspaceId)
                }
        }

        Window("Generated UI", id: "generated-ui") {
            GenUIView()
                .environment(sidecar)
        }
    }

    private func startSidecar() async {
        sidecar.setWorkspaceCredential(account.workspaceCredential)
        sidecar.setRelayWorkspaceId(account.credential?.workspaceId)
        await sidecar.ensureRunning()
        if case .running = sidecar.state {
            store.onSidecarReady(settings: settings)
        }
    }
}

// MARK: - AppDelegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)  // tray-only, no dock icon
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Sidecar cleanup happens via SidecarManager deinit / .stop()
    }
}

// MARK: - Menu bar label

struct MenuBarLabel: View {
    let status: RecordingStatus

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: iconName)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(iconColor)
                .imageScale(.medium)
            if status == .recording {
                RecordingBlinkDot()
            }
        }
    }

    private var iconName: String {
        switch status {
        case .idle:            return "waveform"
        case .meetingDetected: return "waveform"
        case .recording:       return "record.circle.fill"
        case .uploading:       return "arrow.up.circle"
        case .error:           return "exclamationmark.circle"
        }
    }

    private var iconColor: Color {
        switch status {
        case .idle:            return .primary
        case .meetingDetected: return .orange
        case .recording:       return .red
        case .uploading:       return .blue
        case .error:           return .red
        }
    }
}

// Blinking red dot shown next to the menu bar icon during recording
struct RecordingBlinkDot: View {
    @State private var visible = true

    var body: some View {
        Circle()
            .fill(Color.red)
            .frame(width: 5, height: 5)
            .opacity(visible ? 1 : 0)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
                    visible = false
                }
            }
    }
}
