import SwiftUI
import AVFoundation
import Combine

struct VoiceRecorderView: View {
    var authService: AuthService
    @Environment(\.dismiss) private var dismiss

    @StateObject private var recorder = VoiceRecorder()
    @State private var note: String = ""
    @State private var isUploading = false
    @State private var uploadProgress: String?
    @State private var error: String?
    @State private var saveSuccess = false

    private let maxDuration: TimeInterval = 30 * 60       // 30 min hard cap
    private let warnDuration: TimeInterval = 25 * 60      // warn at 25 min

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                // Header
                HStack {
                    Text("Voice Note")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundColor(.white)
                    Spacer()
                    Button(action: { cancelAndDismiss() }) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 28))
                            .foregroundColor(.white.opacity(0.3))
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 12)

                Spacer()

                // Timer
                Text(formatDuration(recorder.elapsed))
                    .font(.system(size: 64, weight: .light, design: .rounded))
                    .foregroundColor(recorder.elapsed >= warnDuration ? Color(hex: "#E7FC44") : .white)
                    .monospacedDigit()

                if recorder.elapsed >= warnDuration && recorder.isRecording {
                    Text("Stops automatically at 30:00")
                        .font(.system(size: 12))
                        .foregroundColor(.white.opacity(0.4))
                        .padding(.top, 6)
                }

                // Waveform / level meter
                LevelMeter(level: recorder.level)
                    .frame(height: 60)
                    .padding(.horizontal, 40)
                    .padding(.top, 30)

                Spacer()

                // Record / stop button
                Button(action: toggleRecording) {
                    ZStack {
                        Circle()
                            .fill(recorder.isRecording ? Color.red : Color(hex: "#E7FC44"))
                            .frame(width: 96, height: 96)
                            .shadow(color: (recorder.isRecording ? Color.red : Color(hex: "#E7FC44")).opacity(0.4), radius: 16)

                        Image(systemName: recorder.isRecording ? "stop.fill" : "mic.fill")
                            .font(.system(size: 36, weight: .bold))
                            .foregroundColor(.black)
                    }
                }
                .disabled(isUploading)

                Text(recorder.isRecording ? "Tap to stop" : (recorder.hasRecording ? "Tap mic to re-record" : "Tap mic to start"))
                    .font(.system(size: 13))
                    .foregroundColor(.white.opacity(0.4))
                    .padding(.top, 16)

                Spacer()

                // Context input (only after a recording exists)
                if recorder.hasRecording && !recorder.isRecording {
                    TextField("Add context (optional)...", text: $note, axis: .vertical)
                        .font(.system(size: 15))
                        .foregroundColor(.white)
                        .lineLimit(1...3)
                        .padding(14)
                        .background(Color(hex: "#1a1a1a"))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12)
                                .stroke(Color.white.opacity(0.08), lineWidth: 1)
                        )
                        .padding(.horizontal, 20)
                        .padding(.bottom, 12)
                }

                if let error {
                    Text(error)
                        .font(.system(size: 13))
                        .foregroundColor(.red.opacity(0.9))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 20)
                        .padding(.bottom, 8)
                }

                // Save button
                Button(action: saveRecording) {
                    Group {
                        if isUploading {
                            VStack(spacing: 4) {
                                ProgressView()
                                    .progressViewStyle(CircularProgressViewStyle(tint: .white))
                                if let uploadProgress {
                                    Text(uploadProgress)
                                        .font(.system(size: 12))
                                        .foregroundColor(.white.opacity(0.5))
                                }
                            }
                        } else {
                            Text(recorder.hasRecording ? "Save & Transcribe" : "Record to save")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundColor(.black)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 54)
                    .background(isUploading ? Color(hex: "#1a1a1a") : Color(hex: "#E7FC44"))
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                }
                .disabled(!recorder.hasRecording || recorder.isRecording || isUploading)
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
            }

            // Success overlay
            if saveSuccess {
                VStack(spacing: 16) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 48))
                        .foregroundColor(Color(hex: "#E7FC44"))
                    Text("Saved — transcribing in background")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(.white)
                    Text("You can leave this screen anytime")
                        .font(.system(size: 13))
                        .foregroundColor(.white.opacity(0.5))
                }
                .padding(32)
                .background(Color(hex: "#111111").clipShape(RoundedRectangle(cornerRadius: 20)))
                .shadow(color: .black.opacity(0.5), radius: 20)
                .transition(.scale.combined(with: .opacity))
            }
        }
        .preferredColorScheme(.dark)
        .animation(.easeInOut(duration: 0.25), value: recorder.isRecording)
        .animation(.easeInOut(duration: 0.25), value: recorder.hasRecording)
        .animation(.easeInOut(duration: 0.3), value: isUploading)
        .animation(.easeInOut(duration: 0.3), value: saveSuccess)
        .onChange(of: recorder.elapsed) { _, newValue in
            if newValue >= maxDuration && recorder.isRecording {
                recorder.stop()
            }
        }
        .onDisappear {
            recorder.cleanup()
        }
    }

    // MARK: - Actions

    private func toggleRecording() {
        error = nil
        if recorder.isRecording {
            recorder.stop()
        } else {
            do {
                try recorder.start()
            } catch {
                self.error = "Couldn't start recording. Check microphone permission in Settings."
            }
        }
    }

    private func saveRecording() {
        guard let fileURL = recorder.fileURL else { return }
        isUploading = true
        error = nil

        // Hand-off model:
        //   1) Stage the audio into the app-group container (a few ms).
        //   2) Kick the drainer (it creates the memory + uploads in the bg).
        //   3) Show success + auto-dismiss inside 3s.
        //
        // The transcript fills in later via the backend transcription worker.
        // If the upload fails the file stays in the app-group folder and is
        // retried on the next drain — same durability as the share extension.

        let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
        let success = PendingVoiceStager.stage(
            audioAt: fileURL,
            note: trimmedNote,
            filename: fileURL.lastPathComponent,
            deleteSource: true
        ) != nil

        if !success {
            isUploading = false
            self.error = "Couldn't save voice note locally. Try again."
            return
        }

        // Refresh count so the Media tab can show an optimistic
        // placeholder card immediately, then kick the drainer.
        PendingVoiceDrainer.shared.refreshPendingCount()
        PendingVoiceDrainer.drain(authService: authService)

        isUploading = false
        saveSuccess = true
        UINotificationFeedbackGenerator().notificationOccurred(.success)

        Task {
            try? await Task.sleep(for: .seconds(1.5))
            await MainActor.run { dismiss() }
        }
    }

    private func cancelAndDismiss() {
        recorder.cleanup()
        dismiss()
    }

    private func formatDuration(_ seconds: TimeInterval) -> String {
        let s = Int(seconds)
        return String(format: "%02d:%02d", s / 60, s % 60)
    }

    private func shortDate() -> String {
        let f = DateFormatter()
        f.dateFormat = "MMM d, h:mm a"
        return f.string(from: Date())
    }
}

// MARK: - Recorder

@MainActor
final class VoiceRecorder: NSObject, ObservableObject, AVAudioRecorderDelegate {
    @Published var isRecording = false
    @Published var hasRecording = false
    @Published var elapsed: TimeInterval = 0
    @Published var level: Float = 0           // 0..1
    @Published var lastDuration: TimeInterval = 0

    private var recorder: AVAudioRecorder?
    private var meterTimer: Timer?
    private(set) var fileURL: URL?

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)

        let url = FileManager.default
            .temporaryDirectory
            .appendingPathComponent("purmemo-voice-\(UUID().uuidString).m4a")

        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 64_000,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]

        let r = try AVAudioRecorder(url: url, settings: settings)
        r.delegate = self
        r.isMeteringEnabled = true
        guard r.record() else { throw NSError(domain: "VoiceRecorder", code: -1) }

        recorder = r
        fileURL = url
        elapsed = 0
        level = 0
        isRecording = true
        hasRecording = false

        meterTimer?.invalidate()
        meterTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor [weak self] in self?.tick() }
            _ = self
        }
    }

    func stop() {
        recorder?.stop()
        meterTimer?.invalidate()
        meterTimer = nil

        lastDuration = elapsed
        isRecording = false
        hasRecording = (fileURL != nil) && elapsed > 0.5

        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    func cleanup() {
        meterTimer?.invalidate()
        meterTimer = nil
        recorder?.stop()
        recorder = nil
        if let url = fileURL {
            try? FileManager.default.removeItem(at: url)
        }
        fileURL = nil
        isRecording = false
        hasRecording = false
        elapsed = 0
        level = 0
    }

    private func tick() {
        guard let r = recorder, r.isRecording else { return }
        r.updateMeters()
        elapsed = r.currentTime
        // -160 dB (silence) to 0 dB (peak) → normalize to 0..1
        let dB = r.averagePower(forChannel: 0)
        let normalized = max(0, min(1, (dB + 60) / 60))
        level = normalized
    }

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor in
            self.isRecording = false
            self.hasRecording = flag && self.elapsed > 0.5
        }
    }
}

// MARK: - Level meter

private struct LevelMeter: View {
    var level: Float

    var body: some View {
        GeometryReader { geo in
            let barCount = 24
            let spacing: CGFloat = 4
            let barWidth = (geo.size.width - spacing * CGFloat(barCount - 1)) / CGFloat(barCount)
            HStack(spacing: spacing) {
                ForEach(0..<barCount, id: \.self) { i in
                    let centerDist = abs(Double(i) - Double(barCount - 1) / 2.0) / (Double(barCount) / 2.0)
                    let mask = 1.0 - centerDist * 0.5
                    let h = max(4, CGFloat(level) * geo.size.height * CGFloat(mask))
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(hex: "#E7FC44").opacity(0.3 + Double(level) * 0.7))
                        .frame(width: barWidth, height: h)
                        .frame(maxHeight: .infinity, alignment: .center)
                }
            }
            .animation(.linear(duration: 0.1), value: level)
        }
    }
}
