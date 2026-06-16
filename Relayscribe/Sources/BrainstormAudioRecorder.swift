import AVFoundation
import Foundation

enum BrainstormAudioRecorderError: LocalizedError {
    case microphoneDenied
    case couldNotStart
    case notRecording

    var errorDescription: String? {
        switch self {
        case .microphoneDenied:
            return "Microphone permission is required to record a brainstorm."
        case .couldNotStart:
            return "Could not start microphone recording."
        case .notRecording:
            return "No brainstorm recording is active."
        }
    }
}

@MainActor
final class BrainstormAudioRecorder: NSObject {
    private var recorder: AVAudioRecorder?
    private var currentFileURL: URL?

    func start() async throws -> URL {
        guard await requestMicrophoneAccess() else {
            throw BrainstormAudioRecorderError.microphoneDenied
        }

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("relayscribe-brainstorm-\(UUID().uuidString)")
            .appendingPathExtension("m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
        ]
        let recorder = try AVAudioRecorder(url: url, settings: settings)
        recorder.isMeteringEnabled = true
        recorder.prepareToRecord()
        guard recorder.record() else {
            throw BrainstormAudioRecorderError.couldNotStart
        }
        self.recorder = recorder
        self.currentFileURL = url
        return url
    }

    func stop() throws -> URL {
        guard let recorder, let currentFileURL else {
            throw BrainstormAudioRecorderError.notRecording
        }
        recorder.stop()
        self.recorder = nil
        self.currentFileURL = nil
        return currentFileURL
    }

    func cancel() {
        recorder?.stop()
        recorder?.deleteRecording()
        recorder = nil
        currentFileURL = nil
    }

    deinit {
        recorder?.stop()
    }

    private func requestMicrophoneAccess() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    continuation.resume(returning: granted)
                }
            }
        case .denied, .restricted:
            return false
        @unknown default:
            return false
        }
    }
}
